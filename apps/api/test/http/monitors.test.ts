/**
 * Los monitores, por HTTP y contra un servidor de verdad.
 *
 * Lo que estas pruebas demuestran y las unitarias no pueden: que **el turno lanza la misma corrida
 * que el botón**, que la vuelta se cierra con el resultado que de verdad tuvo, y que el aviso sale
 * con la URL que vive en el entorno y no con una escrita en la fila del monitor.
 *
 * El aviso por correo se comprueba contra el `RecordingMailer` del arnés, que es el único sitio por
 * donde se puede leer un correo: la suite no manda correo a ninguna parte, y el driver por omisión
 * de una instalación escribe en el log.
 *
 * El turno se dispara a mano con `FireDueMonitorsCommand` en vez de esperar al reloj: lo que hay
 * que probar es lo que hace el turno, y esperar sesenta segundos por prueba sería una suite que
 * nadie ejecuta. El reloj en sí es un `setInterval` de doce líneas.
 *
 * Lo que aquí **no** se prueba, y hay que decirlo: que dos instancias no disparen el mismo monitor.
 * Eso lo hace `FOR UPDATE SKIP LOCKED` en Postgres, y el repositorio en memoria no tiene bloqueos
 * que imitar. Se comprueba contra la base de datos de verdad.
 */
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { CommandBus } from "@nestjs/cqrs";

import { FireDueMonitorsCommand } from "@/modules/monitors/application/commands/fire-due-monitors";
import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML, type StubFaults } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  return {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    token: session.body.accessToken,
  };
}

