/**
 * Cuándo le toca a un monitor, y en la hora de quien lo programó.
 *
 * Es una función pura de `(horario, instante)` al instante siguiente, y está separada de todo lo
 * demás porque es donde están los tres errores que un planificador comete en silencio:
 *
 * ## 1. No se acumula
 *
 * `nextOccurrence` calcula **desde el instante que se le da hacia delante**, nunca sumando al
 * turno anterior. Parece lo mismo y no lo es: un monitor cada hora en un proceso que estuvo ocho
 * horas caído, si se sumara al turno perdido, dispararía ocho corridas seguidas contra la API de
 * alguien nada más arrancar. Así dispara una —la de ahora— y vuelve a la cadencia.
 *
 * ## 2. La hora es la de una persona, no UTC
 *
 * Un monitor «todos los días a las 9:00» puesto por alguien en Madrid tiene que seguir siendo a las
 * 9:00 cuando cambie la hora, y un turno guardado en UTC se va una hora dos veces al año. Así que el
 * horario lleva su zona IANA y aquí se resuelve con `Intl`, que ya trae Node: cero dependencias y
 * la base de datos de zonas la mantiene otro.
 *
 * Los dos días raros del año, dichos a propósito porque un planificador que no los nombra los hace
 * mal: la hora que **no existe** (la que se salta en primavera) dispara al primer instante después
 * del salto, y la que **existe dos veces** (otoño) dispara en la primera de las dos. En los dos
 * casos el monitor corre una vez ese día, que es lo que se le pidió.
 *
 * ## 3. Hay un mínimo
 *
 * Cinco minutos. No es gusto: cada turno lanza una corrida entera contra un servicio real, y un
 * monitor cada treinta segundos no es vigilancia, es carga.
 */

/** Local, como en el resto de dominios de este producto. */
type Problem = { field: string; detail: string };

export const SCHEDULE_KINDS = ["interval", "daily", "weekly"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Cinco minutos. Cada turno es una corrida entera contra un servicio de alguien. */
export const MIN_INTERVAL_MINUTES = 5;
/** Una semana. Más que eso ya es un `weekly`, y decirlo así se lee mejor en la pantalla. */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export type MonitorSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; timeZone: string }
  /** `weekdays` en el orden de `Date.getUTCDay()`: 0 es domingo. */
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number; timeZone: string };

/** La zona por defecto cuando nadie dice ninguna: UTC, que es la única que no miente sobre sí misma. */
export const DEFAULT_TIME_ZONE = "UTC";

/** Si `Intl` conoce la zona. Una zona inventada haría que el monitor no volviera a disparar nunca. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function scheduleProblems(schedule: MonitorSchedule | undefined): Problem[] {
  if (!schedule) return [{ field: "schedule", detail: "Falta el horario" }];
  if (!SCHEDULE_KINDS.includes(schedule.kind))
    return [{ field: "schedule.kind", detail: "Tiene que ser «interval», «daily» o «weekly»" }];

  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });

  if (schedule.kind === "interval") {
    if (!Number.isInteger(schedule.minutes)) problem("schedule.minutes", "Tiene que ser un entero de minutos");
    else if (schedule.minutes < MIN_INTERVAL_MINUTES)
      problem("schedule.minutes", `Como poco cada ${MIN_INTERVAL_MINUTES} minutos: cada turno es una corrida entera`);
    else if (schedule.minutes > MAX_INTERVAL_MINUTES)
      problem("schedule.minutes", `Como mucho ${MAX_INTERVAL_MINUTES} minutos; para más, usa «weekly»`);
    return problems;
  }

  if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23)
    problem("schedule.hour", "La hora va de 0 a 23");
  if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59)
    problem("schedule.minute", "El minuto va de 0 a 59");
  if (!schedule.timeZone || !isTimeZone(schedule.timeZone))
    problem("schedule.timeZone", "Zona horaria desconocida: se escribe como «Europe/Madrid»");

  if (schedule.kind === "weekly") {
    const weekdays = schedule.weekdays ?? [];
    if (!weekdays.length) problem("schedule.weekdays", "Elige al menos un día de la semana");
    else if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
      problem("schedule.weekdays", "Los días van de 0 (domingo) a 6 (sábado)");
  }

  return problems;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Un formateador por zona, reutilizado: construir uno cuesta más que la propia lectura. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // `h23` y no `hour12: false`: con `hour12` algunas versiones devuelven «24» para medianoche,
      // y eso convierte la medianoche en el día siguiente sin avisar.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** La hora de pared que marca un reloj de esa zona en ese instante. */
