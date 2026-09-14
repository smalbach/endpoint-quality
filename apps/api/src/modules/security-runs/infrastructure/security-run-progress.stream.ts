import { Injectable } from "@nestjs/common";
import { Subject, filter, map, type Observable } from "rxjs";

export type SecurityProgressEvent = {
  runId: string;
  type: "progress" | "finished";
  status: string;
  progress: { phase: string; percentage: number; detail: string; endpointsTested: number; endpointsTotal: number };
  score?: number | null;
  risk?: string | null;
};

/**
 * Live progress of a security run, one hot subject filtered per run.
 *
 * Per process, like the contract runs' stream — enough for the single-instance deployment this runs
 * in, and a follower that reconnects reads the current row instead. No relay yet: security runs do
 * not run on the Redis queue.
 */
@Injectable()
export class SecurityRunProgressStream {
  private readonly events = new Subject<SecurityProgressEvent>();

  publish(runId: string, event: Omit<SecurityProgressEvent, "runId">): void {
    this.events.next({ runId, ...event });
  }

  forRun(runId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.runId === runId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
