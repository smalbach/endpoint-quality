import { randomUUID } from "node:crypto";
import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";

import {
  deliverSafely,
  fromWireError,
  InstanceUnreachableError,
  newInstanceId,
  REQUEST_TIMEOUT_MS,
  toWireError,
  type InstanceBusPort,
  type WireError,
} from "./instance-bus";

type EventEnvelope = { origin: string; topic: string; message: unknown };
type RpcEnvelope =
  | { kind: "request"; id: string; topic: string; message: unknown; replyTo: string }
  | { kind: "reply"; id: string; ok: true; value: unknown }
  | { kind: "reply"; id: string; ok: false; error: WireError };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/**
 * El bus entre instancias, por Redis pub/sub.
 *
 * **Un canal para todos los eventos** y uno por instancia para las órdenes. Un canal por tema haría
 * que cada `subscribe` fuera una vuelta a Redis y un estado más que reconstruir al reconectar; el
 * volumen de aquí —un evento por caso, por mensaje de una sesión— no lo justifica.
 *
 * **Pub/sub y no un stream**, igual que el relé de progreso al que sustituye: lo que viaja aquí no
 * vale nada tarde. Un seguidor que pierde un evento lee la verdad de la base de datos en la
 * siguiente lectura; una orden que no llega vence su plazo y quien la pidió lo dice.
 *
 * Y lo que llega con nuestro propio sello se tira: esta instancia ya se lo entregó a sí misma al
 * publicar, y entregarlo otra vez pintaría cada caso dos veces a cada seguidor de aquí.
 *
 * Redis caído no tumba la API: la instancia sigue sirviendo lo suyo como si estuviera sola, lo dice
 * una vez en el registro y no una por reintento, y vuelve sola cuando Redis vuelve.
 */
export class RedisInstanceBus implements InstanceBusPort, OnModuleDestroy {
  private readonly logger = new Logger("InstanceBus");
  private readonly subscribers = new Map<string, Set<(message: unknown) => void>>();
  private readonly handlers = new Map<string, (message: unknown) => Promise<unknown> | unknown>();
  private readonly pending = new Map<string, Pending>();
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly eventsChannel: string;
  /** Si ya se dijo que Redis no está: se avisa al caer y al volver, no en cada reintento. */
  private down = false;

