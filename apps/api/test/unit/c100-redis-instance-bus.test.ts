/**
 * El bus entre instancias por Redis, contra un Redis de mentira en el mismo proceso
 * (test/support/c100-redis-fakes.ts): el mismo contrato que test/unit/instance-bus.test.ts corre
 * contra el adaptador en memoria —y contra un Redis de verdad solo con `EQ_TEST_REDIS_URL`—, más lo
 * que solo tiene el de Redis: caerse y volver, lo ilegible que llega por el cable, las órdenes que
 * vencen su plazo y el cierre con órdenes pendientes.
 */
// Primero el falso: el adaptador pide `ioredis` al cargarse.
import { FakeRedis, fakeRedisServer, type FakeRedisServer } from "@test/support/c100-redis-fakes";

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { InstanceUnreachableError } from "@/shared/bus/instance-bus";
import { RedisInstanceBus } from "@/shared/bus/redis-instance-bus";
import { ConflictError, DomainError, InvalidInputError } from "@/shared/errors/domain-error";

let warnings: string[] = [];
let infos: string[] = [];
const opened: RedisInstanceBus[] = [];

beforeEach(() => {
  warnings = [];
  infos = [];
  mock.method(Logger.prototype, "warn", (message: string) => void warnings.push(message));
  mock.method(Logger.prototype, "log", (message: string) => void infos.push(message));
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((bus) => bus.close()));
  mock.restoreAll();
});

async function eventually(check: () => boolean, what: string, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`no llegó a tiempo: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settleNetwork = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

type World = { url: string; server: FakeRedisServer; prefix: string };

function world(): World {
  const url = `redis://fake-${randomUUID()}:6379`;
  return { url, server: fakeRedisServer(url), prefix: `eq:test:${randomUUID()}` };
}

function bus(w: World, id = `i-${randomUUID()}`): RedisInstanceBus {
  const instance = new RedisInstanceBus(w.url, id, w.prefix);
  opened.push(instance);
  return instance;
}

async function connected(w: World): Promise<void> {
  await eventually(() => [...w.server.clients].every((client) => client.status === "ready"), "la conexión");
}

/** Un cliente crudo en el mismo «Redis»: lo que otra instancia —o alguien con malas ideas— pondría en el cable. */
async function raw(w: World): Promise<FakeRedis> {
  const client = new FakeRedis(w.url);
  await eventually(() => client.status === "ready", "el cliente crudo");
  return client;
}

