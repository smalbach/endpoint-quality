import type { SecurityRun } from "./model";

export const SECURITY_RUN_REPOSITORY = Symbol("SECURITY_RUN_REPOSITORY");

export interface SecurityRunRepositoryPort {
  /** Newest first. */
  listForProject(projectId: string, limit: number): Promise<SecurityRun[]>;
  findById(id: string): Promise<SecurityRun | null>;
  /** Only a public run answers here, by its share token — the anonymous read. */
  findByShareToken(shareToken: string): Promise<SecurityRun | null>;
  save(run: SecurityRun): Promise<void>;
  remove(id: string): Promise<void>;
}

export const SECURITY_RUN_QUEUE = Symbol("SECURITY_RUN_QUEUE");

/**
 * Where a security run waits to be executed.
 *
 * Only the id travels: the worker reads everything else — the environment, its stored credentials,
 * the endpoints, the roles — from the repositories. The credentials are never in the request nor in
 * the row; they live encrypted on the environment and are decrypted only in the worker's memory,
 * which is the whole reason phase 5 put them there.
 */
export interface SecurityRunQueuePort {
  enqueue(runId: string): Promise<void>;
  process(handler: (runId: string) => Promise<void>): void;
  /** Stops the run at the next probe boundary; a probe mid-flight is not interrupted. */
  cancel(runId: string): Promise<void>;
  isCancelled(runId: string): boolean;
}
