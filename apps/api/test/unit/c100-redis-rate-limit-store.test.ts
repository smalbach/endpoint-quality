/**
 * Los contadores de límites en Redis, contra un Redis de mentira en el mismo proceso
 * (test/support/c100-redis-fakes.ts): el contrato de test/unit/rate-limit-store.test.ts —que contra
 * Redis de verdad solo corre con `EQ_TEST_REDIS_URL`— y lo que solo tiene este adaptador: caer a la
 * memoria sin tumbar la petición, avisar una vez, y volver a Redis cuando Redis vuelve.
 */
// Primero el falso: el adaptador pide `ioredis` al cargarse.
import { fakeRedisServer, type FakeRedisServer } from "@test/support/c100-redis-fakes";

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { RedisRateLimitStore } from "@/shared/rate-limit/redis-rate-limit-store";

let warnings: string[] = [];
let infos: string[] = [];
const opened: RedisRateLimitStore[] = [];

beforeEach(() => {
  warnings = [];
  infos = [];
  mock.method(Logger.prototype, "warn", (message: string) => void warnings.push(message));
  mock.method(Logger.prototype, "log", (message: string) => void infos.push(message));
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.close()));
  mock.restoreAll();
});

function world(): { url: string; server: FakeRedisServer } {
  const url = `redis://fake-${randomUUID()}:6379`;
  return { url, server: fakeRedisServer(url) };
}

function open(url: string, prefix?: string, now?: () => number): RedisRateLimitStore {
  const store = new RedisRateLimitStore(url, prefix, now);
  opened.push(store);
  return store;
}

