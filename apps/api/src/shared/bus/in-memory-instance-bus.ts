import { Logger } from "@nestjs/common";

import {
  deliverSafely,
  fromWireError,
  InstanceUnreachableError,
  newInstanceId,
  toWireError,
  type InstanceBusPort,
} from "./instance-bus";

/**
 * Las instancias que comparten un bus en memoria.
 *
 * En producción hay una por proceso y nadie más en ella, que es exactamente un despliegue de una
 * sola instancia. En las pruebas, dos aplicaciones en el mismo proceso comparten una, y eso es lo
 * que deja probar «el seguidor está en B y la corrida en A» sin levantar un Redis.
 */
export class InMemoryBusHub {
  readonly members = new Map<string, InMemoryInstanceBus>();
}

/**
 * El bus sin infraestructura: el de siempre para un solo proceso, y el de las pruebas.
 *
 * A las demás instancias del mismo hub les llega **después** y **por JSON**, como les llegaría por
 * Redis: si una prueba pasa aquí con una fecha que al otro lado es texto, o con algo que dependía de
 * llegar en el mismo turno, pasaría aquí y fallaría con dos réplicas.
 */
export class InMemoryInstanceBus implements InstanceBusPort {
  private readonly logger = new Logger("InstanceBus");
  private readonly subscribers = new Map<string, Set<(message: unknown) => void>>();
  private readonly handlers = new Map<string, (message: unknown) => Promise<unknown> | unknown>();

  constructor(
    private readonly hub = new InMemoryBusHub(),
    readonly instanceId = newInstanceId(),
  ) {
    hub.members.set(instanceId, this);
  }

  publish(topic: string, message: unknown): void {
    this.deliver(topic, message);
    const wire = JSON.stringify(message);
    for (const member of this.hub.members.values()) {
      if (member === this) continue;
      // `setImmediate` conserva el orden de publicación, como un canal de Redis.
      setImmediate(() => member.deliver(topic, JSON.parse(wire)));
    }
  }

  subscribe<T>(topic: string, handler: (message: T) => void): () => void {
    const set = this.subscribers.get(topic) ?? new Set();
    set.add(handler as (message: unknown) => void);
    this.subscribers.set(topic, set);
    return () => set.delete(handler as (message: unknown) => void);
  }

  async request<T>(instanceId: string, topic: string, message: unknown): Promise<T> {
    const target = this.hub.members.get(instanceId);
    // En memoria se sabe que no hay nadie, y se dice ya: esperar el plazo no probaría nada más.
    if (!target) throw new InstanceUnreachableError(instanceId, "no está en este bus");
    return (await target.answer(topic, JSON.parse(JSON.stringify(message ?? null)))) as T;
  }

  handle<T, R>(topic: string, handler: (message: T) => Promise<R> | R): void {
    this.handlers.set(topic, handler as (message: unknown) => Promise<unknown> | unknown);
  }

  private deliver(topic: string, message: unknown): void {
    const set = this.subscribers.get(topic);
    if (!set) return;
    deliverSafely([...set], message, (error) =>
      this.logger.warn(`Un oyente de ${topic} falló: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  /** Como contestaría la otra instancia por la red: el resultado y el error, pasados por JSON. */
  private async answer(topic: string, message: unknown): Promise<unknown> {
    const handler = this.handlers.get(topic);
    if (!handler) throw new InstanceUnreachableError(this.instanceId, `no atiende ${topic}`);
    try {
      const value = await handler(message);
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    } catch (error) {
      throw fromWireError(JSON.parse(JSON.stringify(toWireError(error))));
    }
  }
}
