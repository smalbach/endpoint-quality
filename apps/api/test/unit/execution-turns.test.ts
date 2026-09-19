/**
 * «Una corrida de seguridad —o de rendimiento— a la vez» con varias instancias.
 *
 * Cada instancia es aquí su cola en memoria y su bus, sobre la misma fila de turnos (como dos
 * réplicas sobre la misma base) y el mismo hub (como sobre el mismo Redis). El ejecutor es un
 * manejador que apunta quién corre y cuándo, que es lo único que estas pruebas miran. La fila en
 * Postgres —el candado de verdad— se prueba en `test/db`.
 */
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { InMemoryExecutionTurnStore } from "@/shared/turns/execution-turns";
import { ExecutionTurnGate } from "@/shared/turns/execution-turn-gate";
import { InMemorySecurityRunQueue } from "@/modules/security-runs/infrastructure/in-memory-security-queue";
import { InMemoryPerformanceRunQueue } from "@/modules/performance/infrastructure/in-memory-performance-queue";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Un ejecutor que tarda `ms` y apunta el orden y cuántas corrían a la vez como mucho. */
function recorder(ms: number) {
  const order: string[] = [];
  let running = 0;
  let peak = 0;
  const handler = (name: string) => async (runId: string) => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(`${name}:${runId}`);
    await pause(ms);
    running -= 1;
  };
  return { order, handler, peak: () => peak };
}

describe("la fila de turnos en memoria", () => {
  test("empieza el primero en llegar; los demás esperan aunque sean de otra instancia", async () => {
    const store = new InMemoryExecutionTurnStore();
    await store.join("security", "r1", "a");
    await store.join("security", "r2", "b");
    assert.equal(await store.tryStart("security", "r2", "b", 30_000), false, "r2 se coló delante de r1");
    assert.equal(await store.tryStart("security", "r1", "a", 30_000), true);
    assert.equal(await store.tryStart("security", "r2", "b", 30_000), false, "dos a la vez");
    await store.leave("r1", "a");
    assert.equal(await store.tryStart("security", "r2", "b", 30_000), true);
  });

  test("un tipo no espera al otro", async () => {
    const store = new InMemoryExecutionTurnStore();
    await store.join("security", "s", "a");
    await store.join("performance", "p", "b");
    assert.equal(await store.tryStart("security", "s", "a", 30_000), true);
    assert.equal(await store.tryStart("performance", "p", "b", 30_000), true);
  });

  test("solo su instancia empieza o deja una fila", async () => {
    const store = new InMemoryExecutionTurnStore();
    await store.join("security", "r1", "a");
    assert.equal(await store.tryStart("security", "r1", "b", 30_000), false);
    await store.leave("r1", "b");
    assert.equal(store.rows.size, 1);
  });

  test("una fila sin latir más de lo acordado es de una instancia muerta y deja de contar", async () => {
    let now = 1_000_000;
    const store = new InMemoryExecutionTurnStore(() => now);
    await store.join("security", "muerta", "caida");
    assert.equal(await store.tryStart("security", "muerta", "caida", 30_000), true);
    await store.join("security", "viva", "b");
    now += 20_000;
    await store.heartbeat("b");
    assert.equal(await store.tryStart("security", "viva", "b", 30_000), false);
    now += 15_000;
    assert.equal(await store.tryStart("security", "viva", "b", 30_000), true, "la muerta sigue bloqueando");
    assert.equal(store.rows.has("muerta"), false);
  });
});

describe("el turno con dos instancias", () => {
  test("recupera el turno de una instancia que murió corriendo, pasado el plazo del latido", async () => {
    const store = new InMemoryExecutionTurnStore();
    // Una instancia que empezó una corrida y no volvió a latir.
    await store.join("performance", "de-la-muerta", "muerta");
    assert.equal(await store.tryStart("performance", "de-la-muerta", "muerta", 30_000), true);
    const gate = new ExecutionTurnGate(store, new InMemoryInstanceBus(), "performance", {
      pollMs: 10,
      heartbeatMs: 20,
      staleMs: 150,
    });
    const startedAt = Date.now();
    await gate.join("mia");
    assert.equal(await gate.take("mia"), true);
    const waited = Date.now() - startedAt;
    assert.ok(waited >= 120, `empezó sin esperar a que caducara la otra: ${waited} ms`);
    assert.ok(waited < 2_000, `tardó demasiado: ${waited} ms`);
    await gate.leave("mia");
    gate.close();
  });

  test("seguridad: A y B encolan a la vez, corre una sola y salen en el orden en que llegaron", async () => {
    const hub = new InMemoryBusHub();
    const store = new InMemoryExecutionTurnStore();
    const a = new InMemorySecurityRunQueue(new InMemoryInstanceBus(hub, "a"), store);
    const b = new InMemorySecurityRunQueue(new InMemoryInstanceBus(hub, "b"), store);
    const seen = recorder(60);
    a.process(seen.handler("a"));
    b.process(seen.handler("b"));

    await a.enqueue("a1");
    await b.enqueue("b1");
    await a.enqueue("a2");
    await b.enqueue("b2");
    await Promise.all([a.idle(), b.idle()]);

    assert.equal(seen.peak(), 1, `corrieron ${seen.peak()} a la vez`);
    assert.deepEqual(seen.order, ["a:a1", "b:b1", "a:a2", "b:b2"]);
    assert.equal(store.rows.size, 0, "quedaron filas de corridas terminadas");
    a.onModuleDestroy();
    b.onModuleDestroy();
  });

  test("seguridad: una que falla deja el turno igual", async () => {
    const hub = new InMemoryBusHub();
    const store = new InMemoryExecutionTurnStore();
    const a = new InMemorySecurityRunQueue(new InMemoryInstanceBus(hub, "a"), store);
    const b = new InMemorySecurityRunQueue(new InMemoryInstanceBus(hub, "b"), store);
    const ran: string[] = [];
    a.process(async () => {
      await pause(20);
      throw new Error("se rompió");
    });
    b.process(async (runId) => void ran.push(runId));
    await a.enqueue(randomUUID());
    await b.enqueue("b1");
    await Promise.all([a.idle(), b.idle()]);
    assert.deepEqual(ran, ["b1"]);
    a.onModuleDestroy();
    b.onModuleDestroy();
  });

  test("rendimiento: la de B espera a que termine la de A, y la cancelada en la fila no llega a correr", async () => {
    const hub = new InMemoryBusHub();
    const store = new InMemoryExecutionTurnStore();
    const a = new InMemoryPerformanceRunQueue(new InMemoryInstanceBus(hub, "a"), store);
    const b = new InMemoryPerformanceRunQueue(new InMemoryInstanceBus(hub, "b"), store);
    const seen = recorder(80);
    a.process(seen.handler("a"));
    b.process(seen.handler("b"));

    await a.enqueue("a1");
    await b.enqueue("b1");
    await b.enqueue("b2");
    await pause(10);
    // B tiene dos en su fila; la segunda se cancela desde A mientras espera.
    await a.cancel("b2");
    await Promise.all([a.idle(), b.idle()]);

    assert.equal(seen.peak(), 1, `corrieron ${seen.peak()} a la vez`);
    assert.deepEqual(seen.order, ["a:a1", "b:b1"]);
    assert.equal(store.rows.size, 0);
    a.onModuleDestroy();
    b.onModuleDestroy();
  });
});
