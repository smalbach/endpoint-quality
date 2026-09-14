import type { PerformancePlanRow, PerformanceRun } from "./model";

export const PERFORMANCE_PLAN_REPOSITORY = Symbol("PERFORMANCE_PLAN_REPOSITORY");
export const PERFORMANCE_RUN_REPOSITORY = Symbol("PERFORMANCE_RUN_REPOSITORY");
export const PERFORMANCE_RUN_QUEUE = Symbol("PERFORMANCE_RUN_QUEUE");

/**
 * Every read takes `projectId`, including the ones that already have a primary key — the same rule
 * the workflows repository follows, so «run plan X» cannot reach another tenant's plan by id alone.
 */
export interface PerformancePlanRepositoryPort {
  list(projectId: string): Promise<PerformancePlanRow[]>;
  find(projectId: string, planId: string): Promise<PerformancePlanRow | null>;
  findByName(projectId: string, name: string): Promise<PerformancePlanRow | null>;
  save(row: PerformancePlanRow): Promise<void>;
  delete(projectId: string, planId: string): Promise<void>;
}

export interface PerformanceRunRepositoryPort {
  list(projectId: string, planId?: string): Promise<PerformanceRun[]>;
  find(projectId: string, runId: string): Promise<PerformanceRun | null>;
  /** By id alone, for the executor: the queue carries a run id and no tenant. Not exposed by any
   * route — every controller path resolves the project first. */
  findById(runId: string): Promise<PerformanceRun | null>;
  save(run: PerformanceRun): Promise<void>;
  delete(projectId: string, runId: string): Promise<void>;
}

/** The same single-instance queue shape security-runs uses: one run at a time, cancellable at the
 * next boundary the executor checks — never mid-request. */
export interface PerformanceRunQueuePort {
  enqueue(runId: string): Promise<void>;
  process(handler: (runId: string) => Promise<void>): void;
  cancel(runId: string): Promise<void>;
  isCancelled(runId: string): boolean;
}
