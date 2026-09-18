import { Inject, Injectable, Optional } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";
import { Subject, filter, type Observable } from "rxjs";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { RUN_PROGRESS_TOPIC, type ProgressEvent } from "../domain/progress";
import {
  RunCaseFinishedEvent,
  RunCaseRetryingEvent,
  RunCaseStartedEvent,
  RunFinishedEvent,
  RunPausedEvent,
  RunResumedEvent,
  RunStartedEvent,
} from "../application/events/run.events";

export type { ProgressEvent };

/**
 * The bridge from domain events to whoever is watching.
 *
 * A single hot `Subject` filtered per run, rather than one stream per subscriber: a run publishes
 * an event per case, and building an observable chain per follower would multiply that by the
 * number of open tabs.
 *
 * The subject is per process, which used to be the end of the story: a follower connected to
 * instance B saw nothing from a run executing on instance A. Every event now goes through the
 * instance bus, which hands this instance its own events synchronously and the other instances
 * theirs over Redis. Without `REDIS_URL` the bus is in memory and there is nobody else to tell.
 *
 * **Local first.** A follower on this instance must not wait on a network round trip to see a
 * case turn green, and a broken broker must degrade the live view of other instances rather than
 * this one. And what arrives from another instance is never published again: an event that made
 * one hop has reached everybody the channel reaches.
 */
@Injectable()
export class RunProgressStream {
  private readonly events = new Subject<ProgressEvent>();
  private readonly bus: InstanceBusPort;

  /** Sin bus inyectado, uno propio en memoria: el de un solo proceso, que es lo que eso significa. */
  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    // En el constructor y no al arrancar: un evento publicado antes del arranque no se pierde.
    this.bus.subscribe<ProgressEvent>(RUN_PROGRESS_TOPIC, (event) => this.events.next(event));
  }

  publish(event: ProgressEvent): void {
    this.bus.publish(RUN_PROGRESS_TOPIC, event);
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

@EventsHandler(RunCaseStartedEvent)
export class RunCaseStartedProjector implements IEventHandler<RunCaseStartedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunCaseStartedEvent): void {
    // Same `case` shape as the finished one, minus totals: the row updates, the bar does not.
    this.stream.publish({ runId: event.runId, type: "case", payload: { case: event.runCase } });
  }
}

@EventsHandler(RunCaseFinishedEvent)
export class RunCaseProjector implements IEventHandler<RunCaseFinishedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunCaseFinishedEvent): void {
    this.stream.publish({ runId: event.runId, type: "case", payload: { case: event.runCase, totals: event.totals } });
  }
}

@EventsHandler(RunCaseRetryingEvent)
export class RunCaseRetryingProjector implements IEventHandler<RunCaseRetryingEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunCaseRetryingEvent): void {
    this.stream.publish({
      runId: event.runId,
      type: "retrying",
      payload: { caseId: event.runCaseId, attempt: event.attempt, attempts: event.attempts, waitMs: event.waitMs },
    });
  }
}

@EventsHandler(RunPausedEvent)
export class RunPausedProjector implements IEventHandler<RunPausedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunPausedEvent): void {
    this.stream.publish({ runId: event.runId, type: "paused", payload: { pausedAt: event.at } });
  }
}

@EventsHandler(RunResumedEvent)
export class RunResumedProjector implements IEventHandler<RunResumedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunResumedEvent): void {
    this.stream.publish({ runId: event.runId, type: "resumed", payload: { resumed: event.how } });
  }
}

@EventsHandler(RunFinishedEvent)
export class RunFinishedProjector implements IEventHandler<RunFinishedEvent> {
  constructor(private readonly stream: RunProgressStream) {}
  handle(event: RunFinishedEvent): void {
    this.stream.publish({
      runId: event.runId,
      type: "finished",
      payload: { status: event.status, totals: event.totals },
    });
  }
}
