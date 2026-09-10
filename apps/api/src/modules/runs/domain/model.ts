import type { OrderMode } from "@eq/runner-core";

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

export type RunStep = {
  id: string;
  runCaseId: string;
  index: number;
  purpose: string;
  label: string;
  request: unknown;
  expected: unknown;
  actual: unknown;
  assertions: unknown;
  latency: unknown;
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
export function verdictFor(totals: RunTotals): RunStatus {
  return totals.failed > 0 ? "failed" : "passed";
}
