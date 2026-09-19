/**
 * Los monitores en lo que el turno de la aplicación de prueba no deja ver: la vuelta abierta que
 * nunca tuvo corrida, la corrida que terminó sin fecha o que la retención ya borró, el monitor de
 * un proyecto borrado, el monitor borrado a media corrida, y el reloj que llama al turno.
 */
import "reflect-metadata";
import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { MonitorFirer } from "@/modules/monitors/application/commands/fire-monitor";
import { FireDueMonitorsCommand, FireDueMonitorsHandler } from "@/modules/monitors/application/commands/fire-due-monitors";
import { CloseMonitorExecutionHandler } from "@/modules/monitors/application/events/close-monitor-execution";
import { MonitorScheduler } from "@/modules/monitors/infrastructure/monitor.scheduler";
import { MonitorAlerter } from "@/modules/monitors/infrastructure/monitor-alert";
import {
  MAX_MONITOR_NAME,
  blankExecution,
  blankMonitor,
  monitorProblems,
  viewExecution,
  type Monitor,
  type MonitorExecution,
} from "@/modules/monitors/domain/model";
import {
  DEFAULT_TIME_ZONE,
  MAX_INTERVAL_MINUTES,
  describeSchedule,
  nextOccurrence,
  scheduleProblems,
  wallTime,
  type MonitorSchedule,
} from "@/modules/monitors/domain/schedule";
import { RunFinishedEvent } from "@/modules/runs/application/events/run.events";
import type { Run } from "@/modules/runs/domain/model";
import type { Project } from "@/modules/projects/domain/model";
import type { Environment } from "@/modules/environments/domain/model";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { loadEnv } from "@/shared/config/env";
import { InMemoryMonitorRepository } from "../support/in-memory-monitors";
import { InMemoryProjectRepository } from "../support/in-memory-repositories";
import { TEST_ENV } from "../support/test-app";

afterEach(() => mock.restoreAll());

const NOW = new Date("2026-03-01T10:00:00.000Z");
const LATER = new Date("2026-03-01T11:00:00.000Z");

const monitorOf = (patch: Partial<Monitor> = {}): Monitor => ({
  ...blankMonitor({
    projectId: "p-1",
    name: "producción",
    schedule: { kind: "interval", minutes: 60 },
    plan: { environmentId: "env-1" },
    alert: null,
    now: NOW,
    actorId: "u",
  }),
  ...patch,
});

const openExecution = (monitor: Monitor, runId: string | null): MonitorExecution =>
  blankExecution({ monitorId: monitor.id, projectId: monitor.projectId, runId, outcome: "running", now: NOW });

async function firerWith(runs: Record<string, Partial<Run>>) {
  const monitors = new InMemoryMonitorRepository();
  const projects = new InMemoryProjectRepository();
  await projects.save({ id: "p-1", organizationId: "org-1", name: "P", deletedAt: null } as unknown as Project);
  const started: unknown[] = [];
  const commandBus = {
    execute: async (command: unknown) => {
      started.push(command);
      return { runId: "run-nueva" };
    },
  };
  const alerter = { send: async () => "" };
  const firer = new MonitorFirer(
    commandBus as never,
    monitors,
    { findById: async (id: string) => (runs[id] as Run | undefined) ?? null } as never,
    projects,
    alerter as never,
  );
  return { monitors, projects, firer, started };
}

describe("lanzar un monitor con una vuelta anterior abierta", () => {
  test("una vuelta abierta sin corrida se cierra en error y el turno se lanza", async () => {
    const { monitors, firer, started } = await firerWith({});
    const monitor = monitorOf();
    await monitors.save(monitor);
    const stuck = openExecution(monitor, null);
    await monitors.saveExecution(stuck);

    const fired = await firer.fire(monitor, "org-1", LATER);
    assert.equal(fired.runId, "run-nueva");
    assert.equal(started.length, 1);
    const closed = monitors.executions.get(stuck.id)!;
    assert.equal(closed.outcome, "error");
    assert.equal(closed.note, "Quedó sin cerrar");
    assert.deepEqual(closed.finishedAt, LATER);
  });

  test("una corrida terminada sin fecha de fin cierra la vuelta con su estado y la hora del turno", async () => {
    const { monitors, firer } = await firerWith({ "run-vieja": { status: "passed", finishedAt: null } });
    const monitor = monitorOf();
    const stuck = openExecution(monitor, "run-vieja");
    await monitors.saveExecution(stuck);

    await firer.fire(monitor, "org-1", LATER);
    const closed = monitors.executions.get(stuck.id)!;
    assert.equal(closed.outcome, "passed");
    assert.deepEqual(closed.finishedAt, LATER);
    assert.equal(closed.note, "");
  });

  test("una corrida terminada con su fecha la conserva", async () => {
    const ended = new Date("2026-03-01T10:05:00.000Z");
    const { monitors, firer } = await firerWith({ "run-vieja": { status: "failed", finishedAt: ended } });
    const monitor = monitorOf();
    const stuck = openExecution(monitor, "run-vieja");
    await monitors.saveExecution(stuck);

    await firer.fire(monitor, "org-1", LATER);
    const closed = monitors.executions.get(stuck.id)!;
    assert.equal(closed.outcome, "failed");
    assert.deepEqual(closed.finishedAt, ended);
  });

  test("una corrida que ya no existe cierra la vuelta en error con la nota", async () => {
    const { monitors, firer } = await firerWith({});
    const monitor = monitorOf();
    const stuck = openExecution(monitor, "run-borrada");
    await monitors.saveExecution(stuck);

    await firer.fire(monitor, "org-1", LATER);
    const closed = monitors.executions.get(stuck.id)!;
    assert.equal(closed.outcome, "error");
    assert.equal(closed.note, "La corrida ya no existe");
    assert.deepEqual(closed.finishedAt, LATER);
  });
});

