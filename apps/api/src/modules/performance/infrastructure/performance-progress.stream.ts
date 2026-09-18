import { Inject, Injectable, Optional } from "@nestjs/common";
import { Observable, Subject, filter, map } from "rxjs";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import type { PerformanceRunStatus } from "../domain/model";

const PERFORMANCE_PROGRESS_TOPIC = "performance-run.progress";

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
 *
 * Through the instance bus, so a follower on another instance than the one running the load sees
 * the same chart; without `REDIS_URL` the bus is in memory and this is the old per-process subject.
 */
@Injectable()
export class PerformanceProgressStream {
  private readonly events = new Subject<PerformanceProgressEvent>();
  private readonly bus: InstanceBusPort;

  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.bus.subscribe<PerformanceProgressEvent>(PERFORMANCE_PROGRESS_TOPIC, (event) => this.events.next(event));
  }

  publish(event: PerformanceProgressEvent): void {
    this.bus.publish(PERFORMANCE_PROGRESS_TOPIC, event);
  }

  forRun(runId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.runId === runId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
