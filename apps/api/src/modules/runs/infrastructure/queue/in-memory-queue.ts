import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import type { ResumeMode, RunPause } from "../../domain/model";
import type { RunQueuePort } from "../../domain/ports";

/** Una señal sobre una corrida, para todas las instancias: la ejecuta una y la pueden tocar todas. */
type RunSignal =
  | { runId: string; kind: "cancel" }
  | { runId: string; kind: "pause"; at: RunPause | null }
  | { runId: string; kind: "resume"; how: ResumeMode }
  | { runId: string; kind: "settled" };

const RUN_SIGNAL_TOPIC = "run.signal";

/**
 * The queue that needs no infrastructure.
 *
 * This is what keeps "ejecutable en local" honest: `pnpm dev`, a Postgres, and runs work. It
 * processes **one run at a time**, in order, in this process — which is a real limitation and
 * the right one for a single operator, because two matrices hitting the same target at once
 * would make every latency measurement meaningless.
 *
 * A run in flight dies with the process. That is the trade the Redis adapter exists to remove,
 * and the reason `QUEUE_DRIVER` is a deployment decision rather than a default.
 *
 * **Las señales van por el bus.** Con dos instancias y esta cola, la corrida la ejecuta la que la
 * encoló, pero cancelar, pausar o reanudar puede llegar a la otra —la que le tocó al navegador—. Con
 * los mapas solo en memoria, eso era un «Cancelar» que no cancelaba y un «Reanudar» que contestaba
 * «no está en pausa». Cada señal se difunde a todas, y cada instancia guarda su copia; al terminar,
 * la que la ejecutó dice «asentada» y todas la olvidan.
 */
@Injectable()
export class InMemoryRunQueue implements RunQueuePort {
  private readonly logger = new Logger(InMemoryRunQueue.name);
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private readonly paused = new Map<string, RunPause>();
  private readonly resumes = new Map<string, ResumeMode>();
  private handler: ((runId: string) => Promise<void>) | null = null;
  private draining = false;
  private readonly bus: InstanceBusPort;

  constructor(@Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.bus.subscribe<RunSignal>(RUN_SIGNAL_TOPIC, (signal) => this.apply(signal));
  }

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    // Not awaited: the HTTP request that started the run answers 202 immediately, which is what
    // makes closing the browser harmless.
    void this.drain();
  }

  process(handler: (runId: string) => Promise<void>): void {
    this.handler = handler;
    void this.drain();
  }

  async cancel(runId: string): Promise<void> {
    this.bus.publish(RUN_SIGNAL_TOPIC, { runId, kind: "cancel" } satisfies RunSignal);
  }

  async isCancelled(runId: string): Promise<boolean> {
    return this.cancelled.has(runId);
  }

  async pause(runId: string, at: RunPause | null): Promise<void> {
    this.bus.publish(RUN_SIGNAL_TOPIC, { runId, kind: "pause", at } satisfies RunSignal);
  }

  async pausedAt(runId: string): Promise<RunPause | null> {
    return this.paused.get(runId) ?? null;
  }

  async resume(runId: string, how: ResumeMode): Promise<void> {
    this.bus.publish(RUN_SIGNAL_TOPIC, { runId, kind: "resume", how } satisfies RunSignal);
  }

  async takeResume(runId: string): Promise<ResumeMode | null> {
    const how = this.resumes.get(runId) ?? null;
    this.resumes.delete(runId);
    return how;
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
          // Swallowed on purpose: one run that throws must not stop the queue, and the handler
          // has already recorded the failure against its own run.
          this.logger.error(
            `La corrida ${runId} terminó con un error no controlado`,
            error instanceof Error ? error.stack : String(error),
          );
        } finally {
          this.bus.publish(RUN_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies RunSignal);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Lo que una señal cambia aquí, venga de esta instancia o de otra. Local primero y síncrono. */
  private apply(signal: RunSignal): void {
    switch (signal.kind) {
      case "cancel":
        this.cancelled.add(signal.runId);
        return;
      case "pause":
        if (signal.at) this.paused.set(signal.runId, signal.at);
        else this.paused.delete(signal.runId);
        return;
      case "resume":
        this.resumes.set(signal.runId, signal.how);
        return;
      case "settled":
        this.cancelled.delete(signal.runId);
        this.paused.delete(signal.runId);
        this.resumes.delete(signal.runId);
    }
  }

  /** Lets a test wait for the queue to settle without polling a private field. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) await new Promise((resolve) => setImmediate(resolve));
  }
}