describe("el turno", () => {
  test("un monitor de un proyecto borrado o que ya no existe se apaga sin lanzar nada", async () => {
    const monitors = new InMemoryMonitorRepository();
    const projects = new InMemoryProjectRepository();
    await projects.save({ id: "p-borrado", organizationId: "org-1", deletedAt: NOW } as unknown as Project);
    const orphan = monitorOf({ projectId: "p-inexistente", nextRunAt: NOW });
    const deleted = monitorOf({ projectId: "p-borrado", nextRunAt: NOW });
    await monitors.save(orphan);
    await monitors.save(deleted);
    const fired: string[] = [];
    const handler = new FireDueMonitorsHandler(
      monitors,
      projects,
      { fire: async (monitor: Monitor) => fired.push(monitor.id) } as never,
      { now: () => LATER },
    );

    const result = await handler.execute();
    assert.deepEqual(result, { claimed: 2, started: 0, skipped: 0, failed: 0 });
    assert.deepEqual(fired, []);
    for (const monitor of [orphan, deleted]) {
      const row = monitors.rows.get(monitor.id)!;
      assert.equal(row.enabled, false);
      assert.equal(row.nextRunAt, null);
      assert.deepEqual(row.updatedAt, LATER);
    }
  });

  test("la corrida de un monitor borrado a medias cierra su vuelta igual, sin avisar", async () => {
    const monitors = new InMemoryMonitorRepository();
    const monitor = monitorOf();
    const open = openExecution(monitor, "run-1");
    await monitors.saveExecution(open);
    const alerts: unknown[] = [];
    const handler = new CloseMonitorExecutionHandler(
      monitors,
      new InMemoryProjectRepository(),
      { send: async (...args: unknown[]) => alerts.push(args) } as never,
      { now: () => LATER },
    );

    await handler.handle(new RunFinishedEvent("p-1", "run-1", "failed", { cases: 3, passed: 1, failed: 2 } as never));
    const closed = monitors.executions.get(open.id)!;
    assert.equal(closed.outcome, "failed");
    assert.deepEqual(closed.finishedAt, LATER);
    assert.deepEqual(closed.totals, { cases: 3, passed: 1, failed: 2 });
    assert.deepEqual(alerts, []);
    assert.equal(monitors.rows.size, 0);
  });

  test("el reloj llama al turno cada tanto y anota lo que hizo", async () => {
    let every: (() => void) | null = null;
    let seconds = 0;
    mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
      every = callback;
      seconds = ms / 1000;
      return { unref() {} } as unknown as NodeJS.Timeout;
    });
    mock.method(globalThis, "clearInterval", () => undefined);
    const logged: string[] = [];
    mock.method(Logger.prototype, "log", (message: string) => logged.push(message));
    const commands: unknown[] = [];
    const scheduler = new MonitorScheduler(
      {
        execute: async (command: unknown) => {
          commands.push(command);
          return { claimed: 2, started: 1, skipped: 1, failed: 0 };
        },
      } as never,
      { MONITOR_TICK_SECONDS: 30 } as never,
    );

    scheduler.onApplicationBootstrap();
    assert.equal(seconds, 30);
    assert.equal(commands.length, 0, "nada al arrancar");
    every!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commands.length, 1);
    assert.ok(commands[0] instanceof FireDueMonitorsCommand);
    assert.ok(logged.includes("Turno: 2 vencidos · 1 lanzados · 1 saltados · 0 con error"), logged.join("\n"));
    scheduler.onApplicationShutdown();
  });
});

