/**
 * La cola de corridas de colección, sola.
 *
 * Una a la vez en todo el despliegue, y cancelable en el hueco entre dos peticiones: lo mismo que
 * hacen la de seguridad y la de rendimiento, y por lo mismo —una colección corriendo está
 * escribiendo en el API de alguien—. Lo que se prueba aquí es el orden, el «Cancelar» que entra
 * mientras la corrida todavía espera, y el turno que tiene otra réplica, que es una fila puesta a
 * mano en el almacén compartido: exactamente lo que dejaría ahí una segunda instancia.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryExecutionTurnStore } from "@/shared/turns/execution-turns";
import { InMemoryCollectionRunQueue } from "@/modules/collections/infrastructure/in-memory-collection-queue";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** Un handler cuyas corridas acaban cuando el test lo dice. */
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

/** Ocupa el turno de colecciones como si otra réplica estuviera corriendo una. */
async function occupied() {
  const store = new InMemoryExecutionTurnStore();
  await store.join("collection", "de-otra-replica", "otra-instancia");
  assert.equal(await store.tryStart("collection", "de-otra-replica", "otra-instancia", 60_000), true);
  return store;
}

describe("la cola de colecciones", () => {
  test("una a la vez y en el orden en que se encolaron", async () => {
    const queue = new InMemoryCollectionRunQueue();
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

  test("cancelar mientras corre marca la corrida, y al terminar la marca se borra", async () => {
    const queue = new InMemoryCollectionRunQueue();
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("en-vuelo");
    await tick();
    await queue.cancel("en-vuelo");
    // La que está en vuelo no se interrumpe: es el runner quien mira la marca entre dos peticiones.
    assert.equal(queue.isCancelled("en-vuelo"), true);
    gate.release("en-vuelo");
    await queue.idle();
    assert.equal(queue.isCancelled("en-vuelo"), false);
    queue.onModuleDestroy();
  });

  test("una cancelada mientras esperaba en la fila nunca llega a arrancar", async () => {
    const queue = new InMemoryCollectionRunQueue();
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("corriendo");
    await queue.enqueue("en-cola");
    await tick();
    await queue.cancel("en-cola");
    gate.release("corriendo");
    await queue.idle();
    assert.deepEqual(gate.started, ["corriendo"]);
    // Cancelar algo que la cola no conoce solo deja la marca.
    await queue.cancel("desconocida");
    assert.equal(queue.isCancelled("desconocida"), true);
    queue.onModuleDestroy();
  });

  test("cancelada mientras espera el turno de otra réplica: sale de la fila sin ejecutarse", async () => {
    const store = await occupied();
    const queue = new InMemoryCollectionRunQueue(null, store);
    const gate = gatedHandler();
    queue.process(gate.handler);
    await queue.enqueue("bloqueada");
    await tick(30);
    assert.deepEqual(gate.started, [], "el turno es de la otra instancia");

    await queue.cancel("bloqueada");
    await queue.idle();
    assert.deepEqual(gate.started, []);
    assert.equal(store.rows.has("bloqueada"), false, "dejó la fila de turnos");
    // El «settled» que publica al desistir borra la marca: la corrida ya no está en ninguna parte.
    assert.equal(queue.isCancelled("bloqueada"), false);
    queue.onModuleDestroy();
  });

  test("sin handler todavía, encolar no ejecuta nada", async () => {
    const queue = new InMemoryCollectionRunQueue(null, null);
    await queue.enqueue("sin-quien-la-corra");
    await tick();
    assert.equal(queue.isCancelled("sin-quien-la-corra"), false);
    queue.onModuleDestroy();
  });
});