export function wallTime(instant: Date, timeZone: string): Wall {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const of = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: of("year"),
    month: of("month"),
    day: of("day"),
    hour: of("hour"),
    minute: of("minute"),
    second: of("second"),
  };
}

/** La lectura de pared expresada como si fuera UTC. Es lo que permite medir el desfase de la zona. */
const asUtc = (wall: Wall): number =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

/** El desfase de la zona en ese instante, en milisegundos. Positivo al este de Greenwich. */
function offsetMs(instant: number, timeZone: string): number {
  return asUtc(wallTime(new Date(instant), timeZone)) - instant;
}

const HALF_DAY = 12 * 60 * 60 * 1000;

/**
 * El instante en el que el reloj de esa zona marca esa hora de pared.
 *
 * No se puede restar «el desfase» sin más, porque el desfase depende del instante y el instante es
 * justo lo que se está buscando. Así que se prueban los dos desfases posibles alrededor —medio día
 * antes y medio día después, que cubre cualquier cambio de hora— y se comprueba **cuál de los dos
 * candidatos recupera de verdad la hora pedida**. Eso resuelve los dos días raros del año sin
 * ninguna tabla de zonas propia:
 *
 * - **La hora que existe dos veces** (el atraso de otoño): los dos candidatos valen, y se coge el
 *   **primero**. Es la primera vez que el reloj marca esa hora, que es lo que alguien quiere decir
 *   con «a las 02:30», y correr una vez es lo que se pidió.
 * - **La hora que no existe** (el adelanto de primavera): no vale ninguno, porque ese reloj nunca
 *   marca eso. Se coge el más tardío, que cae justo al otro lado del salto: el primer instante en
 *   el que ya se puede correr.
 */
export function instantForWall(wall: Pick<Wall, "year" | "month" | "day" | "hour" | "minute">, timeZone: string): Date {
  const wanted = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const candidates = [wanted - HALF_DAY, wanted + HALF_DAY].map((probe) => wanted - offsetMs(probe, timeZone));
  const valid = candidates.filter((instant) => asUtc(wallTime(new Date(instant), timeZone)) === wanted);
  return new Date(valid.length ? Math.min(...valid) : Math.max(...candidates));
}

/**
 * El turno siguiente, estrictamente después de `after`.
 *
 * Desde `after` hacia delante y sin acumular: ver la cabecera del fichero. Para `daily` y `weekly`
 * se prueban los días de pared uno a uno desde el de `after`; ocho vueltas bastan para cualquier
 * `weekly` —siete días más el día de hoy ya pasado— y así no hay aritmética de calendario a mano.
 */
export function nextOccurrence(schedule: MonitorSchedule, after: Date): Date {
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.minutes * 60_000);

  const timeZone = schedule.timeZone || DEFAULT_TIME_ZONE;
  const weekdays = schedule.kind === "weekly" ? new Set(schedule.weekdays) : null;
  const start = wallTime(after, timeZone);

  for (let ahead = 0; ahead <= 8; ahead += 1) {
    // Se avanza sobre el día de pared, no sobre el instante: sumar 24 h a un instante salta o
    // repite un día en la semana en la que cambia la hora.
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + ahead));
    const candidate = instantForWall(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: schedule.hour,
        minute: schedule.minute,
      },
      timeZone,
    );
    if (candidate.getTime() <= after.getTime()) continue;
    // El día de la semana se mira en la zona del monitor: a las 23:30 de un viernes en Madrid, en
    // UTC ya es viernes todavía, pero a las 00:30 del sábado en Madrid es viernes en UTC.
    if (weekdays) {
      const wall = wallTime(candidate, timeZone);
      const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
      if (!weekdays.has(weekday)) continue;
    }
    return candidate;
  }

  // Inalcanzable con un horario válido: `weekly` tiene al menos un día y ocho vueltas cubren la
  // semana entera. Antes que devolver algo inventado, se dice que el horario no vuelve a disparar.
  throw new Error("El horario no tiene ningún turno siguiente");
}

/** Cómo se lee el horario. En el servidor porque la cifra y su unidad las decide el dominio. */
export function describeSchedule(schedule: MonitorSchedule): string {
  if (schedule.kind === "interval") {
    if (schedule.minutes % 60 === 0) {
      const hours = schedule.minutes / 60;
      return hours === 1 ? "cada hora" : `cada ${hours} horas`;
    }
    return `cada ${schedule.minutes} minutos`;
  }
  const at = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.kind === "daily") return `todos los días a las ${at} (${schedule.timeZone})`;
  const names = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const days = [...schedule.weekdays].sort((a, b) => a - b).map((day) => names[day] ?? "?");
  return `${days.join(", ")} a las ${at} (${schedule.timeZone})`;
}
