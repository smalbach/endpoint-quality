import type { ResumeMode, RunCase, RunPause, RunStatus, RunTotals } from "../../domain/model";

/** Published as the run walks. They feed the SSE stream and, later, whatever wants to react to a
 * red matrix — a webhook, a CI exit code, a notification. */
export class RunStartedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly cases: number,
  ) {}
}
/**
 * A case that just started executing.
 *
 * Without it a follower learns a case exists as `queued` from the opening snapshot and next hears
 * of it already `passed` — the moment it was the one running, the thing the user came to watch, went
 * unsaid. The row is persisted `running` either way; this only makes the transition visible live.
 *
 * It carries no totals: starting a case completes nothing, so sending the same totals again would
 * redraw the progress bar for no reason.
 */
export class RunCaseStartedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly runCase: RunCase,
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

/** A run waiting for a person before the case in `at`. Nothing is in flight that it started. */
export class RunPausedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly at: RunPause,
  ) {}
}

/** The wait is over; the case it was holding starts next. */
export class RunResumedEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly how: ResumeMode,
  ) {}
}

/**
 * Un nodo webhook espera su llamada de fuera. **Sin la URL**: el evento cruza el bus entre instancias,
 * y el token no tiene por qué viajar por él. Quien sigue la corrida vuelve a pedirla y la URL llega en
 * `hooks`, calculada en la instancia que contesta. El evento del caso que la termina viene después.
 */
export class RunHookWaitingEvent {
  constructor(
    readonly projectId: string,
    readonly runId: string,
    readonly hook: { caseId: string; stepId: string; method: "POST" | "PUT"; expiresAt: string },
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
