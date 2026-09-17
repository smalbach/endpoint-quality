import type { Assertion, FailureKind, OrderMode } from "@eq/runner-core";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";
export type CaseStatus = "queued" | "running" | "passed" | "failed" | "skipped";

/** What a run was asked to do. Stored with the run so a result can be read a month later without
 * guessing which subset it covered. */
export type RunPlan = {
  order: OrderMode;
  customOrder: string[];
  /** The operations to include. Empty means every one the contract declares. */
  operationIds: string[];
  /** Own labels to select by. Empty means «no filtres por etiqueta»; with both this and
   * `operationIds`, the two narrow together. Optional because runs written before it exists have
   * no such field, and a plan read back without one is a plan that filtered by nothing. */
  labels?: string[];
  caseSelection: Record<string, string[]>;
  samples: number;
  /** Pause between cases. Not a nicety: some targets rate-limit, and a matrix of 311 cases fired
   * flat out is indistinguishable from an attack. */
  delayMs: number;
  /**
   * How many steps of a flow may be in flight at once. `1` — the default — walks them one at a
   * time, which is what every run did before this existed.
   *
   * Only steps with no path between them ever run together, and what makes that safe is checked
   * when the flow is saved: two of them cannot capture the same variable, and the step that
   * obtains a session is a barrier. Without those rules this number would silently turn a
   * correct flow into a race.
   */
  concurrency?: number;
  /** When set, the run executes this project-defined graph instead of the generated matrix. */
  workflowId?: string;
  /** With a `workflowId`, the flow is walked once per row of this dataset, and the row's columns
   * are spendable as `{{dataset.name}}`. */
  datasetId?: string;
  /** When set, the run walks every flow of the suite in order. Exclusive with `workflowId`: a run
   * executes the matrix, one flow, or a list of them, and «both» has no meaning. */
  suiteId?: string;
  /**
   * Whether the worker stops and waits for a person before a step. `none` — the default, and every
   * run written before this existed — never waits. `step` waits before every step; `breakpoints`
   * only before the steps listed in `breakpoints`. A wait is released one step at a time or all
   * the way (see {@link ResumeMode}), and a run left waiting long enough is cancelled.
   *
   * At a step boundary and never inside one, for the same reason cancelling is: a pause between
   * the POST and the DELETE of a case is a created row nobody cleans up if the person walks away.
   */
  pauseMode?: PauseMode;
  /** The step ids `breakpoints` waits before. Ignored by the other modes. */
  breakpoints?: string[];
  /** The first step that fails ends the flow, and what had not run yet is marked skipped. Same as
   * setting `onError: stop` on every step — except the ones that say `continue`, which keep their
   * author's word. */
  stopOnFailure?: boolean;
};

export type PauseMode = "none" | "step" | "breakpoints";
/** `step` lets one step through and waits again before the next; `continue` stops waiting for the
 * rest of the run. */
export type ResumeMode = "step" | "continue";
/** Where a waiting run stopped: the case about to execute and, on a flow, its node. */
export type RunPause = { caseId: string; stepId: string | null };

export type Run = {
  id: string;
  projectId: string;
  environmentId: string | null;
  specVersionId: string;
  status: RunStatus;
  plan: RunPlan;
  totals: RunTotals;
  /**
   * Quién la pidió. `monitor` se añadió con los monitores, y `triggeredBy` es entonces el id del
   * monitor: una corrida que nadie lanzó no la lanzó un usuario, y decir que sí sería mentir en el
   * historial de quién tocó qué.
   */
  triggeredByKind: "user" | "api-token" | "monitor";
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
};

export type RunTotals = { cases: number; completed: number; passed: number; failed: number; skipped: number };

