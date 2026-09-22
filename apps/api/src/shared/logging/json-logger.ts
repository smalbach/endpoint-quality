/**
 * Una línea JSON por hecho, a la salida estándar. Y nada más.
 *
 * Ni ficheros ni rotación ni destinos: el proceso escribe a `stdout` y quien lo ejecuta decide
 * dónde acaba eso —`docker compose logs` en una máquina de desarrollo, un recolector en un
 * despliegue—. Un fichero de log dentro del contenedor sería un fichero que nadie rota, que se
 * muere con el contenedor y que además exige un directorio escribible a un proceso que corre sin
 * root a propósito.
 *
 * Tres decisiones que parecen detalles y no lo son:
 *
 * - **La hora la da el reloj inyectado**, como en el resto del sistema, para que una prueba pueda
 *   afirmar el contenido exacto de la línea.
 * - **`JSON.stringify` puede fallar** —un campo con una referencia circular, un `BigInt`— y una
 *   línea de registro que lanza aborta la petición que estaba describiendo. Eso invertiría la
 *   relación: el registro existe para contar lo que pasa, no para decidirlo. Un campo imposible
 *   degrada a una línea que lo dice.
 * - **El formato de texto es solo para desarrollo.** Nadie lee JSON crudo mientras programa, y
 *   nada agrega texto suelto en producción.
 */
import type { ClockPort } from "@/shared/clock/clock.port";
import { currentTrace } from "./trace-context";
import { LEVEL_RANK, type LogFields, type LogLevel, type LogThreshold, type LoggerPort } from "./logger.port";

export type JsonLoggerOptions = {
  level: LogThreshold;
  format: "json" | "text";
  clock: ClockPort;
};

/** Dónde acaba la línea. Inyectable por la prueba; `stdout` en todo lo demás. */
export type LogSink = (line: string) => void;

const toStdout: LogSink = (line) => void process.stdout.write(`${line}\n`);

export class JsonLogger implements LoggerPort {
  private readonly threshold: number;

  constructor(
    private readonly options: JsonLoggerOptions,
    private readonly sink: LogSink = toStdout,
  ) {
    this.threshold = LEVEL_RANK[options.level];
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_RANK[level] < this.threshold) return;
    const trace = currentTrace();
    const record = {
      ts: this.options.clock.now().toISOString(),
      level,
      msg: message,
      ...(trace ? { traceId: trace.traceId } : {}),
      ...fields,
    };
    this.sink(this.options.format === "text" ? asText(record) : asJson(record));
  }
}

function asJson(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // El hecho se conserva; lo que se pierde son los campos que no se pueden escribir, y se dice
    // que se han perdido en vez de dejar un hueco.
    return JSON.stringify({ ts: record.ts, level: record.level, msg: record.msg, fieldsError: "no serializable" });
  }
}

/** `12:04:31.221 info  petición atendida · op="GET /health" ms=3` */
function asText(record: Record<string, unknown>): string {
  const { ts, level, msg, ...rest } = record;
  const time = String(ts).slice(11, 23);
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? `"${value}"` : String(value)}`)
    .join(" ");
  const head = `${time} ${String(level).padEnd(5)} ${String(msg)}`;
  return detail ? `${head} · ${detail}` : head;
}
