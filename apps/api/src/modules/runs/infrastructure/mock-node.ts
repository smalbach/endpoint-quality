/**
 * The case a `mock` node leaves: one step row that reads like a request's, with the simulated answer
 * where a real one would be.
 *
 * Kept out of the orchestrator because none of it touches the walk — it is what the node answers and
 * what the report says about it. The orchestrator stores the response it returns for the nodes after
 * it and closes the case.
 *
 * The report has to say, first and in words, that nothing was called: a green case over a response
 * nobody sent is exactly the result a reader would otherwise take for a service that works.
 */
import {
  applyCaptures,
  evaluateChecks,
  holds,
  simulateMock,
  type ActualResponse,
  type Assertion,
  type ComputedSeed,
  type RuntimeVariables,
  type StepMock,
  type StepRequest,
  type WorkflowStep,
} from "@eq/runner-core";

import type { RunCase } from "../domain/model";
import type { ExecutedStep } from "./case-executor";

export function mockStep(
  step: WorkflowStep,
  mock: StepMock,
  runCase: RunCase,
  variables: RuntimeVariables,
  options: { seed: ComputedSeed; secrets: string[] },
): { executed: ExecutedStep; actual: ActualResponse | null } {
  const durationMs = mock.delayMs ?? 0;
  const request: StepRequest = {
    index: 0,
    purpose: "act",
    label: "Mock",
    operationId: "",
    method: runCase.method,
    operationPath: runCase.path,
    requestPath: "",
    expectedStatus: mock.status,
    expectedShape: "",
    auth: "none",
    samples: 1,
  };
  // The templates as written, not resolved: a value pulled from the environment may be a secret.
  const sent: ExecutedStep["sent"] = {
    method: "MOCK",
    url: String(mock.status),
    headers: mock.headers ?? {},
    body: mock.body ?? null,
  };
  const base = { request, sent, durationMs, latency: { samples: [], budgetMs: null } };

  const simulated = simulateMock(mock, variables, options.seed);
  if (!simulated.ok) {
    return {
      executed: {
        ...base,
        ok: false,
        failure: "config",
        actual: null,
        assertions: [{ label: "Respuesta simulada", pass: false, detail: `Mock sin petición de red: ${simulated.problem}` }],
      },
      actual: null,
    };
  }

  const { actual } = simulated;
  const checks = evaluateChecks(step.checks ?? [], { response: actual, durationMs });
  const assertions: Assertion[] = [
    {
      label: "Respuesta simulada",
      pass: true,
      detail: `Mock: ${mock.status} escrito en el nodo${durationMs ? ` tras ${durationMs} ms` : ""}. No se hizo ninguna petición de red.`,
    },
    ...checks,
  ];
  let captured = true;
  if (step.captures?.length) {
    const capture = applyCaptures(step.captures, actual, variables, step.id);
    captured = capture.missing.length === 0;
    assertions.push({
      label: "Variables capturadas",
      pass: captured,
      detail: captured ? capture.captured.join(", ") : `No se encontraron: ${capture.missing.join(", ")}`,
    });
  }
  const ok = holds(assertions);
  return {
    executed: {
      ...base,
      ok,
      // A check that does not hold is the author's claim failing; a capture with nothing to read is
      // the flow's.
      failure: ok ? null : !holds(checks) || captured ? "check" : "flow",
      actual: redacted(actual, options.secrets),
      assertions,
    },
    actual,
  };
}

/**
 * The copy of the answer the report stores, with the environment's secrets masked. A template can
 * pull `{{apiKey}}` into a mock body, and the report is readable by people the reveal button refuses.
 * The unmasked answer is still what the nodes after it read.
 */
function redacted(actual: ActualResponse, secrets: string[]): ActualResponse {
  const hidden = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
  if (!hidden.length) return actual;
  const text = (value: string) => hidden.reduce((result, secret) => result.split(secret).join("••••••••"), value);
  const deep = (value: unknown): unknown =>
    typeof value === "string"
      ? text(value)
      : Array.isArray(value)
        ? value.map(deep)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), deep(item)]))
          : value;
  return {
    ...actual,
    headers: deep(actual.headers) as Record<string, string>,
    body: deep(actual.body),
    raw: text(actual.raw),
  };
}
