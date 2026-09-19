import { Inject, Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import {
  EXECUTION_TURNS,
  InMemoryExecutionTurnStore,
  type ExecutionTurnStorePort,
} from "@/shared/turns/execution-turns";
import { ExecutionTurnGate } from "@/shared/turns/execution-turn-gate";
import type { PerformanceRunQueuePort } from "../domain/ports";

type PerformanceSignal = { runId: string; kind: "cancel" | "settled" };
const PERFORMANCE_SIGNAL_TOPIC = "performance-run.signal";

/**
 * One performance run at a time, in the whole deployment.
 *
 * The same shape as the security queue and for the same reasons: a load test is already saturating
 * the target, so running two at once would measure their contention rather than the API, and a
 * single-instance in-memory queue is honest about the deployment it belongs to. Cancellation is a
 * flag the executor reads at each boundary; a request in flight is not interrupted.
 *
 * El indicador llega por el bus a todas las instancias, porque el «Cancelar» puede entrar por una
 * que no es la que tiene la carga en marcha —o en su fila—.
 *
 * Y el turno es de todas: antes de lanzar la siguiente carga se pide a la fila compartida
 * (`ExecutionTurnGate`, en la base), así que dos réplicas no cargan a la vez aunque cada una tenga
 * la suya en cola. Una cancelada mientras espera sale de la fila sin llegar a pedir turno.
 */
@Injectable()
export class InMemoryPerformanceRunQueue implements PerformanceRunQueuePort, OnModuleDestroy {
  private readonly pending: string[] = [];
  private readonly cancelled = new Set<string>();
  private handler: ((runId: string) => Promise<void>) | null = null;
  private draining = false;
  private readonly bus: InstanceBusPort;
  private readonly turns: ExecutionTurnGate;

  constructor(
    @Optional() @Inject(INSTANCE_BUS) bus: InstanceBusPort | null = null,
    @Optional() @Inject(EXECUTION_TURNS) turns: ExecutionTurnStorePort | null = null,
  ) {
    this.bus = bus ?? new InMemoryInstanceBus();
    this.turns = new ExecutionTurnGate(turns ?? new InMemoryExecutionTurnStore(), this.bus, "performance");
    this.bus.subscribe<PerformanceSignal>(PERFORMANCE_SIGNAL_TOPIC, (signal) => this.apply(signal));
  }

  process(handler: (runId: string) => Promise<void>): void {
    this.handler = handler;
  }

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    await this.turns.join(runId);
    void this.drain();
  }

  async cancel(runId: string): Promise<void> {
    this.bus.publish(PERFORMANCE_SIGNAL_TOPIC, { runId, kind: "cancel" } satisfies PerformanceSignal);
  }

  private apply({ runId, kind }: PerformanceSignal): void {
    if (kind === "settled") {
      this.cancelled.delete(runId);
      return;
    }
    this.cancelled.add(runId);
    // A run still queued never starts: drop it so cancel is immediate rather than «after it runs».
    const index = this.pending.indexOf(runId);
    if (index < 0) return;
    this.pending.splice(index, 1);
    // Y fuera de la fila de turnos, o seguiría latiendo ahí y ninguna instancia pasaría de ella.
    void this.turns.leave(runId);
  }

  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.handler) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const runId = this.pending[0];
        // Mientras espera turno la pueden cancelar, y `apply` la saca de `pending`: deja de quererse.
        const wanted = () => this.pending[0] === runId && !this.cancelled.has(runId);
        // `wanted()` otra vez después: la cancelación puede llegar justo cuando le daban el turno.
        const turn = wanted() && (await this.turns.take(runId, wanted)) && wanted();
        if (!turn) {
          if (this.pending[0] === runId) this.pending.shift();
          await this.turns.leave(runId);
          this.bus.publish(PERFORMANCE_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies PerformanceSignal);
          continue;
        }
        this.pending.shift();
        try {
          await this.handler(runId);
        } finally {
          await this.turns.leave(runId);
          this.bus.publish(PERFORMANCE_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies PerformanceSignal);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  onModuleDestroy(): void {
    this.turns.close();
  }

  /** Test helper: resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
