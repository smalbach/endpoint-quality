/**
 * Lo que ya escribe Nest, pasado por el mismo sitio que todo lo demás.
 *
 * Hay unas veinticinco llamadas a `new Logger(...)` repartidas por los módulos —el barrido de
 * retención, el aviso de un monitor, la cola, el bus— y todas dicen cosas que hacen falta. El
 * arreglo no es reescribirlas: es que el registro por debajo sea este, para que salgan como una
 * línea JSON con su traza igual que las demás, y para que `LOG_LEVEL` valga también para ellas.
 *
 * `context` es el nombre con el que se construyó el `Logger` —`"Retention"`, `"Monitors"`— y
 * llega como último argumento. Se guarda como campo y no pegado al mensaje, que es lo que permite
 * después filtrar por él.
 */
import type { LoggerService } from "@nestjs/common";

import type { LogFields, LogLevel, LoggerPort } from "./logger.port";

export class NestLoggerBridge implements LoggerService {
  constructor(private readonly logger: LoggerPort) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit("info", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit("warn", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }

  /** `verbose` y `debug` son el mismo nivel aquí: dos nombres para «solo mientras se depura». */
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }

  /** Nest llama a este cuando el proceso se está muriendo. No hay nivel por encima de `error`:
   * lo que lo distingue es el campo, no una escala que nadie configura. */
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params, { fatal: true });
  }

  private emit(level: LogLevel, message: unknown, params: unknown[], extra: LogFields = {}): void {
    this.logger.log(level, text(message), { source: "nest", ...describe(params), ...extra });
  }
}

/** El último argumento es el `context` del `Logger`; lo que quede antes es el detalle —una pila,
 * normalmente— y se conserva en un campo aparte. */
function describe(params: unknown[]): LogFields {
  if (!params.length) return {};
  const context = params[params.length - 1];
  const rest = params.slice(0, -1).map(text);
  return {
    ...(typeof context === "string" ? { context } : { detail: text(context) }),
    ...(rest.length ? { detail: rest.join(" ") } : {}),
  };
}

/** Un mensaje que no es texto se conserva como texto, y nunca lanza: un registro que se cae por
 * describir su propio argumento se lleva por delante la operación que estaba contando. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
