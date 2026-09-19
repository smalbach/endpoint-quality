/**
 * El contrato de los contadores de límites de peticiones, el mismo para los dos adaptadores.
 *
 * El de memoria corre siempre. El de Redis, solo con `EQ_TEST_REDIS_URL`, y se salta diciéndolo —como
 * el bus—:
 *
 *     docker compose -f docker/compose.yml --profile redis up -d redis
 *     EQ_TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @eq/api test:unit
 *
 * «Dos instancias» son aquí dos objetos sobre el mismo almacén: en memoria, el mismo `Map` —como dos
 * aplicaciones de prueba que se lo pasan—; en Redis, dos conexiones con el mismo prefijo.
 */
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryRateLimitStore, type RateLimitStorePort } from "@/shared/rate-limit/rate-limit-store";
import { RedisRateLimitStore } from "@/shared/rate-limit/redis-rate-limit-store";
import { SharedThrottlerStorage } from "@/shared/rate-limit/shared-throttler-storage";
import { AuthFailureLimiter } from "@/modules/captures/infrastructure/auth-failure-limiter";

const REDIS_URL = process.env.EQ_TEST_REDIS_URL;
const REASON = "sin EQ_TEST_REDIS_URL: levanta Redis (perfil redis del compose) y reexporta la variable";

type Pair = { a: RateLimitStorePort; b: RateLimitStorePort; ready(): Promise<void> };

function contract(name: string, pair: () => Pair, options: { skip: string | false }) {
  describe(`contadores de límites: ${name}`, { skip: options.skip }, () => {
    test("los golpes de dos instancias suman en la misma ventana", async () => {
      const { a, b, ready } = pair();
      await ready();
      const key = `ip-${randomUUID()}`;
      assert.equal((await a.hit(key, 60_000)).hits, 1);
      assert.equal((await b.hit(key, 60_000)).hits, 2);
      const third = await a.hit(key, 60_000);
      assert.equal(third.hits, 3);
      assert.ok(third.resetInMs > 0 && third.resetInMs <= 60_000, `resetInMs: ${third.resetInMs}`);
      assert.equal((await b.peek(key))?.hits, 3);
    });

    test("mirar no suma, y sin ventana abierta es null", async () => {
      const { a, ready } = pair();
      await ready();
      const key = `ip-${randomUUID()}`;
      assert.equal(await a.peek(key), null);
      await a.hit(key, 60_000);
      await a.peek(key);
      assert.equal((await a.peek(key))?.hits, 1);
    });

    test("la ventana empieza con el primer golpe y no se alarga con los siguientes", async () => {
      const { a, b, ready } = pair();
      await ready();
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
      const { a, b, ready } = pair();
      await ready();
      const one = `ip-${randomUUID()}`;
      const other = `ip-${randomUUID()}`;
      await a.hit(one, 60_000);
      await a.hit(one, 60_000);
      assert.equal((await b.hit(other, 60_000)).hits, 1);
    });

    test("golpes a la vez desde las dos no se pierden", async () => {
      const { a, b, ready } = pair();
      await ready();
      const key = `ip-${randomUUID()}`;
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? a : b).hit(key, 60_000)));
      assert.deepEqual(
        results.map((result) => result.hits).sort((x, y) => x - y),
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
    });
  });
}

contract(
  "memoria",
  () => {
    const store = new InMemoryRateLimitStore();
    return { a: store, b: store, ready: async () => undefined };
  },
  { skip: false },
);

const opened: RedisRateLimitStore[] = [];
after(async () => {
  await Promise.all(opened.map((store) => store.close()));
});

async function connected(store: RedisRateLimitStore): Promise<void> {
  const until = Date.now() + 3_000;
  while (!store.shared) {
    if (Date.now() > until) assert.fail("Redis no conectó a tiempo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

contract(
  "Redis",
  () => {
    // Un prefijo por prueba: dos pruebas —o dos ficheros— no cuentan en las mismas claves.
    const prefix = `eq:test:rl:${randomUUID()}`;
    const a = new RedisRateLimitStore(REDIS_URL!, prefix);
    const b = new RedisRateLimitStore(REDIS_URL!, prefix);
    opened.push(a, b);
    return { a, b, ready: async () => void (await Promise.all([connected(a), connected(b)])) };
  },
  { skip: REDIS_URL ? false : REASON },
);

describe("Redis caído", () => {
  test("no tumba la petición: cuenta en memoria, con el mismo tope por proceso", async () => {
    // Un puerto en el que no escucha nadie: la conexión se rechaza y el cliente nunca está listo.
    const store = new RedisRateLimitStore("redis://127.0.0.1:1", `eq:test:rl:${randomUUID()}`);
    opened.push(store);
    assert.equal(store.shared, false);
    const key = `ip-${randomUUID()}`;
    assert.equal((await store.hit(key, 60_000)).hits, 1);
    assert.equal((await store.hit(key, 60_000)).hits, 2);
    assert.equal((await store.peek(key))?.hits, 2);
  });
});

describe("el almacén del throttler sobre los contadores", () => {
  test("bloquea pasado el tope, con Retry-After lo que le queda a la ventana", async () => {
    let now = 1_000_000;
    const storage = new SharedThrottlerStorage(new InMemoryRateLimitStore(() => now));
    for (let hit = 1; hit <= 3; hit += 1) {
      const record = await storage.increment("k", 60_000, 3, 60_000, "default");
      assert.equal(record.isBlocked, false);
      assert.equal(record.totalHits, hit);
    }
    now += 15_000;
    const blocked = await storage.increment("k", 60_000, 3, 60_000, "default");
    assert.equal(blocked.isBlocked, true);
    assert.equal(blocked.timeToBlockExpire, 45);
    now += 45_000;
    assert.equal((await storage.increment("k", 60_000, 3, 60_000, "default")).isBlocked, false);
  });

  test("dos throttlers con nombre distinto no comparten cuenta", async () => {
    const storage = new SharedThrottlerStorage(new InMemoryRateLimitStore());
    await storage.increment("k", 60_000, 1, 60_000, "default");
    assert.equal((await storage.increment("k", 60_000, 1, 60_000, "otro")).totalHits, 1);
  });
});

describe("el tope de credenciales malas de la captura", () => {
  test("lo cuentan todas las instancias juntas", async () => {
    const shared = new InMemoryRateLimitStore();
    const a = new AuthFailureLimiter({ max: 3, windowMs: 60_000 }, shared);
    const b = new AuthFailureLimiter({ max: 3, windowMs: 60_000 }, shared);
    await a.failed("10.0.0.1");
    await b.failed("10.0.0.1");
    assert.equal(await a.blocked("10.0.0.1"), null);
    await a.failed("10.0.0.1");
    assert.equal(await b.blocked("10.0.0.1"), 60, "B no vio los intentos que contó A");
    assert.equal(await b.blocked("10.0.0.2"), null);
  });
});