/** Mete a alguien en la organización con el rol que se diga, sin pasar por la invitación. */
async function joinAs(actor: Actor, organizationId: string, role: "viewer" | "editor" | "admin") {
  await context.repositories.memberships.save({
    organizationId,
    userId: actor.userId,
    role,
    createdAt: context.clock.now(),
  });
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;

/** Un proyecto con contrato, entorno y objetivo: lo mínimo para que una corrida exista. */
async function projectAgainst(faults: StubFaults = {}, variables: Record<string, unknown> = {}) {
  const target = new StubTarget(faults);
  await target.start();
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `mon-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;

  const imported = await api()
    .post(`${projectBase}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  await api()
    .put(`${projectBase}/config/parameters`)
    .set(as(owner))
    .send({
      parameterSamples: {},
      fallbackSamples: ["test"],
      excludeFromSoloScenarios: [],
      pathDefaults: { id: "1" },
      fallbackPathValue: "1",
      missingIdValue: "no-existe",
    });
  const environment = await api()
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: "stub",
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: true,
      authEnforced: false,
      variables,
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  return { target, projectBase, environmentId: environment.body.environmentId as string };
}

/**
 * Otro entorno del mismo proyecto, contra un objetivo que no falla.
 *
 * Es el camino al verde: un monitor se pone en rojo contra el objetivo roto, se le cambia el plan a
 * este, y la vuelta siguiente pasa. Se hace así —por la API, cambiando el plan— y no tocando los
 * fallos del objetivo por dentro, para que la recuperación que se prueba sea una corrida que de
 * verdad salió bien.
 */
async function healthyEnvironmentIn(projectBase: string): Promise<string> {
  const target = new StubTarget();
  await target.start();
  const environment = await api()
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: `sano-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: true,
      authEnforced: false,
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  return environment.body.environmentId as string;
}

type MonitorRow = {
  id: string;
  name: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastOutcome: string | null;
  consecutiveFailures: number;
  scheduleLabel: string;
  alert: Record<string, unknown> | null;
  recent: { outcome: string; runId: string | null; note: string; totals: unknown }[];
};

async function createMonitor(
  projectBase: string,
  body: Record<string, unknown>,
): Promise<{ id: string; nextRunAt: string | null }> {
  const created = await api().post(`${projectBase}/monitors`).set(as(owner)).send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

const list = async (projectBase: string): Promise<MonitorRow[]> =>
  (await api().get(`${projectBase}/monitors`).set(as(owner))).body.monitors;

/**
 * Adelanta el reloj de la aplicación hasta pasado el turno.
 *
 * Se mueve el reloj en vez de tocar la columna `nextRunAt`, y no es lo mismo: así lo que se prueba
 * es la condición del reclamo de verdad —«vencido y encendido»— y no una fila preparada para que
 * encaje.
 */
const advance = (minutes: number) => context.clock.advance(minutes * 60_000);

/** El turno del monitor, tal y como está guardado. */
const turnOf = (monitorId: string) => {
  const row = context.repositories.monitors.rows.get(monitorId);
  assert.ok(row, "el monitor no está en el almacén");
  return row.nextRunAt;
};

/** Un turno completo, y la espera a que el trabajador acabe lo que haya lanzado. */
async function tick() {
  const result = await context.app.get(CommandBus).execute(new FireDueMonitorsCommand());
  await context.queue.idle();
  return result as { claimed: number; started: number; skipped: number; failed: number };
}

before(async () => {
  context = await createTestApp();
  owner = await signUp(`monitors-${Date.now()}@example.test`);
});

after(async () => {
  await context?.close();
});

/** El proyecto acepta diez monitores; dejarlos acumulados haría fallar a la undécima prueba. */
afterEach(async () => {
  for (const monitor of context.repositories.monitors.rows.values()) {
    context.repositories.monitors.rows.delete(monitor.id);
  }
  context.repositories.monitors.executions.clear();
  context.http.calls.length = 0;
  context.mailer.sent.length = 0;
});

describe("crear un monitor", () => {
  test("hace falta un horario y un entorno", async () => {
    const { projectBase } = await projectAgainst();
    // Sin horario ni plan lo para el DTO, que es la forma del cuerpo.
    const sin = await api().post(`${projectBase}/monitors`).set(as(owner)).send({ name: "sin nada" });
    assert.equal(sin.status, 422);
    const fields = (sin.body.errors as { field: string }[]).map((error) => error.field);
    assert.ok(fields.includes("schedule"), JSON.stringify(sin.body.errors));
    assert.ok(fields.includes("plan"), JSON.stringify(sin.body.errors));

    // Con un plan vacío pasa el DTO y lo para el dominio, que es el que sabe qué es un monitor.
    const vacio = await api()
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({ name: "plan vacío", schedule: { kind: "interval", minutes: 60 }, plan: {} });
    assert.equal(vacio.status, 422);
    assert.equal(vacio.body.errors[0].field, "plan.environmentId");
  });

  test("no baja de cinco minutos: cada turno es una corrida entera", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const corto = await api()
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({ name: "cada minuto", schedule: { kind: "interval", minutes: 1 }, plan: { environmentId } });
    assert.equal(corto.status, 422);
    assert.equal(corto.body.errors[0].field, "schedule.minutes");
  });

  test("crear no lanza nada: el primer turno es dentro de un rato", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const created = await createMonitor(projectBase, {
      name: "producción",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId },
    });
    assert.ok(created.nextRunAt && new Date(created.nextRunAt).getTime() > context.clock.now().getTime());
    // Y no hay ninguna vuelta: quien escribió un horario no pidió una corrida.
    const [row] = await list(projectBase);
    assert.deepEqual(row!.recent, []);
    assert.equal(row!.scheduleLabel, "cada hora");
  });

  test("el aviso pide el nombre de una variable, no una URL", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const malo = await api()
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({
        name: "con url dentro",
        schedule: { kind: "interval", minutes: 60 },
        plan: { environmentId },
        alert: { channel: "slack", urlVariable: "https://hooks.slack.test/xyz", afterFailures: 1 },
      });
    assert.equal(malo.status, 422);
    assert.equal(malo.body.errors[0].field, "alert.urlVariable");
  });

  test("el aviso por correo pide direcciones, y no el nombre de una variable", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const base = { name: "por correo", schedule: { kind: "interval", minutes: 60 }, plan: { environmentId } };

    // Un nombre de variable en un aviso por correo es el campo del otro canal, sin destinatarios.
    const variable = await api()
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({ ...base, alert: { channel: "email", urlVariable: "MAIL_GUARDIA", afterFailures: 1 } });
    assert.equal(variable.status, 422);
    assert.equal(variable.body.errors[0].field, "alert.recipients");

    const mala = await api()
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({ ...base, alert: { channel: "email", recipients: ["no-es-un-correo"], afterFailures: 1 } });
    assert.equal(mala.status, 422);
    assert.equal(mala.body.errors[0].field, "alert.recipients");
    // El detalle no repite la dirección: un error de API se registra y se pega en un ticket.
    assert.ok(!JSON.stringify(mala.body).includes("no-es-un-correo"), JSON.stringify(mala.body));

    // Y la buena se guarda con la dirección en claro, que es la decisión de este canal: un
    // destinatario no autoriza nada, y hay que poder ver a quién se despierta.
    const buena = await createMonitor(projectBase, {
      ...base,
      alert: { channel: "email", recipients: [" guardia@ejemplo.test "], afterFailures: 1 },
    });
    const [row] = await list(projectBase);
    assert.equal(row!.id, buena.id);
    assert.deepEqual(row!.alert, { channel: "email", recipients: ["guardia@ejemplo.test"], afterFailures: 1 });
  });
});

describe("el turno", () => {
  test("lanza la corrida, la etiqueta como del monitor, y la deja verde", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "verde",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });

    advance(61);
    const result = await tick();
    assert.deepEqual({ claimed: result.claimed, started: result.started }, { claimed: 1, started: 1 });

    const [row] = await list(projectBase);
    assert.equal(row!.recent.length, 1);
    assert.equal(row!.recent[0]!.outcome, "passed");
    assert.equal(row!.lastOutcome, "passed");
    assert.equal(row!.consecutiveFailures, 0);

    // La corrida es una corrida normal, y dice quién la pidió: un monitor, no una persona.
    const runId = row!.recent[0]!.runId!;
    const run = await api().get(`${projectBase}/runs/${runId}`).set(as(owner));
    assert.equal(run.status, 200);
    assert.equal(run.body.triggeredByKind, "monitor");
    assert.equal(run.body.triggeredBy, monitor.id);
  });

  test("adelanta el turno al reclamarlo, así que el tic siguiente no lo vuelve a tomar", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    await createMonitor(projectBase, {
      name: "una vez",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    advance(61);
    assert.equal((await tick()).claimed, 1);
    // Sin adelantar el turno dentro del reclamo, esto sería una corrida por tic para siempre.
    assert.equal((await tick()).claimed, 0);
  });

  test("un turno perdido no se acumula: ocho horas caído no son ocho corridas", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "cada hora",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    // Ocho horas de reloj sin que nadie mirase, como un proceso caído.
    advance(8 * 60);
    const result = await tick();
    assert.equal(result.started, 1);
    // Una corrida, no ocho. Y el turno siguiente es dentro de una hora **desde ahora**, no siete
    // horas por detrás como habría salido sumando al turno perdido.
    const minutes = (turnOf(monitor.id)!.getTime() - context.clock.now().getTime()) / 60_000;
    assert.equal(minutes, 60);
  });

  test("si la anterior sigue viva, el turno se salta y dice por qué", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "lento",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });

    // Una vuelta abierta cuya corrida está en cola: es exactamente el caso del monitor cada cinco
    // minutos contra una API que tarda seis.
    const queued = await api()
      .post(`${projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId, operationIds: ["listThings"] });
    assert.equal(queued.status, 202);
    context.repositories.monitors.executions.set("abierta", {
      id: "abierta",
      monitorId: monitor.id,
      projectId: context.repositories.monitors.rows.get(monitor.id)!.projectId,
      runId: queued.body.runId,
      outcome: "running",
      startedAt: context.clock.now(),
      finishedAt: null,
      totals: null,
      note: "",
    });

    advance(61);
    const result = await tick();
    assert.deepEqual({ started: result.started, skipped: result.skipped }, { started: 0, skipped: 1 });
    const [row] = await list(projectBase);
    const skipped = row!.recent.find((execution) => execution.outcome === "skipped");
    assert.ok(skipped, "no se anotó la vuelta saltada");
    assert.match(skipped.note, /seguía en marcha/);
    // Saltar no es fallar: la racha no se mueve.
    assert.equal(row!.consecutiveFailures, 0);
  });

  test("una vuelta abierta cuya corrida ya terminó no bloquea el monitor para siempre", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "huérfana",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    // Es lo que queda cuando un proceso se muere con una corrida a medias: la fila dice «running»
    // y la corrida ya no. Sin cerrarla al pasar, el monitor no volvería a disparar nunca.
    context.repositories.monitors.executions.set("colgada", {
      id: "colgada",
      monitorId: monitor.id,
      projectId: context.repositories.monitors.rows.get(monitor.id)!.projectId,
      runId: "00000000-0000-4000-8000-000000000999",
      outcome: "running",
      startedAt: context.clock.now(),
      finishedAt: null,
      totals: null,
      note: "",
    });

    advance(61);
    assert.equal((await tick()).started, 1);
    const [row] = await list(projectBase);
    const closed = row!.recent.find((execution) => execution.note === "La corrida ya no existe");
    assert.ok(closed, "la vuelta colgada no se cerró");
  });

  test("un plan que dejó de ser válido deja la vuelta en error y no rompe el turno", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    await createMonitor(projectBase, {
      name: "flujo borrado",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, workflowId: "00000000-0000-4000-8000-000000000123" },
    });
    await createMonitor(projectBase, {
      name: "sano",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    advance(61);

    const result = await tick();
    assert.equal(result.claimed, 2);
    // El roto se anota y el sano corre: un monitor con el plan estropeado no apaga la vigilancia.
    assert.equal(result.failed, 1);
    assert.equal(result.started, 1);

    const rows = await list(projectBase);
    const failed = rows.find((row) => row.name === "flujo borrado")!;
    assert.equal(failed.recent[0]!.outcome, "error");
    assert.match(failed.recent[0]!.note, /flujo/i);
    assert.equal(failed.consecutiveFailures, 1);
  });

  test("y el plan roto avisa, que es cuando lo roto es la vigilancia", async () => {
    // El fallo que esto pilla: el aviso lo mandaba sólo `CloseMonitorExecutionHandler`, al terminar
    // la corrida. Una vuelta que muere **antes** de tener corrida no tiene final que escuchar, así
    // que el monitor sumaba fallos en silencio justo en el caso en el que nadie va a notar nada:
    // el entorno borrado, el contrato sin importar, el flujo que ya no está.
    const { projectBase, environmentId } = await projectAgainst();
    await createMonitor(projectBase, {
      name: "roto y con guardia",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, workflowId: "00000000-0000-4000-8000-000000000789" },
      alert: { channel: "email", recipients: ["guardia@ejemplo.com"], afterFailures: 1 },
    });

    advance(61);
    assert.equal((await tick()).failed, 1);

    const [mail] = context.mailer.sent;
    assert.ok(mail, "un monitor con el plan roto tiene que avisar");
    assert.equal(mail.to, "guardia@ejemplo.com");
    assert.match(mail.subject, /roto y con guardia/);

    // Y una sola vez por racha: el segundo turno suma el fallo y no vuelve a escribir.
    advance(61);
    await tick();
    assert.equal(context.mailer.sent.length, 1);

    // La nota de la vuelta sigue explicando el fallo, que es lo que se lee en la pantalla.
    const rows = await list(projectBase);
    assert.match(rows.find((row) => row.name === "roto y con guardia")!.recent[0]!.note, /flujo/i);
  });

  test("una vuelta con error también deja el turno adelantado", async () => {
    // El fallo que esto pilla: el reclamo adelanta el turno en la base de datos y el guardado que
    // cierra la vuelta —con la racha y el último resultado— lo pisa con el objeto que se recibió.
    // El monitor vuelve a estar vencido y dispara en **cada** tic. Solo se ve en el camino que
    // guarda el monitor, que es el de las vueltas que no lanzan corrida.
    const { projectBase, environmentId } = await projectAgainst();
    const roto = await createMonitor(projectBase, {
      name: "turno tras error",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, workflowId: "00000000-0000-4000-8000-000000000456" },
    });

    advance(61);
    assert.equal((await tick()).failed, 1);
    const minutes = (turnOf(roto.id)!.getTime() - context.clock.now().getTime()) / 60_000;
    assert.equal(minutes, 60, "el turno no quedó adelantado tras una vuelta con error");
    // Y por tanto el tic siguiente no lo vuelve a tomar.
    assert.equal((await tick()).claimed, 0);
  });

  test("un monitor apagado no lo toma nadie, aunque esté vencido", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "apagable",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    const off = await api().patch(`${projectBase}/monitors/${monitor.id}`).set(as(owner)).send({ enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.nextRunAt, null);

    advance(61);
    // Vencido lo estaría, si tuviera turno. Apagado no tiene, y el reclamo mira las dos cosas.
    assert.equal((await tick()).claimed, 0);
  });
});

