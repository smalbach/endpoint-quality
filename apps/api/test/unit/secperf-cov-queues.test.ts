/**
 * The two in-memory queues of security and performance runs, standing alone: the order they run
 * in, a cancel that arrives while a run is still waiting for its turn, a handler that throws, and a
 * shutdown while waiting. «Another instance holds the turn» is a row put straight into the shared
 * turn store, which is exactly what a second replica would leave there.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryExecutionTurnStore } from "@/shared/turns/execution-turns";
import { InMemorySecurityRunQueue } from "@/modules/security-runs/infrastructure/in-memory-security-queue";
import { InMemoryPerformanceRunQueue } from "@/modules/performance/infrastructure/in-memory-performance-queue";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** A handler whose runs finish only when the test says so. */
function gatedHandler() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const handler = (runId: string) =>
    new Promise<void>((resolve) => {
      started.push(runId);
      releases.set(runId, resolve);
    });
  return { started, handler, release: (runId: string) => releases.get(runId)?.() };
}

/** Occupies the turn of `kind` as if another replica were running something. */
async function occupied(kind: "security" | "performance") {
  const store = new InMemoryExecutionTurnStore();
  await store.join(kind, "de-otra-replica", "otra-instancia");
  assert.equal(await store.tryStart(kind, "de-otra-replica", "otra-instancia", 60_000), true);
  return store;
}

describe("la cola de seguridad", () => {
  test("una a la vez y en orden; un handler que lanza no para la cola", async () => {
    const queue = new InMemorySecurityRunQueue();
    const ran: string[] = [];
    queue.process(async (runId) => {
      ran.push(runId);
      if (runId === "a") throw new Error("reventó");
      if (runId === "b") throw "no es un Error";
    });
    await queue.enqueue("a");
    await queue.enqueue("b");
    await queue.enqueue("c");
    await queue.idle();
    assert.deepEqual(ran, ["a", "b", "c"]);
    queue.onModuleDestroy();
  });

  test("encolar antes de tener handler no ejecuta nada; al registrarlo, arranca", async () => {
    const queue = new InMemorySecurityRunQueue(null, null);
    await queue.enqueue("temprana");
    await tick();
    const ran: string[] = [];
    queue.process(async (runId) => {
      ran.push(runId);
    });
    await queue.idle();
    assert.deepEqual(ran, ["temprana"]);
    queue.onModuleDestroy();
  });

  test("cancelar marca la corrida mientras corre, y al terminar la marca se borra", async () => {
    const queue = new InMemorySecurityRunQueue();
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("x");
    await tick();
    assert.deepEqual(gate.started, ["x"]);
    await queue.cancel("x");
    assert.equal(queue.isCancelled("x"), true);
    gate.release("x");
    await queue.idle();
    assert.equal(queue.isCancelled("x"), false);
    queue.onModuleDestroy();
  });

  test("apagarse mientras espera turno la deja sin ejecutar", async () => {
    const queue = new InMemorySecurityRunQueue(null, await occupied("security"));
    const ran: string[] = [];
    queue.process(async (runId) => {
      ran.push(runId);
    });
    await queue.enqueue("esperando");
    await tick(30);
    queue.onModuleDestroy();
    await tick(30);
    assert.deepEqual(ran, []);
  });
});

describe("la cola de rendimiento", () => {
  test("una a la vez y en orden", async () => {
    const queue = new InMemoryPerformanceRunQueue();
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("uno");
    await queue.enqueue("dos");
    await tick();
    assert.deepEqual(gate.started, ["uno"], "la segunda espera a la primera");
    gate.release("uno");
    await tick();
    assert.deepEqual(gate.started, ["uno", "dos"]);
    gate.release("dos");
    await queue.idle();
    queue.onModuleDestroy();
  });

  test("una cancelada mientras espera en la cola nunca arranca", async () => {
    const queue = new InMemoryPerformanceRunQueue();
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("corriendo");
    await queue.enqueue("en-cola");
    await tick();
    await queue.cancel("en-cola");
    assert.equal(queue.isCancelled("en-cola"), true);
    gate.release("corriendo");
    await queue.idle();
    assert.deepEqual(gate.started, ["corriendo"]);
    // Cancelar lo que ya no está en la cola solo la marca.
    await queue.cancel("desconocida");
    assert.equal(queue.isCancelled("desconocida"), true);
    queue.onModuleDestroy();
  });

  test("cancelada mientras espera el turno de otra réplica: sale de la fila sin ejecutarse", async () => {
    const store = await occupied("performance");
    const queue = new InMemoryPerformanceRunQueue(null, store);
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("bloqueada");
    await tick(30);
    assert.deepEqual(gate.started, [], "otra réplica tiene el turno");
    await queue.cancel("bloqueada");
    await queue.idle();
    assert.deepEqual(gate.started, []);
    assert.equal(store.rows.has("bloqueada"), false, "dejó la fila de turnos");
    // «settled» borra la marca: la corrida ya no está en ninguna parte.
    assert.equal(queue.isCancelled("bloqueada"), false);
    queue.onModuleDestroy();
  });

  test("sin handler, encolar no ejecuta nada", async () => {
    const queue = new InMemoryPerformanceRunQueue(null, null);
    await queue.enqueue("huérfana");
    await tick();
    assert.equal(queue.isCancelled("huérfana"), false);
    queue.onModuleDestroy();
  });
});