describe("bus entre instancias: Redis (falso), el contrato", () => {
  async function pair() {
    const w = world();
    const a = bus(w, `a-${randomUUID()}`);
    const b = bus(w, `b-${randomUUID()}`);
    await connected(w);
    return { a, b, w };
  }

  test("publicar llega a esta instancia en el acto y a la otra una sola vez", async () => {
    const { a, b } = await pair();
    const onA: unknown[] = [];
    const onB: unknown[] = [];
    a.subscribe("t", (message) => onA.push(message));
    b.subscribe("t", (message) => onB.push(message));

    a.publish("t", { n: 1 });
    assert.deepEqual(onA, [{ n: 1 }], "lo local no espera a la red");
    await eventually(() => onB.length === 1, "el evento en la otra instancia");
    await settleNetwork();
    assert.deepEqual(onA, [{ n: 1 }], "lo propio no vuelve de rebote");
    assert.deepEqual(onB, [{ n: 1 }]);
  });

  test("conserva el orden, separa los temas y deja de entregar al desuscribirse", async () => {
    const { a, b } = await pair();
    const seen: number[] = [];
    const other: unknown[] = [];
    const stop = b.subscribe<{ n: number }>("orden", (message) => seen.push(message.n));
    b.subscribe("otro", (message) => other.push(message));
    for (let n = 0; n < 20; n++) a.publish("orden", { n });
    await eventually(() => seen.length === 20, "los veinte eventos");
    assert.deepEqual(
      seen,
      Array.from({ length: 20 }, (_, n) => n),
    );
    assert.deepEqual(other, []);

    stop();
    a.publish("orden", { n: 99 });
    await settleNetwork();
    assert.equal(seen.length, 20);
  });

  test("lo que cruza, cruza en JSON: una fecha llega como texto", async () => {
    const { a, b } = await pair();
    const got: { at: unknown }[] = [];
    b.subscribe<{ at: unknown }>("fechas", (message) => got.push(message));
    a.publish("fechas", { at: new Date("2026-01-01T00:00:00.000Z") });
    await eventually(() => got.length === 1, "la fecha");
    assert.equal(got[0].at, "2026-01-01T00:00:00.000Z");
  });

  test("un oyente que falla no deja sin evento a los demás, y queda en el registro", async () => {
    const { a, b } = await pair();
    const seen: unknown[] = [];
    const remote: unknown[] = [];
    a.subscribe("frágil", () => {
      throw new Error("roto");
    });
    a.subscribe("frágil", (message) => seen.push(message));
    b.subscribe("frágil", () => {
      throw "roto a secas";
    });
    b.subscribe("frágil", (message) => remote.push(message));
    a.publish("frágil", 1);
    assert.deepEqual(seen, [1]);
    await eventually(() => remote.length === 1, "el evento en la otra instancia");
    assert.ok(warnings.includes("Un oyente de frágil falló: roto"), warnings.join("\n"));
    assert.ok(warnings.includes("Un oyente de frágil falló: roto a secas"), warnings.join("\n"));
  });

  test("pedir a otra instancia devuelve su respuesta", async () => {
    const { a, b } = await pair();
    b.handle<{ x: number }, { doble: number; quien: string }>("doblar", ({ x }) => ({
      doble: x * 2,
      quien: b.instanceId,
    }));
    const answer = await a.request<{ doble: number; quien: string }>(b.instanceId, "doblar", { x: 21 });
    assert.deepEqual(answer, { doble: 42, quien: b.instanceId });
  });

  test("un error de dominio vuelve con su tipo, su código y sus campos", async () => {
    const { a, b } = await pair();
    b.handle("mal", () => {
      throw new InvalidInputError("El mensaje no es válido", [{ field: "text", detail: "vacío" }], "bad-text");
    });
    b.handle("choca", async () => {
      throw new ConflictError("Ya terminó", "channel-session-finished");
    });
    b.handle("roto", () => {
      throw new Error("algo interno");
    });

    await assert.rejects(a.request(b.instanceId, "mal", {}), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.kind, "invalid");
      assert.equal(error.code, "bad-text");
      assert.deepEqual(error.fields, [{ field: "text", detail: "vacío" }]);
      return true;
    });
    await assert.rejects(a.request(b.instanceId, "choca", {}), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.kind, "conflict");
      assert.equal(error.code, "channel-session-finished");
      return true;
    });
    await assert.rejects(a.request(b.instanceId, "roto", {}), (error: unknown) => {
      assert.ok(!(error instanceof DomainError), "un fallo interno no se disfraza de error de dominio");
      assert.match((error as Error).message, /algo interno/);
      return true;
    });
  });

  test("pedirse a sí misma funciona igual, en JSON, y con los mismos errores", async () => {
    const { a } = await pair();
    a.handle<{ x: number }, number>("eco", ({ x }) => x);
    a.handle<unknown, { at: Date }>("fecha", () => ({ at: new Date("2026-01-01T00:00:00.000Z") }));
    a.handle<unknown, unknown>("nada", (message) => {
      assert.equal(message, null, "sin mensaje llega null, como por la red");
      return undefined;
    });
    a.handle("choca", () => {
      throw new ConflictError("Ya terminó", "channel-session-finished");
    });
    assert.equal(await a.request<number>(a.instanceId, "eco", { x: 7 }), 7);
    assert.deepEqual(await a.request(a.instanceId, "fecha", {}), { at: "2026-01-01T00:00:00.000Z" });
    assert.equal(await a.request(a.instanceId, "nada", undefined), undefined);
    await assert.rejects(a.request(a.instanceId, "choca", {}), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "channel-session-finished");
      return true;
    });
    await assert.rejects(a.request(a.instanceId, "nadie-atiende", {}), (error: unknown) => {
      assert.ok(error instanceof InstanceUnreachableError);
      assert.equal(error.instanceId, a.instanceId);
      assert.match(error.message, /no atiende nadie-atiende/);
      return true;
    });
  });

  test("pedir a una instancia que no está es un InstanceUnreachableError, y sin esperar el plazo", async () => {
    const { a } = await pair();
    const started = Date.now();
    await assert.rejects(a.request("nadie:0:00000000", "eco", {}, 5_000), (error: unknown) => {
      assert.ok(error instanceof InstanceUnreachableError);
      assert.match(error.message, /no escucha en el bus/);
      return true;
    });
    assert.ok(Date.now() - started < 1_000, "nadie escuchando se sabe ya, no al vencer el plazo");
  });
});