describe("la racha y el aviso", () => {
  test("un rojo sube la racha y un verde la pone a cero", async () => {
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true });
    await createMonitor(projectBase, {
      name: "rojo",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });

    advance(61);
    await tick();
    let [row] = await list(projectBase);
    assert.equal(row!.recent[0]!.outcome, "failed");
    assert.equal(row!.consecutiveFailures, 1);
    // La vuelta guarda cuántos casos y cuántos en rojo: es el historial que sobrevive al barrido
    // de retención de corridas.
    assert.ok(row!.recent[0]!.totals);

    advance(61);
    await tick();
    [row] = await list(projectBase);
    assert.equal(row!.consecutiveFailures, 2);
  });

  test("el aviso sale con la URL del entorno, y la fila del monitor no la lleva dentro", async () => {
    const webhook = "https://hooks.ejemplo.test/monitor";
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true }, { SLACK_WEBHOOK: webhook });
    context.http.reply(webhook, "ok");

    const monitor = await createMonitor(projectBase, {
      name: "con aviso",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "slack", urlVariable: "SLACK_WEBHOOK", afterFailures: 1 },
    });

    advance(61);
    await tick();

    const sent = context.http.calls.filter((call) => call.url === webhook);
    assert.equal(sent.length, 1, "no salió el aviso");
    const body = JSON.parse(sent[0]!.body ?? "{}") as { text: string };
    assert.match(body.text, /con aviso/);
    assert.match(body.text, /🔴/);

    // Lo que se guarda es el nombre de la variable. La URL no está en la fila ni en lo que sale
    // por la API: quien la tiene puede escribir en ese canal.
    const stored = JSON.stringify(context.repositories.monitors.rows.get(monitor.id));
    assert.ok(!stored.includes("hooks.ejemplo.test"), "la URL del webhook se guardó en la fila");
    const listed = JSON.stringify(await list(projectBase));
    assert.ok(!listed.includes("hooks.ejemplo.test"), "la URL del webhook sale por la API");
  });

  test("con «al segundo fallo», el primero calla y el tercero ya no repite", async () => {
    const webhook = "https://hooks.ejemplo.test/umbral";
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true }, { SLACK_WEBHOOK: webhook });
    context.http.reply(webhook, "ok");
    await createMonitor(projectBase, {
      name: "umbral",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "slack", urlVariable: "SLACK_WEBHOOK", afterFailures: 2 },
    });

    const fire = async () => {
      advance(61);
      await tick();
      return context.http.calls.filter((call) => call.url === webhook).length;
    };

    assert.equal(await fire(), 0, "avisó al primer fallo");
    assert.equal(await fire(), 1, "no avisó al segundo");
    // Un servicio caído toda la noche mandaría un aviso por turno, y el canal acabaría silenciado.
    assert.equal(await fire(), 1, "repitió el aviso");
  });

  test("un aviso que no sale se anota y el monitor sigue vigilando", async () => {
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true });
    await createMonitor(projectBase, {
      name: "sin variable",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "slack", urlVariable: "NO_DEFINIDA", afterFailures: 1 },
    });

    advance(61);
    await tick();
    const [row] = await list(projectBase);
    // Lo contrario —que un webhook mal escrito apague la vigilancia— es el peor de los dos fallos.
    assert.equal(row!.recent[0]!.outcome, "failed");
    assert.match(row!.recent[0]!.note, /no está definida/);
    assert.equal(row!.consecutiveFailures, 1);
  });

  test("el aviso por correo sale una vez por racha, y la recuperación cuando vuelve el verde", async () => {
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true });
    const sano = await healthyEnvironmentIn(projectBase);
    const monitor = await createMonitor(projectBase, {
      name: "guardia de pagos",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "email", recipients: ["guardia@ejemplo.test", "jefa@ejemplo.test"], afterFailures: 2 },
    });

    const fire = async () => {
      advance(61);
      await tick();
      return context.mailer.sent.length;
    };

    assert.equal(await fire(), 0, "avisó al primer fallo, y el umbral eran dos");
    // Dos correos y no uno: el puerto manda a una dirección, así que sale uno por destinatario y
    // una que rebota no se lleva por delante el aviso de la otra.
    assert.equal(await fire(), 2, "no avisó al llegar al umbral");
    assert.deepEqual(context.mailer.sent.map((mail) => mail.to).sort(), ["guardia@ejemplo.test", "jefa@ejemplo.test"]);

    const down = context.mailer.sent[0]!;
    // El asunto se lee en una bandeja llena: el color, el monitor, y qué le pasa.
    assert.match(down.subject, /🔴/);
    assert.match(down.subject, /guardia de pagos/);
    assert.match(down.subject, /en rojo/);
    assert.match(down.text, /casos en rojo/);
    // Y la vuelta anota que salió, sin decir a quién.
    const [row] = await list(projectBase);
    assert.match(row!.recent[0]!.note, /2 destinatarios/);
    assert.ok(!row!.recent[0]!.note.includes("@"), row!.recent[0]!.note);

    // Un servicio caído toda la noche no manda un correo por turno: el canal acabaría en una regla
    // de filtrado, y entonces tampoco se vería el incendio siguiente.
    assert.equal(await fire(), 2, "repitió el aviso en el turno siguiente");

    // Al verde, cambiándole el plan a un entorno que no falla.
    const moved = await api()
      .patch(`${projectBase}/monitors/${monitor.id}`)
      .set(as(owner))
      .send({ plan: { environmentId: sano, operationIds: ["listThings"] } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    assert.equal(await fire(), 4, "no avisó de la recuperación");
    const up = context.mailer.sent[3]!;
    assert.match(up.subject, /✅/);
    assert.match(up.subject, /verde/);
  });

  test("sin caída avisada no hay recuperación que contar", async () => {
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true });
    const sano = await healthyEnvironmentIn(projectBase);
    const monitor = await createMonitor(projectBase, {
      name: "un rojo suelto",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "email", recipients: ["guardia@ejemplo.test"], afterFailures: 2 },
    });

    // Un solo rojo, que no llegó al umbral y por tanto no avisó a nadie.
    advance(61);
    await tick();
    assert.equal(context.mailer.sent.length, 0);

    await api()
      .patch(`${projectBase}/monitors/${monitor.id}`)
      .set(as(owner))
      .send({ plan: { environmentId: sano, operationIds: ["listThings"] } });
    advance(61);
    await tick();

    const [row] = await list(projectBase);
    assert.equal(row!.lastOutcome, "passed");
    // «Ya está arreglado» de algo que nunca se dijo que estaba roto es un correo que no se entiende.
    assert.equal(context.mailer.sent.length, 0, "avisó de una recuperación que nadie esperaba");
  });

  test("el correo no lleva valores de variables, ni cabeceras, ni cuerpos", async () => {
    const secret = "s3cr3t-de-produccion";
    const { projectBase, environmentId } = await projectAgainst(
      { brokenEnvelope: true },
      { TOKEN: { initial: secret, sensitive: true }, REGION: "eu-west-1" },
    );
    // El camino más corto para meter un valor del entorno en el texto es el nombre del monitor, y
    // es el mismo camino que recorre la nota de una vuelta: los dos van redactados.
    await createMonitor(projectBase, {
      name: `pagos ${secret}`,
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "email", recipients: ["guardia@ejemplo.test"], afterFailures: 1 },
    });

    advance(61);
    await tick();
    const mail = context.mailer.sent[0]!;
    assert.ok(mail, "no salió el correo");

    const everything = `${mail.subject}\n${mail.text}\n${mail.html}`;
    // Un correo se reenvía, se archiva en el buzón de alguien y se indexa: un token que acabe
    // dentro ya no se puede recoger.
    assert.ok(!everything.includes(secret), "el correo llevaba dentro un valor sensible del entorno");
    assert.match(everything, /••••/, "el valor sensible no se redactó, simplemente no estaba");
    assert.ok(!everything.includes("eu-west-1"), "el correo llevaba el valor de una variable");
    assert.ok(!everything.toLowerCase().includes("authorization"), "el correo llevaba una cabecera");
    assert.ok(!everything.includes('"data"'), "el correo llevaba un cuerpo de respuesta");

    // Lo que sí lleva: qué monitor, cuántos casos y el id de la corrida, que es por donde se sigue.
    const [row] = await list(projectBase);
    assert.match(mail.text, /casos en rojo/);
    assert.ok(mail.text.includes(row!.recent[0]!.runId!), "el correo no dice de qué corrida habla");
  });

  test("un correo que no sale no rompe la vuelta, y la nota no dice a quién iba", async () => {
    const { projectBase, environmentId } = await projectAgainst({ brokenEnvelope: true });
    await createMonitor(projectBase, {
      name: "correo rechazado",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
      alert: { channel: "email", recipients: ["guardia@ejemplo.test"], afterFailures: 1 },
    });

    const real = context.mailer.send.bind(context.mailer);
    // Un servidor de correo que rechaza, que es lo que pasa a las tres de la mañana.
    context.mailer.send = async () => {
      throw new Error("550 mailbox unavailable");
    };
    try {
      advance(61);
      await tick();
    } finally {
      context.mailer.send = real;
    }

    const [row] = await list(projectBase);
    // Lo contrario —que un buzón que ya no existe apague la vigilancia— es el peor de los dos fallos.
    assert.equal(row!.recent[0]!.outcome, "failed");
    assert.equal(row!.consecutiveFailures, 1);
    assert.match(row!.recent[0]!.note, /no se pudo entregar/);
    // La nota va al historial, que ve todo el proyecto.
    assert.ok(!row!.recent[0]!.note.includes("guardia@ejemplo.test"), row!.recent[0]!.note);
  });
});

