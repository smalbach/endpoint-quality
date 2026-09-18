/**
 * Live progress when the run and the follower are on different instances.
 *
 * With `QUEUE_DRIVER=redis` a run is executed by whichever instance took the job and watched from
 * whichever one the load balancer handed the browser. Those match by luck. When they did not, the
 * events went into a subject nobody on that instance was listening to and the progress screen sat
 * still until the polling fallback — which exists for a dropped connection, not for the normal
 * case.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  RunCaseProjector,
  RunCaseStartedProjector,
  RunProgressStream,
} from "@/modules/runs/infrastructure/run-progress.stream";
import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { RunCaseFinishedEvent, RunCaseStartedEvent } from "@/modules/runs/application/events/run.events";
import type { RunCase, RunTotals } from "@/modules/runs/domain/model";
import type { ProgressEvent } from "@/modules/runs/domain/progress";

/** Two API processes on one bus, as a hosted deployment behind a load balancer. */
function twoInstances() {
  const hub = new InMemoryBusHub();
  const busA = new InMemoryInstanceBus(hub, "a");
  const busB = new InMemoryInstanceBus(hub, "b");
  const instanceA = new RunProgressStream(busA);
  const instanceB = new RunProgressStream(busB);
  return { instanceA, instanceB, busA, busB };
}

/** Lo que va a otra instancia llega en un turno posterior, como por Redis. */
const crossed = () => new Promise((resolve) => setImmediate(resolve));

const collect = (stream: RunProgressStream, runId: string) => {
  const seen: ProgressEvent[] = [];
  stream.forRun(runId).subscribe((event) => seen.push(event));
  return seen;
};

describe("progreso en vivo", () => {
  test("un seguidor conectado a otra instancia ve la corrida", async () => {
    const { instanceA, instanceB } = twoInstances();
    const watching = collect(instanceB, "run-1");

    instanceA.publish({ runId: "run-1", type: "case", payload: { case: 1 } });
    await crossed();

    assert.equal(watching.length, 1);
    assert.equal(watching[0].type, "case");
  });

  test("y quien está en la misma instancia lo ve una sola vez", async () => {
    // Un relé que entregara de vuelta lo que él mismo publicó pintaría cada caso dos veces.
    const { instanceA } = twoInstances();
    const watching = collect(instanceA, "run-1");

    instanceA.publish({ runId: "run-1", type: "case", payload: {} });
    assert.equal(watching.length, 1, "lo local llega en el acto, sin esperar a la red");
    await crossed();

    assert.equal(watching.length, 1);
  });

  test("lo que llega de fuera no se vuelve a retransmitir", async () => {
    // Sin esto, dos instancias se reenvían el mismo evento sin parar.
    const { instanceA, instanceB } = twoInstances();
    const onA = collect(instanceA, "run-1");
    const onB = collect(instanceB, "run-1");

    instanceB.publish({ runId: "run-1", type: "case", payload: {} });
    for (let turn = 0; turn < 5; turn++) await crossed();

    assert.equal(onA.length, 1, "un evento que ya dio un salto no da otro");
    assert.equal(onB.length, 1);
  });

  test("cada seguidor recibe solo su corrida", async () => {
    const { instanceA, instanceB } = twoInstances();
    const suya = collect(instanceB, "run-1");
    const ajena = collect(instanceB, "run-2");

    instanceA.publish({ runId: "run-1", type: "finished", payload: {} });
    await crossed();

    assert.equal(suya.length, 1);
    assert.equal(ajena.length, 0);
  });

  test("el caso que empieza se anuncia como 'case' sin totales; el que termina sí los trae", () => {
    const stream = new RunProgressStream();
    const seen = collect(stream, "run-1");

    const runCase = { id: "c1", status: "running", position: 0 } as unknown as RunCase;
    new RunCaseStartedProjector(stream).handle(new RunCaseStartedEvent("p1", "run-1", runCase));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "case");
    const startedPayload = seen[0].payload as { case: RunCase; totals?: RunTotals };
    assert.equal(startedPayload.case.id, "c1");
    assert.equal(startedPayload.totals, undefined, "empezar no completa nada, así que no redibuja la barra");

    const totals: RunTotals = { cases: 1, completed: 1, passed: 1, failed: 0, skipped: 0 };
    const done = { ...runCase, status: "passed" } as unknown as RunCase;
    new RunCaseProjector(stream).handle(new RunCaseFinishedEvent("p1", "run-1", done, totals));

    assert.equal(seen.length, 2);
    const finishedPayload = seen[1].payload as { case: RunCase; totals?: RunTotals };
    assert.deepEqual(finishedPayload.totals, totals);
  });

  test("con un solo proceso basta el bus en memoria, y lo entrega en el acto", async () => {
    // Una instalación de un solo proceso no abre un cliente de Redis que no va a usar.
    const stream = new RunProgressStream();
    const watching = collect(stream, "run-1");

    stream.publish({ runId: "run-1", type: "started", payload: { cases: 3 } });

    assert.equal(watching.length, 1);
  });
});