describe("bus entre instancias: Redis (falso), lo que solo tiene Redis", () => {
  test("sin prefijo ni id usa los de siempre: eq:bus y un id de este host y proceso", async () => {
    const w = world();
    const instance = new RedisInstanceBus(w.url);
    opened.push(instance);
    assert.ok(instance.instanceId.startsWith(`${hostname()}:${process.pid}:`), instance.instanceId);
    assert.ok(w.server.channels.has("eq:bus:events"));
    assert.ok(w.server.channels.has(`eq:bus:rpc:${instance.instanceId}`));
  });

  test("conecta dos clientes: el que publica sin cola fuera de línea, con reintentos hasta 10 s", async () => {
    const w = world();
    bus(w);
    const [publisher, subscriber] = [...w.server.clients];
    assert.equal(publisher.options.enableOfflineQueue, false);
    assert.equal(publisher.options.maxRetriesPerRequest, 1);
    assert.equal(subscriber.options.enableOfflineQueue, undefined, "el que escucha sí conserva su cola");
    const retry = publisher.options.retryStrategy!;
    assert.deepEqual([retry(1), retry(4), retry(20), retry(1_000)], [500, 2_000, 10_000, 10_000]);
  });

  test("publicar antes de conectar entrega aquí y no intenta la red", async () => {
    const w = world();
    const listener = await raw(w);
    const heard: string[] = [];
    listener.on("message", (_channel: string, message: string) => heard.push(message));
    await listener.subscribe(`${w.prefix}:events`);
    const a = bus(w);
    // Recién creada: los clientes de `a` aún no están listos (conectan en el turno siguiente).
    const seen: unknown[] = [];
    a.subscribe("pronto", (message) => seen.push(message));
    a.publish("pronto", 1);
    assert.deepEqual(seen, [1]);
    await connected(w);
    await settleNetwork();
    assert.deepEqual(heard, [], "nada salió a la red antes de estar lista");
    assert.equal(warnings.length, 0, "no es un fallo: el aviso de caída, si lo hay, es de `fell`");
  });

  test("Redis caído: se avisa una vez, se sigue sirviendo lo local, y al volver se avisa y se vuelve a cruzar", async () => {
    const w = world();
    const a = bus(w);
    const b = bus(w);
    await connected(w);
    const onA: unknown[] = [];
    const onB: unknown[] = [];
    a.subscribe("t", (message) => onA.push(message));
    b.subscribe("t", (message) => onB.push(message));

    w.server.stop();
    w.server.stop(new Error("otra vez"));
    const fallen = warnings.filter((message) => message.startsWith("Sin bus entre instancias (Redis)"));
    // Una por instancia, no una por cliente ni por reintento.
    assert.equal(fallen.length, 2, warnings.join("\n"));
    assert.equal(
      fallen[0],
      "Sin bus entre instancias (Redis): connect ECONNREFUSED 127.0.0.1:6379. Esta instancia sigue sirviendo lo suyo",
    );

    a.publish("t", "solo aquí");
    assert.deepEqual(onA, ["solo aquí"]);
    await settleNetwork();
    assert.deepEqual(onB, []);

    w.server.start();
    assert.deepEqual(infos, ["Bus entre instancias recuperado", "Bus entre instancias recuperado"]);
    a.publish("t", "otra vez por la red");
    await eventually(() => onB.length === 1, "el evento tras volver");
    assert.deepEqual(onB, ["otra vez por la red"]);
    // Volver dos veces no se anuncia dos veces.
    w.server.start();
    assert.equal(infos.length, 2);
  });

  test("una caída que no es un Error se cuenta igual, en texto", async () => {
    const w = world();
    bus(w);
    await connected(w);
    w.server.stop("socket colgado");
    assert.deepEqual(warnings, [
      "Sin bus entre instancias (Redis): socket colgado. Esta instancia sigue sirviendo lo suyo",
    ]);
  });

  test("si la suscripción falla, se dice que no hay bus", async () => {
    const w = world();
    w.server.failSubscribe = new Error("NOPERM");
    bus(w);
    await settleNetwork();
    assert.ok(
      warnings.includes("Sin bus entre instancias (Redis): NOPERM. Esta instancia sigue sirviendo lo suyo"),
      warnings.join("\n"),
    );
  });

  test("un evento que no sale se avisa, salvo con Redis ya dado por caído", async () => {
    const w = world();
    const a = bus(w);
    await connected(w);
    w.server.failPublish = new Error("OOM");
    a.publish("t", 1);
    await settleNetwork();
    assert.deepEqual(warnings, ["No salió un mensaje por el bus: OOM"]);

    w.server.failPublish = "sin memoria";
    a.publish("t", 2);
    await settleNetwork();
    assert.equal(warnings[1], "No salió un mensaje por el bus: sin memoria");

    // Caído, pero con el cliente aún «listo» un instante: el aviso ya se dio al caer.
    const [publisher] = [...w.server.clients];
    publisher.emit("error", new Error("se fue"));
    const count = warnings.length;
    a.publish("t", 3);
    await settleNetwork();
    assert.equal(warnings.length, count, "no se repite el aviso por cada evento");
  });

  test("lo ilegible que llega por el cable se ignora y se dice; lo ajeno a esta instancia se entrega", async () => {
    const w = world();
    const a = bus(w);
    await connected(w);
    const seen: unknown[] = [];
    a.subscribe("t", (message) => seen.push(message));
    const intruder = await raw(w);
    await intruder.publish(`${w.prefix}:events`, "{no es json");
    await intruder.publish(`${w.prefix}:rpc:${a.instanceId}`, "tampoco");
    await intruder.publish(`${w.prefix}:events`, JSON.stringify({ origin: "otra", topic: "t", message: 5 }));
    await intruder.publish(`${w.prefix}:events`, JSON.stringify({ origin: "otra", topic: "sin-oyentes", message: 6 }));
    await eventually(() => seen.length === 1, "el evento legible");
    assert.deepEqual(seen, [5]);
    assert.deepEqual(warnings, [
      `Llegó por ${w.prefix}:events algo que no se pudo leer`,
      `Llegó por ${w.prefix}:rpc:${a.instanceId} algo que no se pudo leer`,
    ]);
  });

  test("una orden sin respuesta vence su plazo; la respuesta tardía se descarta", async () => {
    const w = world();
    const a = bus(w);
    await connected(w);
    // Alguien escucha en el canal de «b» pero nunca contesta: una instancia colgada.
    const hung = await raw(w);
    const requests: { id: string; replyTo: string; topic: string; message: unknown }[] = [];
    hung.on("message", (_channel: string, message: string) => requests.push(JSON.parse(message)));
    await hung.subscribe(`${w.prefix}:rpc:b-colgada`);

    await assert.rejects(a.request("b-colgada", "eco", { x: 1 }, 30), (error: unknown) => {
      assert.ok(error instanceof InstanceUnreachableError);
      assert.equal(error.instanceId, "b-colgada");
      assert.match(error.message, /sin respuesta en 30 ms/);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      { topic: requests[0].topic, message: requests[0].message, replyTo: requests[0].replyTo },
      { topic: "eco", message: { x: 1 }, replyTo: a.instanceId },
    );

    // La respuesta llega cuando ya nadie la espera: ni resuelve nada ni rompe nada.
    await hung.publish(
      `${w.prefix}:rpc:${requests[0].replyTo}`,
      JSON.stringify({ kind: "reply", id: requests[0].id, ok: true, value: "tarde" }),
    );
    await settleNetwork();
    assert.deepEqual(warnings, []);
  });

  test("con el que publica sin conexión, pedir a otra falla en el acto con el motivo", async () => {
    const w = world();
    const a = bus(w);
    await connected(w);
    w.server.failPublish = new Error("READONLY");
    await assert.rejects(a.request("otra", "eco", {}, 5_000), (error: unknown) => {
      assert.ok(error instanceof InstanceUnreachableError);
      assert.match(error.message, /La instancia otra no contestó: READONLY/);
      return true;
    });
    w.server.failPublish = "caído";
    await assert.rejects(a.request("otra", "eco", {}, 5_000), /La instancia otra no contestó: caído/);
    w.server.failPublish = null;
    w.server.stop();
    await assert.rejects(a.request("otra", "eco", {}, 5_000), /enableOfflineQueue/);
  });

  test("la otra instancia sin manejador contesta con un error; un manejador sin valor contesta null", async () => {
    const w = world();
    const a = bus(w);
    const b = bus(w);
    await connected(w);
    b.handle("vacío", () => undefined);
    assert.equal(await a.request(b.instanceId, "vacío", {}), null);
    await assert.rejects(a.request(b.instanceId, "desconocido", {}), (error: unknown) => {
      assert.ok(!(error instanceof DomainError));
      assert.equal((error as Error).message, `La instancia ${b.instanceId} no atiende desconocido`);
      return true;
    });
  });

  test("si la respuesta no sale, quien contesta lo avisa y quien pidió vence su plazo", async () => {
    const w = world();
    const a = bus(w);
    const b = bus(w);
    await connected(w);
    let answered = 0;
    b.handle("eco", () => {
      answered += 1;
      // La respuesta de `b` ya no podrá publicarse.
      w.server.failPublish = new Error("se cortó");
      return "hola";
    });
    await assert.rejects(a.request(b.instanceId, "eco", {}, 50), /sin respuesta en 50 ms/);
    assert.equal(answered, 1);
    assert.ok(warnings.includes("No salió un mensaje por el bus: se cortó"), warnings.join("\n"));
  });

  test("cerrar rechaza las órdenes pendientes y suelta las conexiones, aunque quit falle", async () => {
    const w = world();
    const a = new RedisInstanceBus(w.url, "a", w.prefix);
    await connected(w);
    const hung = await raw(w);
    await hung.subscribe(`${w.prefix}:rpc:colgada`);
    const pending = a.request("colgada", "eco", {}, 60_000);
    await settleNetwork();
    w.server.failQuit = new Error("ya cerrado");
    await a.onModuleDestroy();
    await assert.rejects(pending, /El bus se está cerrando/);
    assert.equal(
      [...w.server.clients].filter((client) => client !== hung).length,
      0,
      "los dos clientes de la instancia se fueron",
    );
    w.server.failQuit = null;
    await hung.quit();
  });
});
