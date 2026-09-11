import type { RunCase, RunStatus, RunTotals } from "../../domain/model";

/** Published as the run walks. They feed the SSE stream and, later, whatever wants to react to a
 * red matrix — a webhook, a CI exit code, a notification. */
export class RunStartedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly cases: number,
  ) {}
}
export class RunCaseFinishedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly runCase: RunCase,
    readonly totals: RunTotals,
  ) {}
}
/**
 * A step that failed and is about to try again.
 *
 * The only thing a run does that takes time and produces nothing to look at: with a backoff of a
 * few seconds, a case sits on `running` and a follower cannot tell it apart from a request that
 * hung. Saying so costs one event and is the difference between «esto no avanza» and «está
 * esperando 4 s antes del intento 3».
 *
 * It carries no totals: nothing finished, and sending the ones from before would make the
 * progress bar redraw itself for no reason.
 */
export class RunCaseRetryingEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly runCaseId: string,
    readonly attempt: number,
    readonly attempts: number,
    readonly waitMs: number,
  ) {}
}

export class RunFinishedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly status: RunStatus,
    readonly totals: RunTotals,
  ) {}
}
