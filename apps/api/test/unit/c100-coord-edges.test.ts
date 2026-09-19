/**
 * Bordes sueltos que ninguna otra prueba fija, y que conviene fijar aquí: los datos llegan del
 * cuerpo de una petición, no del tipo, y el tipo no impide que falten.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { scheduleProblems, type MonitorSchedule } from "@/modules/monitors/domain/schedule";

describe("el horario semanal sin la lista de días", () => {
  test("un «weekly» al que le falta `weekdays` pide elegir al menos un día", () => {
    const sinDias = { kind: "weekly", hour: 9, minute: 30, timeZone: "Europe/Madrid" } as unknown as MonitorSchedule;

    assert.deepEqual(scheduleProblems(sinDias), [
      { field: "schedule.weekdays", detail: "Elige al menos un día de la semana" },
    ]);
  });
});
