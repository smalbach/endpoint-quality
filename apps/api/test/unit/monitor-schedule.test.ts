/**
 * Cuándo le toca a un monitor.
 *
 * Es el fichero donde están los errores que un planificador comete **sin que nadie se entere**, y
 * por eso casi todo lo de aquí es una fecha concreta comparada con otra fecha concreta:
 *
 * - Que un proceso caído ocho horas no deba ocho corridas.
 * - Que «todos los días a las 9:00» siga siendo a las 9:00 después del cambio de hora, que es la
 *   mitad del año para quien no vive en UTC.
 * - Los dos días raros: la hora que no existe y la que existe dos veces. Un planificador que no los
 *   nombra los hace mal, y el fallo aparece una vez cada seis meses.
 * - Que el día de la semana se mire en la zona del monitor. A las 00:30 del sábado en Madrid, en
 *   UTC todavía es viernes: un «sábados» que mirara UTC dispararía el día equivocado.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_INTERVAL_MINUTES,
  describeSchedule,
  instantForWall,
  isTimeZone,
  nextOccurrence,
  scheduleProblems,
  wallTime,
  type MonitorSchedule,
} from "@/modules/monitors/domain/schedule";

/** La hora de pared que marca un reloj de esa zona, como texto, para que el fallo se lea. */
const wall = (instant: Date, timeZone: string) => {
  const parts = wallTime(instant, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
};

const daily = (hour: number, minute: number, timeZone: string): MonitorSchedule => ({
  kind: "daily",
  hour,
  minute,
  timeZone,
});

describe("el intervalo", () => {
  it("cuenta desde el instante que se le da, no desde el turno perdido", () => {
    // Es la prueba de que un proceso caído ocho horas no debe ocho corridas: se le pasa «ahora» y
    // contesta «ahora + una hora», sin saber ni preguntar cuándo le tocaba.
    const schedule: MonitorSchedule = { kind: "interval", minutes: 60 };
    const now = new Date("2026-03-01T10:17:33.000Z");
    assert.equal(nextOccurrence(schedule, now).toISOString(), "2026-03-01T11:17:33.000Z");
  });

  it("no baja del mínimo, porque cada turno es una corrida entera", () => {
    const problems = scheduleProblems({ kind: "interval", minutes: 1 });
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.field, "schedule.minutes");
    assert.deepEqual(scheduleProblems({ kind: "interval", minutes: MIN_INTERVAL_MINUTES }), []);
  });

  it("un intervalo que no es entero no vale", () => {
    assert.equal(scheduleProblems({ kind: "interval", minutes: 7.5 }).length, 1);
  });
});

describe("todos los días, en la hora de una persona", () => {
  it("las 9:00 de Madrid en invierno son las 08:00Z", () => {
    const next = nextOccurrence(daily(9, 0, "Europe/Madrid"), new Date("2026-01-15T07:00:00.000Z"));
    assert.equal(next.toISOString(), "2026-01-15T08:00:00.000Z");
  });

  it("y en verano son las 07:00Z: la hora de pared es la que no se mueve", () => {
    // Guardar el turno en UTC habría dejado este monitor a las 10:00 locales media año.
    const next = nextOccurrence(daily(9, 0, "Europe/Madrid"), new Date("2026-07-15T06:00:00.000Z"));
    assert.equal(next.toISOString(), "2026-07-15T07:00:00.000Z");
    assert.equal(wall(next, "Europe/Madrid"), "2026-07-15 09:00");
  });

  it("si la hora de hoy ya pasó, es la de mañana", () => {
    const next = nextOccurrence(daily(9, 0, "Europe/Madrid"), new Date("2026-01-15T09:00:00.000Z"));
    assert.equal(wall(next, "Europe/Madrid"), "2026-01-16 09:00");
  });

  it("el turno es estrictamente posterior: el mismo instante no cuenta como siguiente", () => {
    // Sin esto, el reclamo tomaría el monitor, le pondría el mismo turno y lo volvería a tomar en
    // el siguiente tic: una corrida por minuto para siempre.
    const exact = new Date("2026-01-15T08:00:00.000Z");
    const next = nextOccurrence(daily(9, 0, "Europe/Madrid"), exact);
    assert.ok(next.getTime() > exact.getTime());
    assert.equal(wall(next, "Europe/Madrid"), "2026-01-16 09:00");
  });

  it("medianoche es medianoche y no el día siguiente", () => {
    // `hour12: false` devuelve «24» para medianoche en algunas versiones, y eso convertía las
    // 00:00 del día 16 en las 24:00 del 15.
    const next = nextOccurrence(daily(0, 0, "Europe/Madrid"), new Date("2026-01-15T12:00:00.000Z"));
    assert.equal(wall(next, "Europe/Madrid"), "2026-01-16 00:00");
  });

  it("en una zona con media hora de desfase también", () => {
    const next = nextOccurrence(daily(9, 0, "Asia/Kolkata"), new Date("2026-01-15T00:00:00.000Z"));
    assert.equal(next.toISOString(), "2026-01-15T03:30:00.000Z");
  });
});

