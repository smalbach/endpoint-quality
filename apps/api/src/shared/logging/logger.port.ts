/**
 * El registro como dependencia, y una línea por hecho.
 *
 * Un único método en vez de `debug`/`info`/`warn`/`error`: el nivel es un dato del hecho, no una
 * forma distinta de contarlo, y cuatro métodos son cuatro sitios donde un adaptador puede
 * olvidarse de un filtro.
 *
 * `fields` es lo que convierte esto en métricas y no en prosa. Un mensaje dice qué pasó; los
 * campos —`op`, `ms`, `status`, `outcome`— son lo que se agrupa después con `jq`, con LogQL o con
 * lo que sea que lea el JSON. De ahí la regla de la casa: **el mensaje no lleva números dentro**.
 * `"petición atendida"` con `ms: 412` se puede agregar; `"petición atendida en 412 ms"` no.
 */
export const LOGGER = Symbol("LOGGER");

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Lo que una instalación puede pedir. `silent` no es un nivel de una línea: es «ninguna». */
export type LogThreshold = LogLevel | "silent";
export type LogFields = Record<string, unknown>;

export interface LoggerPort {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export const LEVEL_RANK: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** El registro apagado, para una prueba que no quiere ruido en su salida. */
export class NullLogger implements LoggerPort {
  log(_level: LogLevel, _message: string, _fields?: LogFields): void {}
}

/** El registro recogido, para una prueba que quiere comprobar lo que se habría escrito. */
export class RecordingLogger implements LoggerPort {
  readonly entries: { level: LogLevel; message: string; fields: LogFields }[] = [];

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.entries.push({ level, message, fields });
  }
}
