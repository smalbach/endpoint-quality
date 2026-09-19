/**
 * The orchestrator's last edges: a flow deleted between queueing and executing, a graph where
 * nothing can ever become ready, and a pause nobody comes back to within the half hour.
 */
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "@nestjs/common";
import type { WorkflowStep } from "@eq/runner-core";

import { RunFinishedEvent, RunPausedEvent } from "@/modules/runs/application/events/run.events";
import { caseOf, execute, fetchStep, harness, saveFlow } from "@test/support/c100-runs-orchestrator";

describe("una corrida que ya no se puede preparar", () => {
  test("un flujo borrado entre encolar y ejecutar deja la corrida en error y lo dice", async () => {
    const h = harness();
    const run = await execute(h, { workflowId: "flujo-borrado" });
    assert.equal(run.status, "error");
    assert.equal(run.error, 'El flujo "flujo-borrado" ya no existe');
    assert.equal(h.executor.calls.length, 0);
    const finished = h.events.find((event) => event instanceof RunFinishedEvent) as RunFinishedEvent;
    assert.equal(finished.status, "error");
  });
});

describe("un grafo donde nada puede quedar listo", () => {
  test("termina en vez de colgarse, y lo que no pudo empezar se queda en cola", async () => {
    const h = harness();
    // A graph the schema refuses — a retry node that also waits for a step that waits for it — but
    // which the walk must survive if one ever reaches it: `sigue` waits for the retry node's verdict
    // on `origen`, and the retry node waits for `sigue`.
    const flow = await saveFlow(h, [
      fetchStep("origen", "/origen"),
      fetchStep("sigue", "/sigue", { dependsOn: ["origen"] }),
      {
        id: "reintenta",
        kind: "retry",
        dependsOn: ["origen", "sigue"],
        rerun: { from: "origen", target: "origen", attempts: 1, delayMs: 0 },
      } as WorkflowStep,
    ]);
    const run = await execute(h, { workflowId: flow });

    assert.deepEqual(
      h.executor.calls.map((call) => call.url),
      ["/origen"],
    );
    assert.equal((await caseOf(h, run, "origen")).status, "passed");
    assert.equal((await caseOf(h, run, "sigue")).status, "queued");
    assert.equal((await caseOf(h, run, "reintenta")).status, "queued");
    assert.equal(run.status, "passed");
    assert.ok(run.finishedAt);
  });
});

describe("una pausa que nadie reanuda", () => {
  test("a los 30 minutos se cancela la corrida, lo registra y deja la pausa limpia", async () => {
    const h = harness();
    const flow = await saveFlow(h, [fetchStep("uno", "/uno")]);
    const warnings: string[] = [];
    const logger = (h.orchestrator as unknown as { logger: Logger }).logger;
    mock.method(logger, "warn", (message: string) => warnings.push(message));

    // The clock the wait reads jumps past its deadline while the run is paused, so the half hour
    // passes in one poll instead of in real time.
    const start = Date.now();
    let offset = 0;
    const now = mock.method(Date, "now", () => start + offset);
    const takeResume = h.queue.takeResume.bind(h.queue);
    h.queue.takeResume = async () => {
      if (h.queue.paused) offset += 30 * 60_000 + 1;
      return takeResume();
    };

    try {
      const run = await execute(h, { workflowId: flow, pauseMode: "step" });
      assert.equal(run.status, "cancelled");
      assert.equal(h.executor.calls.length, 0, "no llegó a ejecutar el paso");
      assert.equal(h.queue.paused, null, "la pausa se retiró al cancelar");
      assert.ok(h.events.some((event) => event instanceof RunPausedEvent));
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0], `Corrida ${run.id}: nadie la reanudó en 30 min; se cancela`);
    } finally {
      now.mock.restore();
    }
  });
});