describe("los dos días raros del año", () => {
  it("la hora que no existe dispara en el primer instante después del salto", () => {
    // En Madrid, el 29 de marzo de 2026 el reloj salta de 02:00 a 03:00: las 02:30 no existen.
    // Un monitor a las 02:30 tiene que correr ese día, y lo hace en cuanto se puede.
    const next = nextOccurrence(daily(2, 30, "Europe/Madrid"), new Date("2026-03-29T00:10:00.000Z"));
    assert.equal(next.toISOString(), "2026-03-29T01:30:00.000Z");
    // La hora de pared que le sale es 03:30, porque 02:30 no existió: corrió una vez, que es lo
    // que se le pidió.
    assert.equal(wall(next, "Europe/Madrid"), "2026-03-29 03:30");
  });

  it("la hora que existe dos veces dispara en la primera de las dos", () => {
    // El 25 de octubre de 2026 el reloj vuelve de 03:00 a 02:00: las 02:30 pasan dos veces.
    // Correr en la primera es correr una vez.
    const next = nextOccurrence(daily(2, 30, "Europe/Madrid"), new Date("2026-10-25T00:00:00.000Z"));
    assert.equal(next.toISOString(), "2026-10-25T00:30:00.000Z");
    assert.equal(wall(next, "Europe/Madrid"), "2026-10-25 02:30");
  });

  it("el día del cambio, el turno siguiente sigue siendo una vez al día", () => {
    // Avanzar sumando 24 h a un instante se salta o repite un día en esta semana. Se avanza sobre
    // el día de pared, y por eso esto sale bien.
    const schedule = daily(9, 0, "Europe/Madrid");
    const before = nextOccurrence(schedule, new Date("2026-03-28T09:00:00.000Z"));
    assert.equal(wall(before, "Europe/Madrid"), "2026-03-29 09:00");
    const after = nextOccurrence(schedule, before);
    assert.equal(wall(after, "Europe/Madrid"), "2026-03-30 09:00");
  });

  it("instantForWall recupera la hora pedida cuando esa hora existe", () => {
    const instant = instantForWall({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, "Europe/Madrid");
    assert.equal(wall(instant, "Europe/Madrid"), "2026-07-15 09:00");
  });
});

describe("los días de la semana", () => {
  it("se miran en la zona del monitor y no en UTC", () => {
    // 00:30 del sábado en Madrid es 23:30 del viernes en UTC. Un «sábados» que mirara UTC se
    // saltaría este turno y dispararía el domingo.
    const schedule: MonitorSchedule = { kind: "weekly", weekdays: [6], hour: 0, minute: 30, timeZone: "Europe/Madrid" };
    const next = nextOccurrence(schedule, new Date("2026-03-06T12:00:00.000Z"));
    assert.equal(wall(next, "Europe/Madrid"), "2026-03-07 00:30");
    assert.equal(next.toISOString(), "2026-03-06T23:30:00.000Z");
  });

  it("varios días eligen el más cercano", () => {
    // 2026-03-02 es lunes. Con lunes y jueves, desde el lunes por la tarde toca el jueves.
    const schedule: MonitorSchedule = {
      kind: "weekly",
      weekdays: [1, 4],
      hour: 9,
      minute: 0,
      timeZone: "Europe/Madrid",
    };
    const next = nextOccurrence(schedule, new Date("2026-03-02T15:00:00.000Z"));
    assert.equal(wall(next, "Europe/Madrid"), "2026-03-05 09:00");
  });

  it("el mismo día, si aún no ha llegado la hora, es hoy", () => {
    const schedule: MonitorSchedule = { kind: "weekly", weekdays: [1], hour: 23, minute: 0, timeZone: "UTC" };
    const next = nextOccurrence(schedule, new Date("2026-03-02T07:00:00.000Z"));
    assert.equal(next.toISOString(), "2026-03-02T23:00:00.000Z");
  });

  it("sin ningún día no es un horario", () => {
    const problems = scheduleProblems({ kind: "weekly", weekdays: [], hour: 9, minute: 0, timeZone: "UTC" });
    assert.ok(problems.some((problem) => problem.field === "schedule.weekdays"));
  });
});

describe("lo que no es un horario", () => {
  it("una zona inventada no vale: el monitor no volvería a disparar nunca", () => {
    assert.equal(isTimeZone("Europe/Madrid"), true);
    assert.equal(isTimeZone("Marte/Olympus"), false);
    const problems = scheduleProblems(daily(9, 0, "Marte/Olympus"));
    assert.ok(problems.some((problem) => problem.field === "schedule.timeZone"));
  });

  it("una hora fuera de rango tampoco", () => {
    assert.ok(scheduleProblems(daily(24, 0, "UTC")).some((problem) => problem.field === "schedule.hour"));
    assert.ok(scheduleProblems(daily(9, 60, "UTC")).some((problem) => problem.field === "schedule.minute"));
  });

  it("sin horario, o con una clase que no existe", () => {
    assert.deepEqual(scheduleProblems(undefined), [{ field: "schedule", detail: "Falta el horario" }]);
    assert.equal(scheduleProblems({ kind: "mensual" } as unknown as MonitorSchedule)[0]!.field, "schedule.kind");
  });
});

describe("cómo se lee", () => {
  it("las horas redondas se dicen en horas", () => {
    assert.equal(describeSchedule({ kind: "interval", minutes: 60 }), "cada hora");
    assert.equal(describeSchedule({ kind: "interval", minutes: 180 }), "cada 3 horas");
    assert.equal(describeSchedule({ kind: "interval", minutes: 15 }), "cada 15 minutos");
  });

  it("un diario y un semanal dicen su hora y su zona", () => {
    assert.equal(describeSchedule(daily(9, 5, "Europe/Madrid")), "todos los días a las 09:05 (Europe/Madrid)");
    assert.equal(
      describeSchedule({ kind: "weekly", weekdays: [3, 1], hour: 18, minute: 0, timeZone: "UTC" }),
      "lunes, miércoles a las 18:00 (UTC)",
    );
  });
});
