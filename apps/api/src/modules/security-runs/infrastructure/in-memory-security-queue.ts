import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import {
  EXECUTION_TURNS,
  InMemoryExecutionTurnStore,
  type ExecutionTurnStorePort,
} from "@/shared/turns/execution-turns";
import { ExecutionTurnGate } from "@/shared/turns/execution-turn-gate";
import type { SecurityRunQueuePort } from "../domain/ports";

type SecuritySignal = { runId: string; kind: "cancel" | "settled" };
const SECURITY_SIGNAL_TOPIC = "security-run.signal";

/**
 * The security queue that needs no infrastructure.
 *
 * One run at a time: two matrices hitting the same target at once would make the rate-limit and
 * size heuristics meaningless. A run in flight dies with the process — the same trade the contract
 * queue makes, and acceptable because a security run is re-runnable.
 *
 * «Una a la vez» es de todo el despliegue, no de este proceso: antes de ejecutar la siguiente se pide
 * turno a la fila compartida (`ExecutionTurnGate`, en la base). Con dos réplicas, la otra espera a que
 * esta termine; las corridas de cada una siguen saliendo en el orden en que se encolaron, y entre
 * las dos, en el orden en que llegaron a la fila.
 *
 * Cancelar va por el bus: la corrida la ejecuta la instancia que la encoló y el «Cancelar» puede
 * llegar a otra. Sin eso, la otra marcaba su propio conjunto y la corrida seguía hasta el final.
 */
@Injectable()
export class InMemorySecurityRunQueue implements SecurityRunQueuePort, OnModuleDestroy {
  private readonly logger = new Logger(InMemorySecurityRunQueue.name);
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
    this.turns = new ExecutionTurnGate(turns ?? new InMemoryExecutionTurnStore(), this.bus, "security");
    this.bus.subscribe<SecuritySignal>(SECURITY_SIGNAL_TOPIC, ({ runId, kind }) =>
      kind === "cancel" ? this.cancelled.add(runId) : this.cancelled.delete(runId),
    );
  }

  async enqueue(runId: string): Promise<void> {
    this.pending.push(runId);
    await this.turns.join(runId);
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
        const runId = this.pending[0];
        // Una cancelada mientras espera también espera su turno, como antes en la cola de un
        // proceso: es el ejecutor quien la marca, al primer vistazo. `false` solo es que se apaga.
        if (!(await this.turns.take(runId))) return;
        this.pending.shift();
        try {
          await this.handler(runId);
        } catch (error) {
          this.logger.error(
            `La corrida de seguridad ${runId} terminó con un error no controlado`,
            error instanceof Error ? error.stack : String(error),
          );
        } finally {
          await this.turns.leave(runId);
          this.bus.publish(SECURITY_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies SecuritySignal);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  onModuleDestroy(): void {
    this.turns.close();
  }

  /** Lets a test await the queue instead of polling. */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) await new Promise((resolve) => setImmediate(resolve));
  }
}
