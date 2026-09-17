/**
 * El estado de un monitor: la racha, cuándo se avisa, y qué hace cada cambio con el turno.
 *
 * Son cuatro decisiones y las cuatro se notan cuando están mal, pero no el día que se escriben:
 *
 * - **Encender un monitor no debe corridas de ayer.** El turno se recalcula desde ahora.
 * - **Un verde corta la racha.** Dos fallos separados por un verde no son una racha, y tratarlos
 *   como tal avisa de algo que ya se arregló.
 * - **Se avisa en el turno exacto, no en todos los siguientes.** Con «al segundo fallo», un
 *   servicio caído toda la noche mandaría un aviso por turno hasta que alguien silenciara el canal
 *   — y entonces tampoco se vería el grave.
 * - **Una corrida cancelada no es un fallo.** La cancela una persona; contarla como rojo despierta
 *   a alguien por algo que otro acaba de hacer a mano.
 * - **El correo guarda la dirección y el webhook no guarda la URL.** Son la misma decisión mirada
 *   desde los dos lados: una URL de webhook autoriza a publicar en ese canal y una dirección no
 *   autoriza nada.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ALERT_RECIPIENTS,
  afterExecution,
  blankMonitor,
  monitorProblems,
  normalizeAlert,
  outcomeOf,
  shouldAlert,
  viewMonitor,
  withChanges,
  type Monitor,
  type MonitorAlert,
} from "@/modules/monitors/domain/model";
import type { MonitorSchedule } from "@/modules/monitors/domain/schedule";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const HOURLY: MonitorSchedule = { kind: "interval", minutes: 60 };

const monitor = (patch: Partial<Monitor> = {}): Monitor => ({
  ...blankMonitor({
    projectId: "project-1",
    name: "producción",
    schedule: HOURLY,
    plan: { environmentId: "env-1" },
    now: NOW,
    actorId: "actor-1",
  }),
  ...patch,
});

describe("crear", () => {
  it("el primer turno es dentro de una hora, no ahora", () => {
    // Quien acaba de escribir un horario ha pedido un horario, no una corrida. Para eso está el
    // botón de «correr ahora».
    const created = monitor();
    assert.equal(created.nextRunAt?.toISOString(), "2026-03-01T11:00:00.000Z");
    assert.equal(created.enabled, true);
    assert.equal(created.consecutiveFailures, 0);
    assert.equal(created.lastOutcome, null);
  });

  it("un monitor sin entorno no es un monitor", () => {
    const problems = monitorProblems({ name: "x", schedule: HOURLY }, { requireAll: true });
    assert.ok(problems.some((problem) => problem.field === "plan.environmentId"));
  });

  it("un flujo y una suite a la vez no es una corrida", () => {
    const problems = monitorProblems({
      name: "x",
      schedule: HOURLY,
      plan: { environmentId: "e", workflowId: "w", suiteId: "s" },
    });
    assert.ok(problems.some((problem) => problem.field === "plan.suiteId"));
  });

  it("el aviso pide el nombre de una variable, no una URL", () => {
    const problems = monitorProblems({
      alert: { channel: "slack", urlVariable: "https://hooks.slack.com/services/xxx", afterFailures: 1 },
    });
    // Quien tiene la URL puede escribir en el canal: es una credencial y no se guarda aquí.
    assert.ok(problems.some((problem) => problem.field === "alert.urlVariable"));
    assert.deepEqual(
      monitorProblems({ alert: { channel: "slack", urlVariable: "SLACK_WEBHOOK", afterFailures: 1 } }),
      [],
    );
  });

  it("avisar «tras cero fallos» no significa nada", () => {
    const problems = monitorProblems({ alert: { channel: "slack", urlVariable: "W", afterFailures: 0 } });
    assert.ok(problems.some((problem) => problem.field === "alert.afterFailures"));
  });
});

/**
 * El canal correo, que es el único que guarda su destino en claro.
 *
 * La decisión está argumentada en `MonitorAlert` y lo que estas pruebas fijan es su consecuencia:
 * una dirección **sí** se escribe en la fila del monitor —no autoriza nada, y hay que poder ver a
 * quién se despierta—, pero se comprueba que lo es y no pasan cuarenta.
 */
