/**
 * Lo que una instancia de la API le dice a las demás.
 *
 * Con un solo proceso no hace falta: la corrida, el seguidor y el socket están en el mismo sitio. Con
 * dos detrás de un balanceador, cada cosa cae donde cae —la corrida donde se encoló, el navegador
 * donde lo mandó el balanceador, el socket de una sesión donde se abrió— y lo que las une es esto.
 *
 * Dos formas de hablar, y solo dos:
 *
 * - **Difundir** (`publish`/`subscribe`): un evento para todas las instancias, esta incluida y
 *   **primero**, de forma síncrona. Quien sigue una corrida desde la misma instancia que la ejecuta
 *   no espera una vuelta por la red para ver un caso en verde, y un broker caído degrada la vista de
 *   las otras instancias y no la de esta. Sin garantía de entrega a propósito: el progreso tarde no
 *   vale nada y el registro duradero es la base de datos.
 * - **Pedir** (`request`/`handle`): una orden a **una** instancia concreta, con respuesta y con
 *   plazo. Es lo que necesita una sesión de canal, cuyo socket es un descriptor de un proceso y no se
 *   puede mover: la orden va a donde está el socket.
 *
 * Todo lo que cruza va en JSON, también en el adaptador en memoria: una fecha llega como texto al
 * otro lado, y es mejor que una prueba lo vea a que lo descubra el primer despliegue con dos réplicas.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { DomainError, type ErrorKind } from "../errors/domain-error";

export const INSTANCE_BUS = Symbol("INSTANCE_BUS");

export interface InstanceBusPort {
  /** Quién soy. Es lo que una sesión guarda como `ownerInstance`, para que se le pueda pedir algo. */
  readonly instanceId: string;
  /** A todas las instancias: a esta de inmediato, a las demás por la red y sin esperar. */
  publish(topic: string, message: unknown): void;
  /** Lo que se publique en `topic`, venga de donde venga. Devuelve cómo dejar de escuchar. */
  subscribe<T>(topic: string, handler: (message: T) => void): () => void;
  /**
   * Una orden a una instancia concreta. Rechaza con `InstanceUnreachableError` si nadie contesta a
   * tiempo, y con el mismo error de dominio que lanzó el manejador si lo lanzó allí.
   */
  request<T>(instanceId: string, topic: string, message: unknown, timeoutMs?: number): Promise<T>;
  /** Contestar las órdenes de `topic` dirigidas a esta instancia. Uno por tema. */
  handle<T, R>(topic: string, handler: (message: T) => Promise<R> | R): void;
}

/** Cuánto se espera a otra instancia por defecto. Una orden a un socket vivo tarda milisegundos. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** La otra instancia no contestó: se murió, o no hay nada entre las dos por donde hablar. */
export class InstanceUnreachableError extends Error {
  constructor(
    readonly instanceId: string,
    detail: string,
  ) {
    super(`La instancia ${instanceId} no contestó: ${detail}`);
    this.name = "InstanceUnreachableError";
  }
}

/** Con un trozo aleatorio: dos procesos con el mismo pid tras reiniciar no son la misma instancia. */
export function newInstanceId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/** Un error, tal como viaja en la respuesta a una orden. */
export type WireError = {
  message: string;
  kind?: ErrorKind;
  fields?: { field: string; detail: string }[];
  code?: string;
};

/**
 * Un error de dominio cruza **con su tipo**: un 422 por una variable sin valor en la instancia que
 * tiene el socket tiene que llegar como 422 a quien lo pidió, con sus campos, y no como un 500.
 */
export function toWireError(error: unknown): WireError {
  if (error instanceof DomainError)
    return { message: error.message, kind: error.kind, fields: error.fields, code: error.code };
  return { message: error instanceof Error ? error.message : String(error) };
}

export function fromWireError(wire: WireError): Error {
  return wire.kind ? new DomainError(wire.kind, wire.message, wire.fields ?? [], wire.code) : new Error(wire.message);
}

/** Lo que se ejecuta al recibir algo: un manejador que falla no puede tumbar al que publica. */
export function deliverSafely<T>(handlers: Iterable<(message: T) => void>, message: T, onError: (e: unknown) => void) {
  for (const handler of handlers) {
    try {
      handler(message);
    } catch (error) {
      onError(error);
    }
  }
}
