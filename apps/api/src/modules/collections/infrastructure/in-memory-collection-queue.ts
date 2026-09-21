import { Inject, Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";

import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import {
  EXECUTION_TURNS,
  InMemoryExecutionTurnStore,
  type ExecutionTurnStorePort,
} from "@/shared/turns/execution-turns";
import { ExecutionTurnGate } from "@/shared/turns/execution-turn-gate";
import type { CollectionRunQueuePort } from "../domain/ports";

type CollectionSignal = { runId: string; kind: "cancel" | "settled" };
const COLLECTION_SIGNAL_TOPIC = "collection-run.signal";

/**
 * Una corrida de colección a la vez en todo el despliegue.
 *
 * La misma forma que la cola de carga y por lo mismo: una colección corriendo está **escribiendo**
 * en el API de alguien —crea las filas que luego busca y las borra al final—, y dos a la vez sobre
 * el mismo entorno se pisan los datos que cada una creó para sí; los `99 · Cleanup` de la segunda
 * borran lo que la primera todavía estaba leyendo.
 *
 * Cancelar es una marca que el runner mira en el hueco entre dos peticiones: la que está en vuelo
 * no se interrumpe. El indicador va por el bus a todas las instancias, porque el «Cancelar» puede
 * entrar por una que no es la que está corriendo.
 */
@Injectable()
export class InMemoryCollectionRunQueue implements CollectionRunQueuePort, OnModuleDestroy {
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
    this.turns = new ExecutionTurnGate(turns ?? new InMemoryExecutionTurnStore(), this.bus, "collection");
    this.bus.subscribe<CollectionSignal>(COLLECTION_SIGNAL_TOPIC, (signal) => this.apply(signal));
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
    this.bus.publish(COLLECTION_SIGNAL_TOPIC, { runId, kind: "cancel" } satisfies CollectionSignal);
  }

  private apply({ runId, kind }: CollectionSignal): void {
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
          this.bus.publish(COLLECTION_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies CollectionSignal);
          continue;
        }
        this.pending.shift();
        try {
          await this.handler(runId);
        } finally {
          await this.turns.leave(runId);
          this.bus.publish(COLLECTION_SIGNAL_TOPIC, { runId, kind: "settled" } satisfies CollectionSignal);
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
