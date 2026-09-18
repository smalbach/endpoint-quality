import { Inject, Injectable, Optional } from "@nestjs/common";
import { Subject, filter, map, type Observable } from "rxjs";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";

const SECURITY_PROGRESS_TOPIC = "security-run.progress";

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
 * Through the instance bus, like the contract runs' stream: the run executes on the instance whose
 * in-memory queue took it, and the follower is wherever the load balancer sent the browser. Before
 * the bus, a follower on the other instance saw the snapshot and then nothing until the run ended.
 */
@Injectable()
export class SecurityRunProgressStream {
  private readonly events = new Subject<SecurityProgressEvent>();
  private readonly bus: InstanceBusPort;

  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.bus.subscribe<SecurityProgressEvent>(SECURITY_PROGRESS_TOPIC, (event) => this.events.next(event));
  }

  publish(runId: string, event: Omit<SecurityProgressEvent, "runId">): void {
    this.bus.publish(SECURITY_PROGRESS_TOPIC, { runId, ...event });
  }

  forRun(runId: string): Observable<{ data: unknown; type: string }> {
    return this.events.asObservable().pipe(
      filter((event) => event.runId === runId),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
