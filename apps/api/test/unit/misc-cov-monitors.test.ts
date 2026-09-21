/**
 * Los monitores por sus bordes: el aviso por cada canal cuando el entorno, la variable, el canal o
 * el correo fallan, y los comandos cuando el nombre se repite, se llega al tope, el canal no es
 * válido o el monitor no existe.
 */
import "reflect-metadata";
import { afterEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { MonitorAlerter, alertBody, alertText } from "@/modules/monitors/infrastructure/monitor-alert";
import {
  CreateMonitorCommand,
  CreateMonitorHandler,
  DeleteMonitorCommand,
  DeleteMonitorHandler,
  RunMonitorNowCommand,
  RunMonitorNowHandler,
  UpdateMonitorCommand,
  UpdateMonitorHandler,
} from "@/modules/monitors/application/commands/manage-monitors";
import { MAX_MONITORS_PER_PROJECT, blankMonitor, type Monitor, type MonitorAlert } from "@/modules/monitors/domain/model";
import type { MonitorSchedule } from "@/modules/monitors/domain/schedule";
import type { Environment } from "@/modules/environments/domain/model";
import type { SafeFetchPort, SafeFetchResult, SafeRequestOptions } from "@/shared/http/safe-fetch";
import type { Mail, MailerPort } from "@/shared/mail/mailer";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { loadEnv } from "@/shared/config/env";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import { InMemoryMonitorRepository } from "../support/in-memory-monitors";
import { InMemoryProjectRepository } from "../support/in-memory-repositories";
import { TEST_ENV } from "../support/test-app";

afterEach(() => mock.restoreAll());

const NOW = new Date("2026-03-01T10:00:00.000Z");
const HOURLY: MonitorSchedule = { kind: "interval", minutes: 60 };
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 8).toString("base64"));
const env = loadEnv({ ...TEST_ENV, APP_URL: "https://eq.test///" });

const monitor = (alert: MonitorAlert | null, name = "producción"): Monitor =>
  blankMonitor({
    projectId: "p-1",
    name,
    schedule: HOURLY,
    plan: { environmentId: "env-1" },
    alert,
    now: NOW,
    actorId: "u",
  });

const environment = (variables: Environment["variables"]): Environment =>
  ({ id: "env-1", projectId: "p-1", name: "prod", variables, disabledVariables: {} }) as unknown as Environment;

class FakeFetch implements SafeFetchPort {
  readonly calls: { url: string; body: unknown }[] = [];
  constructor(private readonly answer: () => Promise<number>) {}
  async get(url: string): Promise<SafeFetchResult> {
    return this.request(url, {});
  }
  async request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    this.calls.push({ url, body: JSON.parse(String(options.body ?? "null")) });
    const status = await this.answer();
    return {
      status,
      headers: {},
      setCookie: [],
      body: "",
      finalUrl: url,
      durationMs: 1,
      timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 },
    };
  }
}

class FakeMailer implements MailerPort {
  readonly sent: Mail[] = [];
  constructor(private readonly refuse: (to: string) => unknown = () => null) {}
  async send(mail: Mail): Promise<void> {
    const failure = this.refuse(mail.to);
    if (failure) throw failure;
    this.sent.push(mail);
  }
}

function alerter(options: { environment?: Environment | null; fetch?: FakeFetch; mailer?: FakeMailer } = {}) {
  const environments = {
    findById: async () => (options.environment === undefined ? environment({}) : options.environment),
  };
  const fetch = options.fetch ?? new FakeFetch(async () => 200);
  const mailer = options.mailer ?? new FakeMailer();
  return { alerter: new MonitorAlerter(environments as never, cipher, fetch, mailer, env), fetch, mailer };
}

const context = (patch: Record<string, unknown> = {}) => ({
  runId: null as string | null,
  outcome: "failed" as const,
  failures: 1,
  totals: null,
  note: "",
  ...patch,
});

describe("el texto y el cuerpo del aviso", () => {
  test("la recuperación, la caída sin totales con y sin nota, y la racha", () => {
    const base = { monitorName: "M", projectName: "P", outcome: "failed" as const, totals: null };
    assert.equal(alertText({ ...base, kind: "up", failures: 3, note: "" }), "✅ «M» (P) vuelve a estar verde tras 3 fallo(s) seguidos.");
    assert.equal(alertText({ ...base, kind: "down", failures: 1, note: "" }), "🔴 «M» (P): la corrida no llegó a ejecutarse.");
    assert.equal(alertText({ ...base, kind: "down", failures: 2, note: "sin entorno" }), "🔴 «M» (P): sin entorno (2 seguidos).");
    assert.equal(
      alertText({ ...base, kind: "down", failures: 1, note: "", totals: { cases: 9, passed: 6, failed: 3 } }),
      "🔴 «M» (P): 3 de 9 casos en rojo.",
    );
  });

  test("el webhook genérico lleva el monitor, la corrida y el evento; Slack sin corrida, una cadena vacía", () => {
    assert.deepEqual(alertBody("webhook", "t", { monitorId: "m", runId: null, kind: "up" }), {
      text: "t",
      monitorId: "m",
      runId: null,
      event: "up",
    });
    assert.ok(JSON.stringify(alertBody("slack", "t", { monitorId: "m", runId: null, kind: "down" })).includes('"t"'));
  });
});