describe("el aviso por correo", () => {
  const email = (recipients: string[]) =>
    monitorProblems({ alert: { channel: "email", recipients, afterFailures: 1 } });

  it("pide direcciones y no un nombre de variable", () => {
    assert.deepEqual(email(["guardia@ejemplo.com"]), []);
    // Lo que el canal de webhook pide es justo lo que aquí no vale: una variable no es un buzón.
    assert.ok(email(["MAIL_GUARDIA"]).some((problem) => problem.field === "alert.recipients"));
    assert.ok(email([]).some((problem) => problem.field === "alert.recipients"));
  });

  it("no pide el nombre de variable que el correo no usa", () => {
    // Y al contrario: un aviso por correo sin `urlVariable` es válido. Pedirlo obligaría a inventar
    // el nombre de una variable que nadie va a leer.
    assert.deepEqual(monitorProblems({ alert: { channel: "email", recipients: ["a@b.com"], afterFailures: 2 } }), []);
  });

  it("no acepta cuarenta destinatarios: eso es una lista de distribución", () => {
    const many = Array.from({ length: MAX_ALERT_RECIPIENTS + 1 }, (_, index) => `persona${index}@ejemplo.com`);
    const problems = email(many);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.detail, new RegExp(`${MAX_ALERT_RECIPIENTS}`));
  });

  it("la misma dirección dos veces no manda el aviso dos veces", () => {
    assert.ok(email(["a@ejemplo.com", "A@ejemplo.com"]).some((problem) => problem.field === "alert.recipients"));
  });

  it("el detalle del error no repite la dirección mal escrita", () => {
    // El mensaje de una API se registra y se pega en un ticket, y esto es el correo de alguien.
    const [problem] = email(["no-es-un-correo", "b@ejemplo.com"]);
    assert.ok(problem);
    assert.ok(!problem.detail.includes("no-es-un-correo"), problem.detail);
  });

  it("un canal que no existe no es un canal", () => {
    const problems = monitorProblems({
      alert: { channel: "paloma" as MonitorAlert["channel"], recipients: ["a@b.com"], afterFailures: 1 },
    });
    assert.ok(problems.some((problem) => problem.field === "alert.channel"));
  });

  it("guardarlo limpia los espacios y suelta el campo del canal que no es", () => {
    // La fila es lo que alguien audita: un aviso por correo que arrastra el `urlVariable` de cuando
    // era un webhook se lee como si saliera por los dos sitios.
    const stored = normalizeAlert({
      channel: "email",
      urlVariable: "SLACK_WEBHOOK",
      recipients: [" guardia@ejemplo.com ", "  "],
      afterFailures: 1,
    });
    assert.deepEqual(stored, { channel: "email", recipients: ["guardia@ejemplo.com"], afterFailures: 1 });

    const webhook = normalizeAlert({
      channel: "slack",
      urlVariable: " SLACK_WEBHOOK ",
      recipients: ["guardia@ejemplo.com"],
      afterFailures: 1,
    });
    assert.deepEqual(webhook, { channel: "slack", urlVariable: "SLACK_WEBHOOK", afterFailures: 1 });
  });
});

describe("cambiar", () => {
  const later = new Date("2026-03-01T10:30:00.000Z");

  it("apagarlo deja el turno en nulo, que es lo que lo saca del reclamo", () => {
    const off = withChanges(monitor(), { enabled: false }, later);
    assert.equal(off.nextRunAt, null);
  });

  it("encenderlo recalcula el turno desde ahora y no restaura el que tenía", () => {
    // Un monitor que se enciende tras dos días apagado no debe una corrida de anteayer.
    const off = withChanges(monitor(), { enabled: false }, later);
    const on = withChanges(off, { enabled: true }, new Date("2026-03-03T08:00:00.000Z"));
    assert.equal(on.nextRunAt?.toISOString(), "2026-03-03T09:00:00.000Z");
  });

  it("cambiar el horario recalcula el turno; cambiar el nombre no lo toca", () => {
    const before = monitor();
    const rescheduled = withChanges(before, { schedule: { kind: "interval", minutes: 15 } }, later);
    assert.equal(rescheduled.nextRunAt?.toISOString(), "2026-03-01T10:45:00.000Z");

    const renamed = withChanges(before, { name: "otro nombre" }, later);
    assert.equal(renamed.nextRunAt?.toISOString(), before.nextRunAt?.toISOString());
  });

  it("quitar el aviso se dice con null; no decir nada lo deja", () => {
    const withAlert = monitor({ alert: { channel: "slack", urlVariable: "W", afterFailures: 1 } });
    assert.equal(withChanges(withAlert, {}, later).alert?.urlVariable, "W");
    assert.equal(withChanges(withAlert, { alert: null }, later).alert, null);
  });
});

