import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Assertion, FailureKind, StepRequest, StepWebhook } from "@eq/runner-core";

import { ENV, type Env } from "@/shared/config/env";
import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import {
  FLOW_HOOK_REPOSITORY,
  FLOW_HOOK_TOPIC,
  flowHookKey,
  flowHookToken,
  flowHookUrls,
  hashFlowHookToken,
  hookResponse,
  type FlowHookDelivery,
  type FlowHookMethod,
  type FlowHookRepositoryPort,
} from "../domain/flow-hooks";
import type { RunCase } from "../domain/model";
import { RUN_QUEUE, type RunQueuePort } from "../domain/ports";
import type { ExecutedStep } from "./case-executor";

/** Una espera que la corrida ha repartido. `url` lleva el token; `redactedUrl` es lo que queda escrito. */
export type OpenFlowHook = {
  id: string;
  method: FlowHookMethod;
  timeoutMs: number;
  expiresAt: number;
  url: string;
  redactedUrl: string;
};

export type FlowHookOutcome =
  { kind: "delivered"; delivery: FlowHookDelivery } | { kind: "timeout" } | { kind: "cancelled" };

/** Cada cuánto se mira la base aunque no llegue aviso por el bus: el bus no garantiza la entrega, y
 * es también cuánto tarda en notarse una cancelación. */
const HOOK_POLL_MS = 1_000;

/**
 * La mitad del trabajador de un nodo webhook: acuñar la URL y esperar la llamada.
 *
 * Fuera del orquestador porque nada de esto va de recorrer un grafo: es un token, una tabla y un
 * reloj. El orquestador decide qué dice el caso del resultado.
 *
 * **Varias instancias.** La llamada entra por la instancia que elija el balanceador, que no tiene por
 * qué ser esta. Lo que las une es la tabla —la entrega se escribe allí, de forma atómica— y el bus:
 * quien acepta la llamada publica el id de la espera, y esta se despierta enseguida en vez de al
 * siguiente sondeo. El sondeo sigue ahí para cuando el aviso no llega, que el bus no promete.
 */
@Injectable()
export class FlowHookWaiter {
  private readonly key: Buffer;

  constructor(
    @Inject(FLOW_HOOK_REPOSITORY) private readonly hooks: FlowHookRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
    @Inject(INSTANCE_BUS) private readonly bus: InstanceBusPort,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.key = flowHookKey(env.JWT_ACCESS_SECRET);
  }

  /**
   * Una URL de un solo uso para este caso. En la tabla, el id y el hash del token; el token no.
   *
   * La caducidad va en reloj de pared (`Date.now()`) y no en el reloj inyectado, como `hold()`: la
   * espera es tiempo real en el que el proveedor de alguien tiene que contestar.
   */
  async open(runId: string, runCase: RunCase, stepId: string, config: StepWebhook): Promise<OpenFlowHook> {
    const id = randomUUID();
    const method = config.method ?? "POST";
    const now = Date.now();
    const expiresAt = now + config.timeoutMs;
    await this.hooks.open({
      id,
      tokenHash: hashFlowHookToken(flowHookToken(this.key, id)),
      runId,
      caseId: runCase.id,
      stepId,
      method,
      status: "open",
      expiresAt: new Date(expiresAt),
      delivery: null,
      createdAt: new Date(now),
    });
    return { id, method, timeoutMs: config.timeoutMs, expiresAt, ...flowHookUrls(this.env, id) };
  }

  /**
   * Hasta que llega la llamada, se cancela la corrida o caduca la espera.
   *
   * Al salir, la espera se **cierra antes** de la última mirada. Aceptar una llamada es atómico con
   * cerrarla, así que una vez cerrada ninguna llamada entra ya — y la que entró antes dejó su entrega.
   * Al revés quedaría un hueco en el que al proveedor se le dice 202 y la corrida cuenta que nadie
   * llamó.
   */
  async wait(runId: string, hook: OpenFlowHook): Promise<FlowHookOutcome> {
    let wake: (() => void) | null = null;
    const stop = this.bus.subscribe<{ hookId: string }>(FLOW_HOOK_TOPIC, (message) => {
      if (message?.hookId === hook.id) wake?.();
    });
    let cancelled = false;
    try {
      while (Date.now() < hook.expiresAt) {
        const current = await this.hooks.find(hook.id);
        if (current?.status === "delivered") break;
        if (await this.queue.isCancelled(runId)) {
          cancelled = true;
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.max(0, Math.min(HOOK_POLL_MS, hook.expiresAt - Date.now())));
          function done() {
            clearTimeout(timer);
            wake = null;
            resolve();
          }
          wake = done;
        });
      }
    } finally {
      stop();
    }
    const delivery = await this.hooks.settle(hook.id);
    if (delivery) return { kind: "delivered", delivery };
    return cancelled ? { kind: "cancelled" } : { kind: "timeout" };
  }
}

/**
 * La fila del paso de un caso webhook: mientras espera (la dirección, con el token tapado) y cuando
 * termina (la misma fila, con lo que llegó como respuesta).
 */
export function hookStep(
  runCase: RunCase,
  hook: OpenFlowHook,
  result: {
    ok: boolean;
    failure: FailureKind | null;
    assertions: Assertion[];
    delivery?: FlowHookDelivery;
    durationMs?: number;
  },
): ExecutedStep {
  const request: StepRequest = {
    index: 0,
    purpose: "act",
    label: runCase.method,
    operationId: "",
    method: runCase.method,
    operationPath: runCase.path,
    requestPath: "",
    expectedStatus: 0,
    expectedShape: "",
    auth: "none",
    samples: 1,
  };
  return {
    request,
    ok: result.ok,
    failure: result.failure,
    assertions: result.assertions,
    actual: result.delivery ? hookResponse(result.delivery) : null,
    latency: { samples: [], budgetMs: null },
    durationMs: result.durationMs ?? 0,
    // Lo que el caso «mandó» es la dirección en la que escuchó: el verbo con el que hay que llamar y
    // la URL, sin el token.
    sent: { method: hook.method, url: hook.redactedUrl, headers: {}, body: null },
  };
}
