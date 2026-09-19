/**
 * La cola de corridas sobre BullMQ, contra un BullMQ de mentira (test/support/c100-redis-fakes.ts).
 *
 * BullMQ es una dependencia opcional que aquí no está instalada: lo primero que se prueba es que su
 * falta se dice con lo que hay que hacer. Después, con el falso instalado, lo que la cola promete:
 * un trabajo por corrida, el trabajador de uno en uno, cancelar lo que espera y marcar lo que ya
 * corre, y las banderas de pausa y reanudación con su hora de caducidad.
 */
// Primero el falso: sin él, `require("bullmq")` no encuentra nada.
import {
  fakeBroker,
  FakeQueue,
  FakeWorker,
  installFakeBullmq,
  uninstallFakeBullmq,
} from "@test/support/c100-redis-fakes";

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { RedisRunQueue } from "@/modules/runs/infrastructure/queue/redis-queue";

const URL = "redis://cola:6379";
let errors: string[] = [];

beforeEach(() => {
  errors = [];
  mock.method(Logger.prototype, "error", (message: string) => void errors.push(message));
  installFakeBullmq();
});
afterEach(() => {
  mock.restoreAll();
  uninstallFakeBullmq();
});

async function eventually(check: () => boolean, what: string, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`no llegó a tiempo: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function queueFor(name = `runs-${randomUUID()}`) {
  return { name, queue: new RedisRunQueue(URL, name), broker: fakeBroker(name) };
}

describe("la cola de corridas en Redis", () => {
  test("sin bullmq instalado, cada operación falla diciendo qué instalar o qué usar", async () => {
    uninstallFakeBullmq();
    const { queue, broker } = queueFor();
    const message = "QUEUE_DRIVER=redis requiere la dependencia bullmq: instálala o usa QUEUE_DRIVER=memory";
    await assert.rejects(queue.enqueue("r1"), { message });
    await assert.rejects(queue.isCancelled("r1"), { message });
    await assert.rejects(queue.takeResume("r1"), { message });
    assert.equal(broker.queues.length, 0, "no se abrió ninguna cola");
    // Si luego aparece, la siguiente operación la usa: el fallo no se quedó guardado.
    installFakeBullmq();
    await queue.enqueue("r1");
    assert.equal(broker.queues.length, 1);
  });

  test("sin nombre, la cola se llama runs; y conecta a la URL que se le da", async () => {
    const queue = new RedisRunQueue(URL);
    await queue.enqueue(`r-${randomUUID()}`);
    const [opened] = fakeBroker("runs").queues;
    assert.equal(opened.name, "runs");
    assert.deepEqual(opened.options, { connection: { url: URL } });
    await queue.onModuleDestroy();
  });

  test("encolar dos veces la misma corrida es un solo trabajo, y el trabajador la ejecuta una vez", async () => {
    const { queue, broker } = queueFor();
    const ran: string[] = [];
    await queue.enqueue("r1");
    await queue.enqueue("r1");
    await queue.enqueue("r2");
    // Una sola cola abierta para todas las operaciones.
    assert.equal(broker.queues.length, 1);
    assert.deepEqual(broker.queues[0].added[0], {
      name: "run",
      data: { runId: "r1" },
      options: { jobId: "r1", removeOnComplete: true, removeOnFail: false },
    });

    queue.process(async (runId) => void ran.push(runId));
    await eventually(() => ran.length === 2, "las dos corridas");
    assert.deepEqual(ran.sort(), ["r1", "r2"]);
    const [worker] = broker.workers;
    assert.equal(worker.options.concurrency, 1, "de una en una por trabajador");
    assert.deepEqual(worker.options.connection, { url: URL });
    assert.equal(broker.jobs.size, 0, "lo completado se quita");
    assert.deepEqual(errors, []);
  });

  test("una corrida que falla en el trabajador queda en el registro con su id, y se conserva", async () => {
    const { queue, broker } = queueFor();
    queue.process(async (runId) => {
      throw new Error(`se rompió ${runId}`);
    });
    await queue.enqueue("r-mala");
    await eventually(() => errors.length === 1, "el error en el registro");
    assert.deepEqual(errors, ["La corrida r-mala falló en la cola: se rompió r-mala"]);
    assert.equal(broker.jobs.get("r-mala")?.state, "failed", "removeOnFail: false");

    // BullMQ puede avisar de un fallo sin trabajo (se perdió su registro): se dice igual.
    broker.workers[0].emit("failed", undefined, new Error("stalled"));
    assert.equal(errors[1], "La corrida undefined falló en la cola: stalled");
  });

  test("cancelar quita lo que espera y deja la bandera por una hora", async () => {
    const { queue, broker } = queueFor();
    await queue.enqueue("r1");
    assert.equal(await queue.isCancelled("r1"), false);
    await queue.cancel("r1");
    assert.equal(broker.jobs.has("r1"), false, "ya no espera");
    assert.equal(await queue.isCancelled("r1"), true);
    assert.deepEqual(broker.kv.data.get("run:cancelled:r1"), { value: "1", ttlSeconds: 3600 });
    assert.equal(await queue.isCancelled("r2"), false);
  });

  test("cancelar lo que ya corre no falla: el trabajo está bloqueado, y la bandera la ve el trabajador", async () => {
    const { queue, broker } = queueFor();
    let release!: () => void;
    const seen: boolean[] = [];
    queue.process(async (runId) => {
      await new Promise<void>((resolve) => (release = resolve));
      seen.push(await queue.isCancelled(runId));
    });
    await queue.enqueue("r1");
    await eventually(() => broker.jobs.get("r1")?.state === "active", "la corrida en marcha");
    await queue.cancel("r1");
    assert.equal(broker.jobs.get("r1")?.state, "active", "no se pudo quitar: está en marcha");
    release();
    await eventually(() => seen.length === 1, "el trabajador mira la bandera");
    assert.deepEqual(seen, [true]);
    assert.deepEqual(errors, []);
  });

  test("pausar guarda dónde, por una hora; pausar con null la quita", async () => {
    const { queue, broker } = queueFor();
    assert.equal(await queue.pausedAt("r1"), null);
    await queue.pause("r1", { caseId: "c1", stepId: "n2" });
    assert.deepEqual(await queue.pausedAt("r1"), { caseId: "c1", stepId: "n2" });
    assert.equal(broker.kv.data.get("run:paused:r1")?.ttlSeconds, 3600);
    await queue.pause("r1", null);
    assert.equal(await queue.pausedAt("r1"), null);
    assert.equal(broker.kv.data.has("run:paused:r1"), false);
  });

  test("reanudar se toma una sola vez, y solo si es un modo que se conoce", async () => {
    const { queue, broker } = queueFor();
    assert.equal(await queue.takeResume("r1"), null, "sin orden, nada");

    await queue.resume("r1", "step");
    assert.equal(broker.kv.data.get("run:resume:r1")?.ttlSeconds, 3600);
    assert.equal(await queue.takeResume("r1"), "step");
    assert.equal(await queue.takeResume("r1"), null, "tomada, ya no está");

    await queue.resume("r1", "continue");
    assert.equal(await queue.takeResume("r1"), "continue");

    // Algo que no es un modo —otra versión, alguien a mano— se consume y no se obedece.
    await broker.kv.set("run:resume:r1", "rewind", "EX", 3600);
    assert.equal(await queue.takeResume("r1"), null);
    assert.equal(broker.kv.data.has("run:resume:r1"), false);
  });

  test("al apagar cierra el trabajador y la cola; sin nada abierto, no hace nada", async () => {
    await new RedisRunQueue(URL, `vacía-${randomUUID()}`).onModuleDestroy();

    const { queue, broker } = queueFor();
    queue.process(async () => undefined);
    await eventually(() => broker.workers.length === 1, "el trabajador");
    await queue.enqueue("r1");
    await queue.onModuleDestroy();
    assert.ok(broker.workers[0] instanceof FakeWorker);
    assert.equal(broker.workers[0].closed, true);
    assert.ok(broker.queues[0] instanceof FakeQueue);
    assert.equal(broker.queues[0].closed, true);

    // Solo con cola (sin trabajador): cierra la cola.
    const other = queueFor();
    await other.queue.enqueue("r1");
    await other.queue.onModuleDestroy();
    assert.equal(other.broker.queues[0].closed, true);
  });
});
