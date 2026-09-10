import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { Subject, filter, type Observable } from "rxjs";

import { PROGRESS_RELAY, type ProgressEvent, type ProgressRelayPort } from "../domain/progress";
import { RunCaseFinishedEvent, RunFinishedEvent, RunStartedEvent } from "../application/events/run.events";

export type { ProgressEvent };

/**
 * The bridge from domain events to whoever is watching.
 *
 * A single hot `Subject` filtered per run, rather than one stream per subscriber: a run publishes
 * an event per case, and building an observable chain per follower would multiply that by the
 * number of open tabs.
 *
 * The subject is per process, which used to be the end of the story: with `QUEUE_DRIVER=redis`
 * and more than one instance, a follower connected to instance B saw nothing from a run executing
 * on instance A, and the polling fallback — meant for a dropped connection — covered the normal
 * case instead. The relay closes that. Its default adapter does nothing, because for a
 * single-process install there is nothing to do.
 *
 * **Local first, relay second.** A follower on this instance must not wait on a network round
 * trip to see a case turn green, and a broken broker must degrade the live view of other
 * instances rather than this one.
 */
@Injectable()
export class RunProgressStream implements OnApplicationBootstrap {
  private readonly events = new Subject<ProgressEvent>();

  constructor(@Inject(PROGRESS_RELAY) private readonly relay: ProgressRelayPort) {}

  onApplicationBootstrap(): void {
    // What arrives from another instance goes straight into the subject, and is never relayed
    // onward: an event that made one hop has reached everybody the channel reaches.
    this.relay.subscribe((event) => this.events.next(event));
  }

  publish(event: ProgressEvent): void {
    this.events.next(event);
    this.relay.publish(event);
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
