import type { RunCase, RunStatus, RunTotals } from "../../domain/model";

/** Published as the run walks. They feed the SSE stream and, later, whatever wants to react to a
 * red matrix — a webhook, a CI exit code, a notification. */
export class RunStartedEvent {
  constructor(readonly projectId: string, readonly runId: string, readonly cases: number) {}
}
export class RunCaseFinishedEvent {
  constructor(readonly projectId: string, readonly runId: string, readonly runCase: RunCase, readonly totals: RunTotals) {}
}
export class RunFinishedEvent {
  constructor(readonly projectId: string, readonly runId: string, readonly status: RunStatus, readonly totals: RunTotals) {}
}