  constructor(
    redisUrl: string,
    readonly instanceId = newInstanceId(),
    private readonly prefix = "eq:bus",
  ) {
    this.eventsChannel = `${prefix}:events`;
    const retryStrategy = (times: number) => Math.min(times * 500, 10_000);
    // Sin cola fuera de línea en el que publica: con Redis caído, publicar falla en el acto en vez de
    // acumular en memoria cada evento de cada corrida hasta que vuelva —que puede ser nunca—.
    this.publisher = new Redis(redisUrl, { retryStrategy, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    // El que escucha sí la conserva: su `subscribe` se manda en cuanto conecta, y ioredis vuelve a
    // suscribirse solo al reconectar.
    this.subscriber = new Redis(redisUrl, { retryStrategy });
    for (const client of [this.publisher, this.subscriber]) {
      client.on("error", (error: Error) => this.fell(error));
      client.on("ready", () => this.recovered());
    }
    this.subscriber.on("message", (channel: string, raw: string) => this.receive(channel, raw));
    void this.subscriber
      .subscribe(this.eventsChannel, this.rpcChannel(this.instanceId))
      .catch((error) => this.fell(error));
  }

  publish(topic: string, message: unknown): void {
    this.deliver(topic, message);
    // Sin conexión —arrancando, o con Redis caído— no se intenta: fallaría en el acto, y el aviso de
    // que no hay bus ya lo dio `fell` una vez.
    if (this.publisher.status !== "ready") return;
    const envelope: EventEnvelope = { origin: this.instanceId, topic, message };
    // Sin esperar: un broker lento no puede meterse en el camino de ejecutar un caso.
    void this.publisher.publish(this.eventsChannel, JSON.stringify(envelope)).catch((error) => this.lost(error));
  }

  subscribe<T>(topic: string, handler: (message: T) => void): () => void {
    const set = this.subscribers.get(topic) ?? new Set();
    set.add(handler as (message: unknown) => void);
    this.subscribers.set(topic, set);
    return () => set.delete(handler as (message: unknown) => void);
  }

  handle<T, R>(topic: string, handler: (message: T) => Promise<R> | R): void {
    this.handlers.set(topic, handler as (message: unknown) => Promise<unknown> | unknown);
  }

  async request<T>(instanceId: string, topic: string, message: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    // A mí mismo, sin red: la misma respuesta, pasada por JSON como si hubiera viajado.
    if (instanceId === this.instanceId) {
      const handler = this.handlers.get(topic);
      if (!handler) throw new InstanceUnreachableError(instanceId, `no atiende ${topic}`);
      try {
        const value = await handler(JSON.parse(JSON.stringify(message ?? null)));
        return (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) as T;
      } catch (error) {
        throw fromWireError(toWireError(error));
      }
    }
    const id = randomUUID();
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new InstanceUnreachableError(instanceId, `sin respuesta en ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    const envelope: RpcEnvelope = { kind: "request", id, topic, message, replyTo: this.instanceId };
    let receivers: number;
    try {
      receivers = await this.publisher.publish(this.rpcChannel(instanceId), JSON.stringify(envelope));
    } catch (error) {
      this.settle(id);
      throw new InstanceUnreachableError(instanceId, error instanceof Error ? error.message : String(error));
    }
    // `PUBLISH` dice cuántos lo oyeron. Cero es que esa instancia no está escuchando: no se espera el
    // plazo entero para decir lo que ya se sabe.
    if (receivers === 0) {
      this.settle(id);
      throw new InstanceUnreachableError(instanceId, "no escucha en el bus");
    }
    return (await reply) as T;
  }

  async close(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new Error("El bus se está cerrando"));
    await Promise.all([this.subscriber.quit().catch(() => undefined), this.publisher.quit().catch(() => undefined)]);
    // Igual que en los contadores: `quit` con Redis caído falla y el cliente sigue reintentando solo.
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private rpcChannel(instanceId: string): string {
    return `${this.prefix}:rpc:${instanceId}`;
  }

  private settle(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private deliver(topic: string, message: unknown): void {
    const set = this.subscribers.get(topic);
    if (!set) return;
    deliverSafely([...set], message, (error) =>
      this.logger.warn(`Un oyente de ${topic} falló: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  private receive(channel: string, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Llegó por ${channel} algo que no se pudo leer`);
      return;
    }
    if (channel === this.eventsChannel) {
      const event = parsed as EventEnvelope;
      if (event.origin !== this.instanceId) this.deliver(event.topic, event.message);
      return;
    }
    const rpc = parsed as RpcEnvelope;
    if (rpc.kind === "reply") {
      const pending = this.settle(rpc.id);
      if (!pending) return; // Llegó tarde: quien preguntó ya dio la orden por perdida.
      if (rpc.ok) pending.resolve(rpc.value);
      else pending.reject(fromWireError(rpc.error));
      return;
    }
    void this.answer(rpc);
  }

  private async answer(request: Extract<RpcEnvelope, { kind: "request" }>): Promise<void> {
    const handler = this.handlers.get(request.topic);
    let reply: RpcEnvelope;
    try {
      if (!handler) throw new Error(`La instancia ${this.instanceId} no atiende ${request.topic}`);
      reply = { kind: "reply", id: request.id, ok: true, value: (await handler(request.message)) ?? null };
    } catch (error) {
      reply = { kind: "reply", id: request.id, ok: false, error: toWireError(error) };
    }
    await this.publisher
      .publish(this.rpcChannel(request.replyTo), JSON.stringify(reply))
      .catch((error) => this.lost(error));
  }

  /** Un envío que no salió. Con Redis ya dado por caído no se repite el aviso por cada evento. */
  private lost(error: unknown): void {
    if (this.down) return;
    this.logger.warn(`No salió un mensaje por el bus: ${error instanceof Error ? error.message : String(error)}`);
  }

  private fell(error: unknown): void {
    if (this.down) return;
    this.down = true;
    this.logger.warn(
      `Sin bus entre instancias (Redis): ${error instanceof Error ? error.message : String(error)}. Esta instancia sigue sirviendo lo suyo`,
    );
  }

  private recovered(): void {
    if (!this.down) return;
    this.down = false;
    this.logger.log("Bus entre instancias recuperado");
  }
}
