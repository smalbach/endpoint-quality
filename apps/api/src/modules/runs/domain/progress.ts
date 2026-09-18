/**
 * Live progress, and how it crosses a process boundary.
 *
 * A run executes on one API instance and is watched from whichever instance the follower's
 * connection landed on. With one process those are always the same and there is nothing to solve;
 * with two behind a load balancer they are the same only half the time. What closes the gap is the
 * instance bus (`@/shared/bus`), whose in-memory adapter is exactly the single-process deployment.
 */
export type ProgressEvent = {
  runId: string;
  type: "started" | "case" | "retrying" | "paused" | "resumed" | "finished";
  payload: unknown;
};

/** El tema del bus por el que viaja. */
export const RUN_PROGRESS_TOPIC = "run.progress";