async function connected(...stores: RedisRateLimitStore[]): Promise<void> {
  const until = Date.now() + 2_000;
  while (!stores.every((store) => store.shared)) {
    if (Date.now() > until) assert.fail("Redis (falso) no conectó a tiempo");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("contadores de límites: Redis (falso), el contrato", () => {
  async function pair() {
    const { url } = world();
    const prefix = `eq:test:rl:${randomUUID()}`;
    const a = open(url, prefix);
    const b = open(url, prefix);
    await connected(a, b);
    return { a, b };
  }

  test("los golpes de dos instancias suman en la misma ventana", async () => {
    const { a, b } = await pair();
    const key = `ip-${randomUUID()}`;
    assert.equal((await a.hit(key, 60_000)).hits, 1);
    assert.equal((await b.hit(key, 60_000)).hits, 2);
    const third = await a.hit(key, 60_000);
    assert.equal(third.hits, 3);
    assert.ok(third.resetInMs > 0 && third.resetInMs <= 60_000, `resetInMs: ${third.resetInMs}`);
    assert.equal((await b.peek(key))?.hits, 3);
  });

  test("mirar no suma, y sin ventana abierta es null", async () => {
    const { a } = await pair();
    const key = `ip-${randomUUID()}`;
    assert.equal(await a.peek(key), null);
    await a.hit(key, 60_000);
    await a.peek(key);
    const seen = await a.peek(key);
    assert.equal(seen?.hits, 1);
    assert.ok(seen!.resetInMs > 0 && seen!.resetInMs <= 60_000);
  });

  test("la ventana empieza con el primer golpe y no se alarga con los siguientes", async () => {
    const { a, b } = await pair();
    const key = `ip-${randomUUID()}`;
    await a.hit(key, 300);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const later = await b.hit(key, 300);
    assert.ok(later.resetInMs <= 200, `el segundo golpe reabrió la ventana: ${later.resetInMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await a.peek(key), null);
    assert.equal((await b.hit(key, 300)).hits, 1, "pasada la ventana, se empieza de cero");
  });

  test("claves distintas no se mezclan", async () => {
    const { a, b } = await pair();
    const one = `ip-${randomUUID()}`;
    const other = `ip-${randomUUID()}`;
    await a.hit(one, 60_000);
    await a.hit(one, 60_000);
    assert.equal((await b.hit(other, 60_000)).hits, 1);
  });

  test("golpes a la vez desde las dos no se pierden", async () => {
    const { a, b } = await pair();
    const key = `ip-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? a : b).hit(key, 60_000)));
    assert.deepEqual(
      results.map((result) => result.hits).sort((x, y) => x - y),
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
  });
});

describe("contadores de límites: Redis (falso), lo que solo tiene Redis", () => {
  test("cuenta bajo el prefijo eq:rl por defecto, y con uno propio si se da", async () => {
    const { url, server } = world();
    const byDefault = open(url);
    const custom = open(url, "mío");
    await connected(byDefault, custom);
    await byDefault.hit("1.2.3.4", 60_000);
    await custom.hit("1.2.3.4", 60_000);
    assert.equal(server.get("eq:rl:1.2.3.4"), "1");
    assert.equal(server.get("mío:1.2.3.4"), "1");
  });

  test("el cliente no encola sin conexión, no espera más de 500 ms y reintenta hasta cada 10 s", async () => {
    const { url, server } = world();
    open(url);
    const [client] = [...server.clients];
    assert.equal(client.options.enableOfflineQueue, false);
    assert.equal(client.options.maxRetriesPerRequest, 1);
    assert.equal(client.options.commandTimeout, 500);
    const retry = client.options.retryStrategy!;
    assert.deepEqual([retry(1), retry(3), retry(20), retry(500)], [500, 1_500, 10_000, 10_000]);
  });

  test("antes de conectar cuenta en memoria, con el reloj que se le da", async () => {
    const { url, server } = world();
    let now = 1_000;
    const store = open(url, undefined, () => now);
    assert.equal(store.shared, false);
    assert.deepEqual(await store.hit("k", 10_000), { hits: 1, resetInMs: 10_000 });
    now += 4_000;
    assert.deepEqual(await store.hit("k", 10_000), { hits: 2, resetInMs: 6_000 });
    assert.deepEqual(await store.peek("k"), { hits: 2, resetInMs: 6_000 });
    assert.equal(await store.peek("otra"), null);
    assert.equal(server.data.size, 0, "nada llegó a Redis");
  });

  test("Redis caído: sigue contando en memoria, avisa una vez, y al volver cuenta otra vez en Redis", async () => {
    const { url, server } = world();
    const store = open(url);
    await connected(store);
    assert.equal((await store.hit("k", 60_000)).hits, 1);

    server.stop();
    server.stop(new Error("otra vez"));
    assert.equal(store.shared, false);
    assert.deepEqual(warnings, [
      "Sin Redis para los límites de peticiones: connect ECONNREFUSED 127.0.0.1:6379. Cada instancia cuenta en su memoria hasta que vuelva",
    ]);
    // La memoria empieza de cero: lo contado en Redis no se ve desde aquí.
    assert.equal((await store.hit("k", 60_000)).hits, 1);
    assert.equal((await store.peek("k"))?.hits, 1);

    server.start();
    assert.equal(store.shared, true);
    assert.deepEqual(infos, ["Límites de peticiones compartidos otra vez en Redis"]);
    // De vuelta en Redis, donde seguía la cuenta de antes.
    assert.equal((await store.hit("k", 60_000)).hits, 2);
    assert.equal((await store.peek("k"))?.hits, 2);
    assert.equal(infos.length, 1, "no se anuncia la vuelta en cada golpe");
  });

  test("una orden que vence con la conexión en pie cae a memoria, y la siguiente que sale lo recupera", async () => {
    const { url, server } = world();
    const store = open(url);
    await connected(store);
    await store.hit("k", 60_000);

    server.failEval = new Error("Command timed out");
    assert.equal((await store.hit("k", 60_000)).hits, 1, "cuenta en memoria");
    assert.equal((await store.peek("k"))?.hits, 1, "mira en memoria");
    assert.equal(await store.peek("nueva"), null);
    assert.deepEqual(warnings, [
      "Sin Redis para los límites de peticiones: Command timed out. Cada instancia cuenta en su memoria hasta que vuelva",
    ]);

    server.failEval = null;
    assert.equal((await store.peek("k"))?.hits, 1, "Redis otra vez: su cuenta");
    assert.deepEqual(infos, ["Límites de peticiones compartidos otra vez en Redis"]);

    server.failEval = new Error("Command timed out");
    await store.peek("k");
    server.failEval = null;
    assert.equal((await store.hit("k", 60_000)).hits, 2, "un golpe que sale también lo recupera");
    assert.equal(infos.length, 2);
  });

  test("un fallo que no es un Error se cuenta en texto", async () => {
    const { url, server } = world();
    const store = open(url);
    await connected(store);
    server.failEval = "NOSCRIPT";
    assert.equal((await store.hit("k", 60_000)).hits, 1);
    assert.deepEqual(warnings, [
      "Sin Redis para los límites de peticiones: NOSCRIPT. Cada instancia cuenta en su memoria hasta que vuelva",
    ]);
  });

  test("cerrar suelta la conexión, aunque quit falle", async () => {
    const { url, server } = world();
    const store = new RedisRateLimitStore(url);
    await connected(store);
    server.failQuit = new Error("ya cerrado");
    await store.onModuleDestroy();
    assert.equal(server.clients.size, 0);
    assert.equal(store.shared, false);
  });
});
