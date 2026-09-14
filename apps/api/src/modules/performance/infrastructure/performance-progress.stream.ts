import { Injectable } from "@nestjs/common";
import { Observable, Subject, filter, map } from "rxjs";

import type { PerformanceRunStatus } from "../domain/model";

/** What a subscriber to a run's stream receives: a periodic tick while it runs, and one final
 * event that closes the stream. */
export type PerformanceProgressEvent = {
  runId: string;
  type: "progress" | "finished";
  status: PerformanceRunStatus;
  progress: { elapsedS: number; totalS: number; requests: number; vus: number };
};

/**
 * The live timeline, as a hot subject filtered per run.
 *
 * Same design as the security stream: one subject for the process, `forRun` narrows it to a run and
 * shapes each event for `@Sse`. The executor publishes a tick roughly once a second so the chart
 * grows while the load runs, and one `finished` event so the client stops without polling.
 */
@Injectable()
export class PerformanceProgressStream {
  private readonly events = new Subject<PerformanceProgressEvent>();

  publish(event: PerformanceProgressEvent): void {
    this.events.next(event);
  }

  forRun(runId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.runId === runId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
