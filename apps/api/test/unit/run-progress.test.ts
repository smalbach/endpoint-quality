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
import { InProcessRelay } from "@/modules/runs/infrastructure/progress/in-process-relay";
import { RunCaseFinishedEvent, RunCaseStartedEvent } from "@/modules/runs/application/events/run.events";
import type { RunCase, RunTotals } from "@/modules/runs/domain/model";
import type { ProgressEvent, ProgressRelayPort } from "@/modules/runs/domain/progress";

/** A channel two streams share, standing in for Redis pub/sub. It delivers to everyone *except*
 * the publisher, which is what the real adapter achieves by stamping and dropping its origin. */
class FakeChannel {
  private readonly relays: FakeRelay[] = [];
  attach(relay: FakeRelay): void {
    this.relays.push(relay);
  }
  broadcast(from: FakeRelay, event: ProgressEvent): void {
    for (const relay of this.relays) if (relay !== from) relay.deliver({ ...event, origin: "otra-instancia" });
  }
}

class FakeRelay implements ProgressRelayPort {
  private handler?: (event: ProgressEvent) => void;
  readonly published: ProgressEvent[] = [];
  constructor(private readonly channel: FakeChannel) {
    channel.attach(this);
  }
  publish(event: ProgressEvent): void {
    this.published.push(event);
    this.channel.broadcast(this, event);
  }
  subscribe(handler: (event: ProgressEvent) => void): void {
    this.handler = handler;
  }
  deliver(event: ProgressEvent): void {
    this.handler?.(event);
  }
}

/** Two API processes on one channel, as a hosted deployment behind a load balancer. */
function twoInstances() {
  const channel = new FakeChannel();
  const relayA = new FakeRelay(channel);
  const relayB = new FakeRelay(channel);
  const instanceA = new RunProgressStream(relayA);
  const instanceB = new RunProgressStream(relayB);
  instanceA.onApplicationBootstrap();
  instanceB.onApplicationBootstrap();
  return { instanceA, instanceB, relayA, relayB };
}

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

    assert.equal(watching.length, 1);
    assert.equal(watching[0].type, "case");
  });

  test("y quien está en la misma instancia lo ve una sola vez", async () => {
    // Un relé que entregara de vuelta lo que él mismo publicó pintaría cada caso dos veces.
    const { instanceA } = twoInstances();
    const watching = collect(instanceA, "run-1");

    instanceA.publish({ runId: "run-1", type: "case", payload: {} });

    assert.equal(watching.length, 1);
  });

  test("lo que llega de fuera no se vuelve a retransmitir", async () => {
    // Sin esto, dos instancias se reenvían el mismo evento sin parar.
    const { instanceA, relayA, relayB } = twoInstances();
    collect(instanceA, "run-1");

    relayA.deliver({ runId: "run-1", type: "case", payload: {}, origin: "otra" });

    assert.deepEqual(relayA.published, [], "un evento que ya dio un salto no da otro");
    assert.deepEqual(relayB.published, []);
  });

  test("cada seguidor recibe solo su corrida", async () => {
    const { instanceA, instanceB } = twoInstances();
    const suya = collect(instanceB, "run-1");
    const ajena = collect(instanceB, "run-2");

    instanceA.publish({ runId: "run-1", type: "finished", payload: {} });

    assert.equal(suya.length, 1);
    assert.equal(ajena.length, 0);
  });

  test("el caso que empieza se anuncia como 'case' sin totales; el que termina sí los trae", () => {
    const stream = new RunProgressStream(new InProcessRelay());
    stream.onApplicationBootstrap();
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

  test("con un solo proceso el relé no hace nada, y es lo correcto", async () => {
    // El sujeto en memoria ya alcanza a todos los seguidores que hay. Una instalación de un solo
    // proceso no abre un cliente de Redis que no va a usar.
    const stream = new RunProgressStream(new InProcessRelay());
    stream.onApplicationBootstrap();
    const watching = collect(stream, "run-1");

    stream.publish({ runId: "run-1", type: "started", payload: { cases: 3 } });

    assert.equal(watching.length, 1);
  });
});