describe("mandar el aviso", () => {
  test("sin aviso configurado no hace nada; sin entorno lo dice", async () => {
    assert.equal(await alerter().alerter.send(monitor(null), "P", "down", context()), "");
    const { alerter: noEnv } = alerter({ environment: null });
    assert.equal(
      await noEnv.send(monitor({ channel: "webhook", urlVariable: "HOOK", afterFailures: 1 }), "P", "down", context()),
      "El aviso no salió: el entorno del monitor ya no existe",
    );
  });

  test("un webhook sin variable, o con la variable vacía, no sale y dice por qué", async () => {
    const { alerter: a, fetch } = alerter({ environment: environment({ OTRA: { initial: "x", current: "", sensitive: false } }) });
    const note = await a.send(monitor({ channel: "webhook", afterFailures: 1 }), "P", "down", context());
    assert.match(note, /^El aviso no salió: La variable «» no está definida/);
    assert.equal(fetch.calls.length, 0);
  });

  test("el webhook sale redactado; un no-2xx se anota; la recuperación dice que salió", async () => {
    const statuses = [500, 204, 200];
    const fetch = new FakeFetch(async () => statuses.shift()!);
    const { alerter: a } = alerter({
      fetch,
      environment: environment({
        HOOK: { initial: "", current: cipher.encrypt("https://hooks.example.test/abc"), sensitive: true },
        TOKEN: { initial: cipher.encrypt("token-secreto-123"), current: "", sensitive: true },
        VACIO: { initial: "", current: "", sensitive: true },
      }),
    });
    const alert: MonitorAlert = { channel: "webhook", urlVariable: "HOOK", afterFailures: 1 };
    const failed = await a.send(monitor(alert, "mon token-secreto-123"), "P", "down", context({ runId: "r-1" }));
    assert.equal(failed, "El canal contestó 500 al aviso");
    assert.equal(fetch.calls[0]!.url, "https://hooks.example.test/abc");
    const sent = fetch.calls[0]!.body as { text: string; runId: string; event: string };
    assert.ok(!sent.text.includes("token-secreto-123"));
    assert.equal(sent.runId, "r-1");
    assert.equal(sent.event, "down");

    assert.equal(await a.send(monitor(alert), "P", "up", context({ failures: 2 })), "Aviso de recuperación enviado");
    assert.equal(await a.send(monitor(alert), "P", "down", context()), "Aviso de caída enviado");
  });

  test("un canal que falla con un Error tampoco cita la URL en la nota", async () => {
    mock.method(Logger.prototype, "warn", () => {});
    const { alerter: a } = alerter({
      fetch: new FakeFetch(() => Promise.reject(new Error("connect ECONNREFUSED https://hooks.example.test/abc"))),
      environment: environment({ HOOK: { initial: "https://hooks.example.test/abc", current: "", sensitive: false } }),
    });
    const note = await a.send(monitor({ channel: "slack", urlVariable: "HOOK", afterFailures: 1 }), "P", "down", context());
    assert.equal(note, "El aviso no salió: el canal no respondió");
  });

  test("un canal que lanza algo que no es un Error se anota sin citarlo", async () => {
    const warned = mock.method(Logger.prototype, "warn", () => {});
    const { alerter: a } = alerter({
      fetch: new FakeFetch(() => Promise.reject("https://hooks.example.test/abc caído")),
      environment: environment({ HOOK: { initial: "https://hooks.example.test/abc", current: "", sensitive: false } }),
    });
    const note = await a.send(monitor({ channel: "teams", urlVariable: "HOOK", afterFailures: 1 }), "P", "down", context());
    assert.equal(note, "El aviso no salió: el canal no respondió");
    assert.match(String(warned.mock.calls[0]!.arguments[0]), /caído/);
  });

  test("correo: sin destinatarios lo dice, y el enlace va a la pantalla de monitores", async () => {
    const { alerter: a, mailer } = alerter();
    assert.equal(
      await a.send(monitor({ channel: "email", afterFailures: 1 }), "P", "down", context()),
      "El aviso no salió: el monitor no tiene ningún destinatario",
    );
    const one = await a.send(monitor({ channel: "email", recipients: ["ana@example.test"], afterFailures: 1 }), "P", "up", context());
    assert.equal(one, "Aviso de recuperación enviado por correo a 1 destinatario");
    assert.ok(mailer.sent[0]!.text.endsWith("https://eq.test/p/p-1/monitors"));
  });

  test("correo: uno que falla no se lleva a los demás, y si fallan todos se dice", async () => {
    const warned = mock.method(Logger.prototype, "warn", () => {});
    const { alerter: some } = alerter({
      mailer: new FakeMailer((to) => (to.startsWith("mal") ? new Error("buzón lleno") : null)),
    });
    const alert: MonitorAlert = {
      channel: "email",
      recipients: ["mal@example.test", "bien@example.test", "otro@example.test"],
      afterFailures: 1,
    };
    assert.equal(await some.send(monitor(alert), "P", "down", context()), "Aviso de caída enviado por correo a 2 de 3");
    assert.equal(await some.send(monitor({ ...alert, recipients: ["bien@example.test", "otro@example.test"] }), "P", "down", context()),
      "Aviso de caída enviado por correo a 2 destinatarios");

    const { alerter: none } = alerter({ mailer: new FakeMailer(() => "rechazado") });
    assert.equal(await none.send(monitor(alert), "P", "down", context()), "El aviso no salió: el correo no se pudo entregar");
    // El log dice qué pasó; la nota no dice a quién.
    assert.ok(warned.mock.calls.some((call) => /rechazado/.test(String(call.arguments[0]))));
  });
});

