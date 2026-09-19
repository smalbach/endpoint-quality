/**
 * Loose ends of the runs module and the script sandbox: a notify node whose webhook variable is not
 * a URL at all, the worker's own sanitising of what a script hands back, and the sandbox's outer
 * deadline for a script process that never answers.
 */
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";

import { sendNotification } from "@/modules/runs/infrastructure/notify-step";
import type { ExecutionTarget } from "@/modules/runs/infrastructure/case-executor";
import type { SafeFetchPort } from "@/shared/http/safe-fetch";
import { SCRIPT_LIMITS, sanitizeOutcome } from "@/shared/scripts/script-sandbox";
import { ProcessScriptSandbox } from "@/shared/scripts/process-script-sandbox";

const target = (variables: Record<string, string>): ExecutionTarget => ({
  baseUrl: "http://api.test",
  writesAllowed: true,
  spec: null,
  specError: "sin contrato",
  credentials: [],
  variables,
  session: null,
  cookies: [],
});

describe("el nodo notificar con una variable que no es una URL", () => {
  test("falla como configuración sin enviar nada, y el valor no aparece en lo guardado", async () => {
    const calls: string[] = [];
    const http = { request: async (url: string) => (calls.push(url), null) } as unknown as SafeFetchPort;
    const outcome = await sendNotification(http, {
      notify: { channel: "slack", urlVariable: "HOOK", message: "Aviso para {{HOOK}}" },
      target: target({ HOOK: "valor secreto sin esquema" }),
      origin: { runId: "run-1", workflowId: "wf-1", stepId: "avisa" },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, "config");
    assert.deepEqual(outcome.assertions, [
      { label: "URL del webhook", pass: false, detail: "La variable «HOOK» no contiene una URL válida" },
    ]);
    assert.equal(calls.length, 0);
    assert.equal(outcome.sent.url, "{{HOOK}}");
    assert.doesNotMatch(JSON.stringify(outcome.sent), /valor secreto sin esquema/);
  });
});

describe("lo que el proceso del script devuelve, saneado", () => {
  test("un log sin texto y un test sin nombre quedan en cadena vacía", () => {
    const outcome = sanitizeOutcome({ logs: [{ level: "warn" }], tests: [{ passed: true }] }, 7);
    assert.deepEqual(outcome.logs, [{ level: "warn", text: "" }]);
    assert.deepEqual(outcome.tests, [{ name: "", passed: true, message: null }]);
    assert.equal(outcome.durationMs, 7);
  });

  test("una visualización cuyos datos no son JSON se descarta", () => {
    const broken = sanitizeOutcome({ visualization: { template: "<p>{{a}}</p>", data: "{roto" } }, 1);
    assert.equal(broken.visualization, null);
    const fine = sanitizeOutcome({ visualization: { template: "<p>{{a}}</p>", data: '{"a":1}' } }, 1);
    assert.deepEqual(fine.visualization, { template: "<p>{{a}}</p>", data: '{"a":1}', options: "{}" });
  });
});

describe("el proceso del script que no contesta", () => {
  test("al pasar el tiempo total se da por fallido y se mata el proceso", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const sandbox = new ProcessScriptSandbox();
      const pending = sandbox.run({
        phase: "post",
        code: "1",
        environment: { name: null, values: {} },
        variables: {},
        request: { method: "GET", url: "http://api.test", headers: {}, body: null },
        response: null,
      });
      // `run` forks after acquiring its slot, a few microtasks in; the outer timer exists by then.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      mock.timers.tick(SCRIPT_LIMITS.totalMs);
      const outcome = await pending;
      assert.equal(outcome.error, `El script tardó más de ${SCRIPT_LIMITS.totalMs / 1000} s y se detuvo`);
      assert.deepEqual(outcome.logs, []);
      assert.deepEqual(outcome.tests, []);
    } finally {
      mock.timers.reset();
    }
  });
});