describe("correr ahora", () => {
  test("lanza la corrida y no toca el turno", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "a mano",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    const before = turnOf(monitor.id)!.toISOString();

    const now = await api().post(`${projectBase}/monitors/${monitor.id}/runs`).set(as(owner)).send({});
    assert.equal(now.status, 202, JSON.stringify(now.body));
    assert.ok(now.body.runId);
    await context.queue.idle();

    // El botón dice «correr», no «reprogramar».
    assert.equal(turnOf(monitor.id)!.toISOString(), before);
    const [row] = await list(projectBase);
    assert.equal(row!.recent[0]!.outcome, "passed");
  });

  test("un «viewer» no puede: esto lanza una corrida contra un servicio real", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "solo lectura",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId },
    });
    const viewer = await signUp(`monitors-viewer-${Date.now()}@example.test`);
    await joinAs(viewer, owner.organizationId, "viewer");

    // Ve la lista —saber si la vigilancia está verde es parte de mirar un proyecto—…
    assert.equal((await api().get(`${projectBase}/monitors`).set(as(viewer))).status, 200);
    // …y no lanza nada: «correr ahora» manda peticiones de verdad a la API de alguien.
    const denied = await api().post(`${projectBase}/monitors/${monitor.id}/runs`).set(as(viewer)).send({});
    assert.equal(denied.status, 403);
    // Ni crea, ni apaga, ni borra.
    assert.equal(
      (await api().patch(`${projectBase}/monitors/${monitor.id}`).set(as(viewer)).send({ enabled: false })).status,
      403,
    );
    assert.equal((await api().delete(`${projectBase}/monitors/${monitor.id}`).set(as(viewer))).status, 403);
  });
});

describe("el historial", () => {
  test("se pide por monitor y llega con su horario", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "historial",
      schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Europe/Madrid" },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    // Hasta las 09:00 de Madrid del día siguiente.
    advance(24 * 60);
    await tick();

    const history = await api().get(`${projectBase}/monitors/${monitor.id}/executions`).set(as(owner));
    assert.equal(history.status, 200);
    assert.equal(history.body.monitor.scheduleLabel, "todos los días a las 09:00 (Europe/Madrid)");
    assert.equal(history.body.executions.length, 1);
    assert.equal(history.body.executions[0]!.outcome, "passed");
  });

  test("borrar el monitor se lleva su historial", async () => {
    const { projectBase, environmentId } = await projectAgainst();
    const monitor = await createMonitor(projectBase, {
      name: "para borrar",
      schedule: { kind: "interval", minutes: 60 },
      plan: { environmentId, operationIds: ["listThings"] },
    });
    advance(61);
    await tick();

    const gone = await api().delete(`${projectBase}/monitors/${monitor.id}`).set(as(owner));
    assert.equal(gone.status, 204);
    const after = await api().get(`${projectBase}/monitors/${monitor.id}/executions`).set(as(owner));
    assert.equal(after.status, 404);
  });
});
