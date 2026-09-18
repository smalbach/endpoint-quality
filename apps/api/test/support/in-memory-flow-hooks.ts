import type {
  FlowHook,
  FlowHookDelivery,
  FlowHookMethod,
  FlowHookRepositoryPort,
} from "@/modules/runs/domain/flow-hooks";

/**
 * Las esperas de los nodos webhook, en memoria y compartidas entre las dos aplicaciones de una prueba
 * multi-instancia, como lo sería la tabla.
 *
 * Atómico gratis: cada método corre entero entre dos `await`. Lo que sí imita de la base es que lo
 * guardado se copia por JSON, para que nadie dependa de compartir un objeto con la otra instancia.
 */
export class InMemoryFlowHookRepository implements FlowHookRepositoryPort {
  readonly rows = new Map<string, FlowHook>();

  async open(hook: FlowHook): Promise<void> {
    this.rows.set(hook.id, clone(hook));
  }

  async deliver(
    tokenHash: string,
    method: FlowHookMethod,
    delivery: FlowHookDelivery,
    now: Date,
  ): Promise<FlowHook | null> {
    const hook = [...this.rows.values()].find((row) => row.tokenHash === tokenHash);
    if (!hook || hook.method !== method || hook.status !== "open" || hook.expiresAt <= now) return null;
    hook.status = "delivered";
    hook.delivery = JSON.parse(JSON.stringify(delivery)) as FlowHookDelivery;
    return clone(hook);
  }

  async find(id: string): Promise<FlowHook | null> {
    const hook = this.rows.get(id);
    return hook ? clone(hook) : null;
  }

  async settle(id: string): Promise<FlowHookDelivery | null> {
    const hook = this.rows.get(id);
    if (!hook) return null;
    const delivery = hook.status === "delivered" ? hook.delivery : null;
    hook.status = hook.status === "open" ? "closed" : "settled";
    hook.delivery = null;
    return delivery;
  }

  async openForRun(runId: string, now: Date): Promise<FlowHook[]> {
    return [...this.rows.values()]
      .filter((row) => row.runId === runId && row.status === "open" && row.expiresAt > now)
      .map(clone);
  }
}

function clone(hook: FlowHook): FlowHook {
  return {
    ...hook,
    expiresAt: new Date(hook.expiresAt),
    createdAt: new Date(hook.createdAt),
    delivery: hook.delivery ? (JSON.parse(JSON.stringify(hook.delivery)) as FlowHookDelivery) : null,
  };
}