describe("la racha", () => {
  it("un fallo la sube y un verde la pone a cero", () => {
    let current = monitor();
    current = afterExecution(current, "failed", NOW);
    assert.equal(current.consecutiveFailures, 1);
    current = afterExecution(current, "error", NOW);
    assert.equal(current.consecutiveFailures, 2);
    current = afterExecution(current, "passed", NOW);
    assert.equal(current.consecutiveFailures, 0);
    assert.equal(current.lastOutcome, "passed");
  });

  it("una vuelta saltada no cuenta: no se midió nada", () => {
    const current = afterExecution(monitor({ consecutiveFailures: 2, lastOutcome: "failed" }), "skipped", NOW);
    assert.equal(current.consecutiveFailures, 2);
    assert.equal(current.lastOutcome, "failed");
    // Y tampoco mueve la fecha de la última corrida: no hubo ninguna.
    assert.equal(current.lastRunAt, null);
  });

  it("una corrida cancelada es saltada y no un fallo", () => {
    assert.equal(outcomeOf("cancelled"), "skipped");
    assert.equal(outcomeOf("passed"), "passed");
    assert.equal(outcomeOf("failed"), "failed");
    assert.equal(outcomeOf("error"), "error");
    assert.equal(outcomeOf("running"), "running");
  });
});

describe("cuándo se avisa", () => {
  const withAlert = (afterFailures: number, failures = 0) =>
    monitor({ alert: { channel: "slack", urlVariable: "W", afterFailures }, consecutiveFailures: failures });

  it("sin canal no se avisa de nada, aunque la racha crezca", () => {
    assert.equal(shouldAlert(monitor({ consecutiveFailures: 9 }), "failed", 9), null);
  });

  it("con «al primer fallo», el primer rojo avisa", () => {
    assert.equal(shouldAlert(withAlert(1), "failed", 0), "down");
  });

  it("con «al segundo», el primero calla y el segundo avisa", () => {
    assert.equal(shouldAlert(withAlert(2), "failed", 0), null);
    assert.equal(shouldAlert(withAlert(2), "failed", 1), "down");
  });

  it("y el tercero, el cuarto y el de las cuatro de la mañana ya no", () => {
    // Es la diferencia entre un aviso y un canal que alguien silencia — y un canal silenciado no
    // avisa tampoco del incendio siguiente.
    assert.equal(shouldAlert(withAlert(2), "failed", 2), null);
    assert.equal(shouldAlert(withAlert(2), "failed", 20), null);
  });

  it("se avisa de la recuperación solo si antes se avisó de la caída", () => {
    assert.equal(shouldAlert(withAlert(2), "passed", 2), "up");
    // Un rojo suelto que se arregló sin llegar al umbral no tuvo aviso, así que no hay
    // recuperación que contar.
    assert.equal(shouldAlert(withAlert(2), "passed", 1), null);
    assert.equal(shouldAlert(withAlert(2), "passed", 0), null);
  });

  it("una vuelta saltada no avisa ni de caída ni de recuperación", () => {
    assert.equal(shouldAlert(withAlert(1, 3), "skipped", 3), null);
  });
});

describe("lo que sale por la API", () => {
  it("lleva el horario ya escrito en palabras, decidido por el servidor", () => {
    const view = viewMonitor(monitor());
    assert.equal(view.scheduleLabel, "cada hora");
    assert.equal(view.nextRunAt, "2026-03-01T11:00:00.000Z");
    assert.ok(!("projectId" in view));
  });
});
