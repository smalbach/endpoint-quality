import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import type { SecurityRunQueuePort } from "../domain/ports";

type SecuritySignal = { runId: string; kind: "cancel" | "settled" };
const SECURITY_SIGNAL_TOPIC = "security-run.signal";

/**
 * The security queue that needs no infrastructure.
 *
 * One run at a time, in this process: two matrices hitting the same target at once would make the
 * rate-limit and size heuristics meaningless. A run in flight dies with the process — the same
 * trade the contract queue makes, and acceptable because a security run is re-runnable.
 *
 * Cancelar va por el bus: la corrida la ejecuta la instancia que la encoló y el «Cancelar» puede
 * llegar a otra. Sin eso, la otra marcaba su propio conjunto y la corrida seguía hasta el final.
 */
@Injectable()
export class InMemorySecurityRunQueue implements SecurityRunQueuePort {
  private readonly logger = new Logger(InMemorySecurityRunQueue.name);
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private handler: ((runId: string) => Promise<void>) | null = null;
  private draining = false;
  private readonly bus: InstanceBusPort;

  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.bus.subscribe<SecuritySignal>(SECURITY_SIGNAL_TOPIC, ({ runId, kind }) =>
      kind === "cancel" ? this.cancelled.add(runId) : this.cancelled.delete(runId),
    );
  }

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    void this.drain();
  }

  process(handler: (runId: string) => Promise<void>): void {
    this.handler = handler;
    void this.drain();
  }

  async cancel(runId: string): Promise<void> {
    this.bus.publish(SECURITY_SIGNAL_TOPIC, { runId, kind: "cancel" } satisfies SecuritySignal);
  }

  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const runId = this.pending.shift()!;
        try {
          await this.handler(runId);
        } catch (error) {
          this.logger.error(
            `La corrida de seguridad ${runId} terminó con un error no controlado`,
            error instanceof Error ? error.stack : String(error),
          );
        } finally {
          this.bus.publish(SECURITY_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies SecuritySignal);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Lets a test await the queue instead of polling. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) await new Promise((resolve) => setImmediate(resolve));
  }
}
