import type { Assertion, OrderMode } from "@eq/runner-core";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";
export type CaseStatus = "queued" | "running" | "passed" | "failed" | "skipped";

/** What a run was asked to do. Stored with the run so a result can be read a month later without
 * guessing which subset it covered. */
export type RunPlan = {
  order: OrderMode;
  customOrder: string[];
  /** The operations to include. Empty means every one the contract declares. */
  operationIds: string[];
  caseSelection: Record<string, string[]>;
  samples: number;
  /** Pause between cases. Not a nicety: some targets rate-limit, and a matrix of 311 cases fired
   * flat out is indistinguishable from an attack. */
  delayMs: number;
  /** When set, the run executes this project-defined graph instead of the generated matrix. */
  workflowId?: string;
  /** With a `workflowId`, the flow is walked once per row of this dataset, and the row's columns
   * are spendable as `{{dataset.name}}`. */
  datasetId?: string;
  /** When set, the run walks every flow of the suite in order. Exclusive with `workflowId`: a run
   * executes the matrix, one flow, or a list of them, and «both» has no meaning. */
  suiteId?: string;
};

export type Run = {
  id: string;
  projectId: string;
  environmentId: string | null;
  specVersionId: string;
  status: RunStatus;
  plan: RunPlan;
  totals: RunTotals;
  triggeredByKind: "user" | "api-token";
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
};

export type RunTotals = { cases: number; completed: number; passed: number; failed: number; skipped: number };

export type RunCase = {
  id: string;
  runId: string;
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

export function verdictFor(totals: RunTotals): RunStatus {
  return totals.failed > 0 ? "failed" : "passed";
}