export type RunCase = {
  id: string;
  runId: string;
  /** Whose problem it is. Null while it passed, was skipped, or has not run. */
  failure: FailureKind | null;
  operationId: string;
  scenarioId: string;
  method: string;
  path: string;
  status: CaseStatus;
  position: number;
  durationMs: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/**
 * A step's three payloads, typed.
 *
 * They were `unknown` because they are `jsonb` columns and the domain did not want to know their
 * shape. The cost showed up the day the browser's copy of these types said `request` was always
 * present and the API had started answering null: `unknown` is assignable to anything, so no
 * compiler anywhere was in a position to notice. The jsonb boundary is the repository's problem,
 * and the repository is where the cast now lives.
 */
export type StepRequestRecord = { method: string; url: string; headers: Record<string, string>; body: unknown };
export type StepExpectation = { status: number; shape: string; operationPath: string };
export type StepResult = { status: number; contentType: string; headers: Record<string, string>; body: unknown };
export type StepLatency = { samples: number[]; budgetMs: number | null };

export type RunStep = {
  id: string;
  runCaseId: string;
  index: number;
  purpose: string;
  label: string;
  /** Null once a retention sweep has emptied it — see `prunedAt`, which is what separates that
   * from a step that never got a response. */
  request: StepRequestRecord | null;
  expected: StepExpectation | null;
  actual: StepResult | null;
  assertions: Assertion[];
  latency: StepLatency | null;
  ok: boolean;
  durationMs: number;
  /** Set when a retention sweep emptied `request`, `expected` and `actual`. A reader that cannot
   * tell this from «nothing came back» eventually reports an old step as a timeout. */
  prunedAt?: Date | null;
};

export const isFinished = (status: RunStatus): boolean => ["passed", "failed", "cancelled", "error"].includes(status);

/**
 * The verdict of a finished run.
 *
 * A run with skipped cases and no failures still **passes**: a case the environment refused to
 * run — a write against a read-only target — is not a finding about the API, and reporting it as
 * one would train people to ignore red.
 */
/**
 * A case with no steps ran nothing — the environment refused every request in it — and is
 * `skipped`, not `failed`. Reporting it as a finding would train people to ignore red.
 *
 * One function because there are two walks, the generated matrix and a user-authored flow, and
 * they had drifted: the same empty case was `skipped` in one and `failed` in the other.
 */
export const caseStatusFor = (executed: { ok: boolean; steps: unknown[] }): CaseStatus =>
  executed.steps.length === 0 ? "skipped" : executed.ok ? "passed" : "failed";

/**
 * Whose problem a red case is: the kind of the **first** step that did not hold.
 *
 * The first and not the worst, because a flow stops meaning anything after its first failure — a
 * `create-read` whose POST never happened reports the read as broken too, and filing the case
 * under the second failure would name the consequence instead of the cause.
 */
export const failureFor = (executed: { steps: { ok: boolean; failure: FailureKind | null }[] }): FailureKind | null =>
  executed.steps.find((step) => !step.ok)?.failure ?? null;

export function verdictFor(totals: RunTotals): RunStatus {
  return totals.failed > 0 ? "failed" : "passed";
}

/**
 * One request sent on purpose, answered, judged — and not recorded.
 *
 * The gap it fills: until now the only way to make this product touch an API was to start a run,
 * and a run is a matrix, a history row and a verdict. Somebody writing a step wants to know
 * whether *this* request works, and the loop «guardar, lanzar, esperar, abrir el caso» is long
 * enough that people go and use another tool for it — then come back with a request that works
 * there and not here, and no way to compare the two.
 *
 * It is deliberately **not** a `Run`: nothing is queued, nothing is stored, no totals move. What
 * makes it worth trusting is the opposite — that it goes through the same executor, the same
 * credentials and the same `writesAllowed` as the run it is rehearsing.
 */
export type RequestPreview = {
  ok: boolean;
  failure: FailureKind | null;
  /** What was sent, credentials masked, exactly as a stored step records it. */
  request: StepRequestRecord;
  expected: StepExpectation;
  /** `null` when nothing answered: the target refused the connection, or the request never left
   * because a variable was unresolved or the environment forbids writes. The assertions say which. */
  response: (StepResult & { sizeBytes: number }) | null;
  assertions: Assertion[];
  latency: StepLatency;
  durationMs: number;
};
