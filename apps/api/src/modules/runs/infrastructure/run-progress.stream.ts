import { Injectable } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { Subject, filter, type Observable } from "rxjs";

import { RunCaseFinishedEvent, RunFinishedEvent, RunStartedEvent } from "../application/events/run.events";

export type ProgressEvent = { runId: string; type: "started" | "case" | "finished"; payload: unknown };

/**
 * The bridge from domain events to whoever is watching.
 *
 * A single hot `Subject` filtered per run, rather than one stream per subscriber: a run publishes
 * an event per case, and building an observable chain per follower would multiply that by the
 * number of open tabs.
 *
 * It is **in-process**. With `QUEUE_DRIVER=redis` and more than one API instance, a follower
 * connected to instance B sees nothing from a run executing on instance A — the polling fallback
 * covers that today, and a Redis pub/sub relay is the fix when multi-instance becomes real.
 */
@Injectable()
export class RunProgressStream {
  private readonly events = new Subject<ProgressEvent>();

  publish(event: ProgressEvent): void {
    this.events.next(event);
  }

  forRun(runId: string): Observable<ProgressEvent> {
    return this.events.asObservable().pipe(filter((event) => event.runId === runId));
  }
}

@EventsHandler(RunStartedEvent)
export class RunStartedProjector implements IEventHandler<RunStartedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunStartedEvent): void {
    this.stream.publish({ runId: event.runId, type: "started", payload: { cases: event.cases } });
  }
}

@EventsHandler(RunCaseFinishedEvent)
export class RunCaseProjector implements IEventHandler<RunCaseFinishedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunCaseFinishedEvent): void {
    this.stream.publish({ runId: event.runId, type: "case", payload: { case: event.runCase, totals: event.totals } });
  }
}

@EventsHandler(RunFinishedEvent)
export class RunFinishedProjector implements IEventHandler<RunFinishedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunFinishedEvent): void {
    this.stream.publish({ runId: event.runId, type: "finished", payload: { status: event.status, totals: event.totals } });
  }
}