describe("el aviso con un canal a medio configurar", () => {
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 8).toString("base64"));
  const env = loadEnv({ ...TEST_ENV });
  const environment = {
    id: "env-1",
    projectId: "p-1",
    name: "prod",
    variables: { token: { initial: cipher.encrypt("s3creto"), current: "", sensitive: true } },
    disabledVariables: {},
  } as unknown as Environment;
  const alerter = () => {
    const sent: unknown[] = [];
    const fetched: unknown[] = [];
    const instance = new MonitorAlerter(
      { findById: async () => environment } as never,
      cipher,
      { request: async (url: string) => fetched.push(url) } as never,
      { send: async (mail: unknown) => sent.push(mail) } as never,
      env,
    );
    return { instance, sent, fetched };
  };
  const context = { runId: null, outcome: "failed" as const, failures: 1, totals: null, note: "" };

  test("un correo sin lista de destinatarios no sale, y lo dice", async () => {
    const { instance, sent } = alerter();
    const monitor = monitorOf({ alert: { channel: "email", afterFailures: 1 } });
    assert.equal(
      await instance.send(monitor, "P", "down", context),
      "El aviso no salió: el monitor no tiene ningún destinatario",
    );
    assert.deepEqual(sent, []);
  });

  test("un webhook sin variable de URL no sale, y lo dice", async () => {
    const { instance, fetched } = alerter();
    const monitor = monitorOf({ alert: { channel: "slack", afterFailures: 1 } });
    const note = await instance.send(monitor, "P", "down", context);
    assert.match(note, /^El aviso no salió: /);
    assert.deepEqual(fetched, []);
  });
});

describe("el dominio de los monitores", () => {
  test("un nombre demasiado largo no vale", () => {
    assert.deepEqual(monitorProblems({ name: "x".repeat(MAX_MONITOR_NAME + 1) }), [
      { field: "name", detail: `Como mucho ${MAX_MONITOR_NAME} caracteres` },
    ]);
  });

  test("una vuelta abierta se enseña sin fecha de fin", () => {
    const view = viewExecution(openExecution(monitorOf(), "run-1"));
    assert.equal(view.finishedAt, null);
    assert.equal(view.startedAt, NOW.toISOString());
  });

  test("el horario: un intervalo de más, y días de la semana fuera de rango", () => {
    assert.deepEqual(scheduleProblems({ kind: "interval", minutes: MAX_INTERVAL_MINUTES + 1 }), [
      { field: "schedule.minutes", detail: `Como mucho ${MAX_INTERVAL_MINUTES} minutos; para más, usa «weekly»` },
    ]);
    const weekly = (weekdays: number[]): MonitorSchedule =>
      ({ kind: "weekly", hour: 9, minute: 0, timeZone: "Europe/Madrid", weekdays }) as MonitorSchedule;
    for (const bad of [[7], [-1], [1.5]]) {
      assert.deepEqual(scheduleProblems(weekly(bad)), [
        { field: "schedule.weekdays", detail: "Los días van de 0 (domingo) a 6 (sábado)" },
      ]);
    }
    assert.deepEqual(scheduleProblems(weekly([0, 6])), []);
  });

  test("sin zona se cuenta en la de por omisión; sin días no hay turno siguiente", () => {
    const daily = { kind: "daily", hour: 9, minute: 30, timeZone: "" } as MonitorSchedule;
    assert.deepEqual(nextOccurrence(daily, NOW), new Date("2026-03-02T09:30:00.000Z"));
    assert.deepEqual(
      nextOccurrence(daily, NOW),
      nextOccurrence({ ...daily, timeZone: DEFAULT_TIME_ZONE } as MonitorSchedule, NOW),
    );
    const never = { kind: "weekly", hour: 9, minute: 0, timeZone: "UTC", weekdays: [] } as unknown as MonitorSchedule;
    assert.throws(() => nextOccurrence(never, NOW), /El horario no tiene ningún turno siguiente/);
  });

  test("la hora de pared y un día que no existe al describir", () => {
    assert.deepEqual(wallTime(new Date("2026-07-01T00:30:15.000Z"), "Europe/Madrid"), {
      year: 2026,
      month: 7,
      day: 1,
      hour: 2,
      minute: 30,
      second: 15,
    });
    const odd = { kind: "weekly", hour: 7, minute: 5, timeZone: "UTC", weekdays: [9, 1] } as MonitorSchedule;
    assert.equal(describeSchedule(odd), "lunes, ? a las 07:05 (UTC)");
  });
});