/* ------------------------------------------------------------------ *
 * Los comandos
 * ------------------------------------------------------------------ */

const ORG = "org-1";
const clock = { now: () => NOW };

async function setup(channels: unknown = null) {
  const projects = new InMemoryProjectRepository();
  await projects.save({ id: "p-1", organizationId: ORG, archivedAt: null, deletedAt: null } as unknown as Project);
  const monitors = new InMemoryMonitorRepository();
  const create = new CreateMonitorHandler(projects, monitors, clock, channels as never);
  const update = new UpdateMonitorHandler(projects, monitors, clock, channels as never);
  const make = (name: string, plan: Record<string, unknown> = { environmentId: "env-1", workflowId: "w-1" }) =>
    create.execute(new CreateMonitorCommand(ORG, "p-1", { name, schedule: HOURLY, plan: plan as never }, "u"));
  return { projects, monitors, make, update };
}
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ConflictError || error instanceof NotFoundError);
  assert.equal((error as { code?: string }).code, expected);
  return true;
};
const CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

describe("gestionar monitores", () => {
  test("crear: nombre repetido y tope son 409", async () => {
    const { make } = await setup();
    await make(" vigía ");
    await assert.rejects(make("vigía"), code("monitor-duplicate-name"));
    for (let index = 1; index < MAX_MONITORS_PER_PROJECT; index += 1) await make(`m${index}`);
    await assert.rejects(make("uno más"), code("monitors-full"));
  });

  test("un canal mal escrito es un 422 con el campo; uno que no existe, o sin repositorio de canales, también", async () => {
    const { make } = await setup();
    await assert.rejects(make("c", { environmentId: "env-1", channel: { channelId: "no-uuid" } }), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.ok(error.fields.some((problem) => problem.field === "plan.channel.channelId"));
      return true;
    });
    await assert.rejects(make("c", { environmentId: "env-1", channel: { channelId: CHANNEL_ID } }), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.deepEqual(error.fields, [{ field: "plan.channel.channelId", detail: "el canal no existe en este proyecto" }]);
      return true;
    });

    const withChannels = await setup({ findById: async (_projectId: string, id: string) => (id === CHANNEL_ID ? { id } : null) });
    const created = await withChannels.make("c", { environmentId: "env-1", channel: { channelId: CHANNEL_ID, extra: "fuera" } });
    const stored = (await withChannels.monitors.findById("p-1", created.id))!;
    // Lo que se guarda es lo que el esquema dejó pasar.
    assert.deepEqual(stored.plan.channel, { channelId: CHANNEL_ID });
  });

  test("cambiar, borrar y correr uno que no existe es un 404; renombrar al de otro, un 409", async () => {
    const { projects, monitors, make, update } = await setup();
    const change = (id: string, input: Record<string, unknown>) =>
      update.execute(new UpdateMonitorCommand(ORG, "p-1", id, input as never));
    await assert.rejects(change("no", { name: "x" }), code("monitor-not-found"));
    await assert.rejects(
      new DeleteMonitorHandler(projects, monitors, clock).execute(new DeleteMonitorCommand(ORG, "p-1", "no")),
      code("monitor-not-found"),
    );
    const firer = { fire: mock.fn() };
    await assert.rejects(
      new RunMonitorNowHandler(projects, monitors, firer as never, clock).execute(new RunMonitorNowCommand(ORG, "p-1", "no")),
      code("monitor-not-found"),
    );
    assert.equal(firer.fire.mock.callCount(), 0);

    const a = await make("a");
    await make("b");
    await assert.rejects(change(a.id, { name: "b" }), code("monitor-duplicate-name"));
    await assert.rejects(change(a.id, { name: "" }), InvalidInputError);
    const same = await change(a.id, { name: "a" });
    assert.equal(same.name, "a");
  });
});
