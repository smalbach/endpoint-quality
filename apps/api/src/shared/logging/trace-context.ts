/**
 * El hilo que une todo lo que pasa por una misma petición.
 *
 * Un identificador por petición, guardado en un `AsyncLocalStorage` en vez de pasado de argumento
 * en argumento: el registro que hace falta correlacionar no está en el controlador, está tres
 * capas más abajo —en `SAFE_FETCH`, en el sandbox de guiones, en el filtro de errores— y llevarlo
 * hasta allí a mano significaría cambiar la firma de media aplicación para que un log pueda citar
 * un número.
 *
 * El identificador **sale al cliente** en `X-Trace-Id` y dentro del cuerpo RFC 9457. Ese es el
 * punto: quien informa de un fallo trae el número, y una búsqueda por ese número devuelve la
 * petición entera en orden. Sin eso, un informe de fallo es una búsqueda por «hacia las cuatro».
 *
 * Un identificador que llega en la cabecera se **acepta pero se valida**: es lo que permite
 * seguir una operación que empezó en el navegador o en otro servicio, y una cabecera que el
 * cliente escribe sin filtrar acabaría en una línea JSON del registro. Un salto de línea ahí
 * inventa entradas enteras; de ahí la forma cerrada.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TraceContext = {
  traceId: string;
  /** Cuándo entró la petición, en milisegundos. Aquí y no en quien mide, porque una operación se
   * mide en dos sitios —el interceptor si terminó, el filtro de errores si no— y dos relojes
   * arrancados en dos momentos distintos darían dos duraciones para la misma petición. */
  startedAt: number;
};

/** En minúscula: así llegan las cabeceras de Express. La respuesta la escribe con mayúsculas. */
export const TRACE_HEADER = "x-trace-id";
export const TRACE_HEADER_OUT = "X-Trace-Id";

const SAFE_TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;

const storage = new AsyncLocalStorage<TraceContext>();

/** El identificador de esta petición: el que trae el cliente si tiene forma de identificador, y
 * uno nuevo si no. Nunca falla: una cabecera rara da una traza nueva, no un error. */
export function traceIdFrom(header: unknown): string {
  return typeof header === "string" && SAFE_TRACE_ID.test(header) ? header : randomUUID();
}

export function runWithTrace<T>(traceId: string, startedAt: number, fn: () => T): T {
  return storage.run({ traceId, startedAt }, fn);
}

/** Indefinido fuera de una petición —un barrido de retención, un monitor, el arranque— y eso es
 * correcto: esas líneas no pertenecen a ninguna traza. */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** Lo que lleva esta operación, o nada si esto no ocurre dentro de una petición. Una duración
 * inventada es peor que una duración ausente: se agrega igual y miente. */
export function elapsedMs(now: number): number | undefined {
  const context = storage.getStore();
  return context ? now - context.startedAt : undefined;
}
