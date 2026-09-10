import type { Run, RunCase, RunStatus, RunStep, RunTotals } from "./model";

export const RUN_REPOSITORY = Symbol("RUN_REPOSITORY");
export const RUN_QUEUE = Symbol("RUN_QUEUE");

export interface RunRepositoryPort {
  findById(id: string): Promise<Run | null>;
  listForProject(projectId: string, limit: number): Promise<Run[]>;
  save(run: Run): Promise<void>;
  saveCases(cases: RunCase[]): Promise<void>;
  listCases(runId: string): Promise<RunCase[]>;
  findCase(id: string): Promise<RunCase | null>;
  saveCase(runCase: RunCase): Promise<void>;
  saveSteps(steps: RunStep[]): Promise<void>;
  listSteps(runCaseId: string): Promise<RunStep[]>;
  /** Recomputed from the case rows rather than incremented in memory: a worker that restarts
   * mid-run must not lose the count, and two workers must not both add one. */
  recomputeTotals(runId: string): Promise<RunTotals>;
  updateStatus(runId: string, status: RunStatus, at: Date, error?: string): Promise<void>;
}

/**
 * Where a run waits to be executed.
 *
 * A port with two adapters because the two deployments have genuinely different needs: a hosted
 * instance wants Redis so a run survives a restart and several can proceed at once, and an
 * operator running this on a laptop should not have to install anything. `QUEUE_DRIVER` picks;
 * nothing else in the system knows which.
 */
export interface RunQueuePort {
  enqueue(runId: string): Promise<void>;
  /** Registered once at boot. The queue calls it with a run id and awaits it. */
  process(handler: (runId: string) => Promise<void>): void;
  /** Marks a run as cancelled so the worker stops at the next case boundary. Stopping mid-case
   * would leave a created resource with no cleanup step. */
  cancel(runId: string): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;
}
