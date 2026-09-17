/**
 * Un monitor: una corrida guardada que se lanza sola, cada tanto.
 *
 * Es lo que convierte este producto de algo que se usa en algo que **avisa**. Todo lo anterior
 * contesta cuando alguien pregunta; un monitor pregunta él, a las tres de la mañana, y dice que la
 * API de producción lleva dos horas devolviendo 500.
 *
 * ## Un monitor no es un tipo nuevo de corrida
 *
 * Lo que dispara es la misma `StartRunCommand` que el botón de la pantalla, con el mismo plan y el
 * mismo entorno. Eso no es comodidad: significa que un monitor no puede ejecutar nada que no se
 * pueda ejecutar a mano, y que las validaciones del plan —el flujo existe, el conjunto de datos es
 * de ese flujo, la corrida no es gigantesca— están escritas una vez. Un planificador con su propio
 * camino de ejecución acaba corriendo algo distinto de lo que se probó.
 *
 * Lo único que cambia es quién la pidió: `triggeredByKind: "monitor"`. Una corrida que nadie
 * lanzó no la lanzó un usuario, y decir que sí sería mentir en el historial.
 *
 * ## El historial es de él, y por eso es una tabla aparte
 *
 * `monitor_executions` no es una comodidad para la pantalla: la retención de corridas **borra
 * corridas viejas** (`RETENTION_RUNS_DAYS`), así que un historial que se leyera de `runs` se iría
 * vaciando por detrás sin que nadie lo pidiera. La fila de la ejecución es pequeña —estado, cuándo,
 * cuántos casos— y sobrevive al barrido, que es justo lo que un historial tiene que hacer.
 *
 * ## No se solapa
 *
 * Si la corrida anterior de este monitor sigue viva, el turno **se salta** y se anota por qué. Un
 * monitor cada cinco minutos contra una API que tarda seis no es vigilancia: es una cola que crece
 * hasta que alguien la ve.
 */
import { randomUUID } from "node:crypto";

import { NOTIFY_CHANNELS, type NotifyChannel } from "@eq/runner-core";
import { describeSchedule, nextOccurrence, scheduleProblems, type MonitorSchedule } from "./schedule";

/** Local, como en el resto de dominios de este producto. */
type Problem = { field: string; detail: string };

export const MAX_MONITOR_NAME = 120;
/** Diez por proyecto. Cada uno lanza corridas solo, y más de diez son turnos que nadie mira. */
export const MAX_MONITORS_PER_PROJECT = 10;
/** Cuántas ejecuciones se guardan de cada monitor. Lo que cabe en una pantalla, por dos. */
export const MONITOR_HISTORY = 50;
export const MAX_ALERT_FAILURES = 10;

/** Lo mismo que un nodo `notify` de un flujo: el **nombre** de la variable, nunca la URL. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Los canales de un aviso de monitor: los del nodo `notify`, y el correo.
 *
 * `NOTIFY_CHANNELS` **no se toca**. Ese conjunto es parte del esquema de un flujo, que se exporta,
 * se importa y se compara, y el motor de flujos no manda correo: un canal de más allí sería un
 * documento que valida y un paso que no hace nada. El aviso de un monitor lo manda la API al
 * cerrar una vuelta, no el motor, así que su lista es suya — y empieza por la del nodo para que
 * Slack, Teams y el webhook sigan siendo el mismo canal en los dos sitios.
 */
export const MONITOR_ALERT_CHANNELS = [...NOTIFY_CHANNELS, "email"] as const;
export type MonitorAlertChannel = (typeof MONITOR_ALERT_CHANNELS)[number];

/**
 * Cuántas direcciones caben en un aviso.
 *
 * Cinco, por lo mismo que hay un tope de monitores y un tope de fallos: un aviso de monitor va al
 * puñado de personas que puede arreglarlo. Una lista más larga que eso es una lista de
 * distribución, y una lista de distribución se hace en el servidor de correo —donde se puede dar de
 * baja alguien— y no en la fila de un monitor, donde nadie sabría que está dentro.
 */
export const MAX_ALERT_RECIPIENTS = 5;
/** 64 + «@» + 255: lo que mide una dirección como mucho, igual que en los DTO de cuentas. */
export const MAX_RECIPIENT_LENGTH = 320;
/**
 * Una dirección de correo, comprobada por lo que la descalifica y no por la gramática entera.
 *
 * La gramática de verdad acepta comillas y comentarios que ningún equipo escribe, y una expresión
 * que la imite rechaza direcciones válidas — que es el fallo caro: alguien que no recibe el aviso.
 * Esto descarta lo que de verdad llega a este campo mal escrito: un hueco, una lista pegada con
 * comas o punto y coma sin separar, un «Nombre <a@b.c>» copiado del cliente de correo, y un dominio
 * sin punto.
 */
export const EMAIL_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

/**
 * A quién se avisa y cuándo.
 *
 * `urlVariable` es **un nombre**, y la URL vive en el entorno del monitor —cifrada si es sensible—
 * por lo mismo que en un nodo `notify`: quien tiene una URL de webhook entrante puede escribir en
 * ese canal, así que es una credencial y no se guarda aquí.
 *
 * ## `recipients` sí va en claro, y es la decisión que no se parece a la de arriba
 *
 * Una dirección de correo **no es una credencial**: no autoriza nada. Quien lee
 * `alert.recipients` no gana la capacidad de escribir a ese equipo — cualquiera puede escribirle
 * ya—, mientras que quien lee una URL de webhook gana la de publicar en su canal. Esa es la única
 * razón por la que el webhook pasa por una variable, así que el correo no tiene por qué.
 *
 * Y guardarlo en claro compra algo que importa: **se ve a quién se está despertando**. Con la
 * dirección detrás de un nombre de variable, saber quién recibe los avisos de un monitor obligaría
 * a abrir el entorno y descifrar un valor, y el número de teléfono de la madrugada es justo el dato
 * que hay que poder revisar de un vistazo. Además, los destinatarios no son un atributo del entorno
 * que se está probando —el mismo entorno lo comparten corridas a mano que no avisan a nadie—, y
 * meterlos allí ataría el aviso a una variable que cualquiera puede renombrar.
 *
 * Lo que sí se mantiene es lo de siempre: el cuerpo va redactado contra los secretos del entorno, y
 * la nota de un aviso que no salió no cita la dirección.
 *
 * `afterFailures` existe por el monitor que parpadea. Avisar del primer fallo es lo que se espera y
 * es el valor por defecto; poder pedir dos o tres seguidos es lo que evita que el canal se llene de
 * avisos y alguien lo silencie — que es el fallo de verdad, porque entonces tampoco se ve el grave.
 */
export type MonitorAlert = {
  channel: MonitorAlertChannel;
  /** El nombre de la variable con la URL. Solo los canales de webhook; ausente en «email». */
  urlVariable?: string;
  /** Las direcciones, en claro. Solo «email»; ausente en los demás. */
  recipients?: string[];
  afterFailures: number;
};

/** Si este canal sale por una URL de webhook en vez de por el correo. */
export function isWebhookChannel(channel: MonitorAlertChannel): channel is NotifyChannel {
  return channel !== "email";
}

/**
 * El aviso como se guarda: sin espacios, y sin el campo del canal que no es.
 *
 * Se normaliza al guardar y no al enviar porque la fila es lo que alguien audita. Un aviso por
 * correo que arrastra el `urlVariable` de cuando era un webhook se lee como si saliera por los dos
 * sitios, y un destinatario con un espacio delante es una dirección que el servidor de correo
 * rechaza a las tres de la mañana.
 */
export function normalizeAlert(alert: MonitorAlert): MonitorAlert {
  const afterFailures = alert.afterFailures;
  if (isWebhookChannel(alert.channel))
    return { channel: alert.channel, urlVariable: alert.urlVariable?.trim() ?? "", afterFailures };
  return {
    channel: alert.channel,
    recipients: (alert.recipients ?? []).map((address) => address.trim()).filter(Boolean),
    afterFailures,
  };
}

/** Qué corrida lanza. Es un plan de `StartRunCommand`, y se valida allí y no aquí. */
export type MonitorPlan = {
  environmentId: string;
  workflowId?: string;
  suiteId?: string;
  datasetId?: string;
  operationIds?: string[];
  labels?: string[];
  samples?: number;
  delayMs?: number;
  concurrency?: number;
  stopOnFailure?: boolean;
};

export const MONITOR_OUTCOMES = ["running", "passed", "failed", "error", "skipped"] as const;
export type MonitorOutcome = (typeof MONITOR_OUTCOMES)[number];

export type Monitor = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  schedule: MonitorSchedule;
  plan: MonitorPlan;
  alert: MonitorAlert | null;
  /**
   * Cuándo le toca. Nulo cuando está apagado, y eso es lo que lo apaga de verdad: el reclamo
   * atómico busca por esta columna, así que un monitor sin turno no lo puede tomar nadie.
   */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastOutcome: MonitorOutcome | null;
  /** Fallos seguidos. Es lo que decide si se avisa, y se pone a cero en el primer verde. */
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
};

export type MonitorInput = {
  name?: string;
  enabled?: boolean;
  schedule?: MonitorSchedule;
  plan?: MonitorPlan;
  alert?: MonitorAlert | null;
};

/** Una vuelta del monitor. Sobrevive al barrido de retención de corridas: ver la cabecera. */
export type MonitorExecution = {
  id: string;
  monitorId: string;
  projectId: string;
  /** La corrida que lanzó, o nula cuando el turno se saltó o no se pudo lanzar. */
  runId: string | null;
  outcome: MonitorOutcome;
  startedAt: Date;
  finishedAt: Date | null;
  totals: { cases: number; passed: number; failed: number } | null;
  /** Por qué se saltó, o qué falló al lanzarla. Vacío en una vuelta normal. */
  note: string;
};

/**
 * El estado de la corrida, leído como el resultado de la vuelta del monitor.
 *
 * `cancelled` es la decisión que no es obvia: una corrida la cancela **una persona**, así que
 * contarla como fallo despertaría a alguien por algo que otro alguien acaba de hacer a mano. No se
 * midió nada, y eso es «saltada».
 */
export function outcomeOf(status: "queued" | "running" | "passed" | "failed" | "cancelled" | "error"): MonitorOutcome {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "skipped";
  if (status === "error") return "error";
  return "running";
}

export function alertProblems(alert: MonitorAlert | null | undefined): Problem[] {
  if (!alert) return [];
  const problems: Problem[] = [];
  if (!MONITOR_ALERT_CHANNELS.includes(alert.channel))
    problems.push({ field: "alert.channel", detail: "Tiene que ser «slack», «teams», «webhook» o «email»" });

  // Cada canal pide su campo y **solo** el suyo: un aviso por correo con un nombre de variable
  // dentro deja a quien lo lee sin saber por dónde sale, y el que sobra es siempre el que se
  // olvidó de borrar al cambiar el canal.
  if (isWebhookChannel(alert.channel)) {
    if (!alert.urlVariable?.trim() || !VARIABLE_NAME.test(alert.urlVariable.trim())) {
      problems.push({
        field: "alert.urlVariable",
        detail: "Escribe el nombre de la variable del entorno que contiene la URL, no la URL",
      });
    }
  } else {
    problems.push(...recipientProblems(alert.recipients));
  }

  if (!Number.isInteger(alert.afterFailures) || alert.afterFailures < 1 || alert.afterFailures > MAX_ALERT_FAILURES) {
    problems.push({ field: "alert.afterFailures", detail: `Un entero entre 1 y ${MAX_ALERT_FAILURES}` });
  }
  return problems;
}

/** Los destinatarios de un aviso por correo: al menos uno, como mucho el tope, y direcciones. */
function recipientProblems(recipients: string[] | undefined): Problem[] {
  const field = "alert.recipients";
  const addresses = (recipients ?? []).map((address) => address.trim()).filter(Boolean);
  if (!addresses.length) return [{ field, detail: "Escribe al menos una dirección de correo" }];
  if (addresses.length > MAX_ALERT_RECIPIENTS)
    return [{ field, detail: `Como mucho ${MAX_ALERT_RECIPIENTS} destinatarios` }];
  // La dirección mal escrita no se dice de vuelta en el detalle: el mensaje de error de una API
  // se registra y se pega en un ticket, y esto es el correo de una persona.
  const bad = addresses.filter((address) => address.length > MAX_RECIPIENT_LENGTH || !EMAIL_ADDRESS.test(address));
  if (bad.length) return [{ field, detail: `${bad.length} de ${addresses.length} no son direcciones de correo` }];
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length)
    return [{ field, detail: "Hay una dirección repetida: el aviso llegaría dos veces" }];
  return [];
}

export function monitorProblems(input: MonitorInput, { requireAll = false } = {}): Problem[] {
  const problems: Problem[] = [];

  if (input.name !== undefined) {
    if (!input.name.trim()) problems.push({ field: "name", detail: "Falta el nombre" });
    else if (input.name.length > MAX_MONITOR_NAME)
      problems.push({ field: "name", detail: `Como mucho ${MAX_MONITOR_NAME} caracteres` });
  } else if (requireAll) {
    problems.push({ field: "name", detail: "Falta el nombre" });
  }

  if (input.schedule !== undefined || requireAll) problems.push(...scheduleProblems(input.schedule));

  if (input.plan !== undefined) {
    if (!input.plan.environmentId)
      problems.push({ field: "plan.environmentId", detail: "Un monitor corre contra un entorno concreto" });
    if (input.plan.workflowId && input.plan.suiteId)
      problems.push({ field: "plan.suiteId", detail: "Una corrida ejecuta un flujo o una suite, no las dos" });
  } else if (requireAll) {
    problems.push({ field: "plan.environmentId", detail: "Un monitor corre contra un entorno concreto" });
  }

  problems.push(...alertProblems(input.alert));
  return problems;
}

export function blankMonitor(fields: {
  projectId: string;
  name: string;
  schedule: MonitorSchedule;
  plan: MonitorPlan;
  alert?: MonitorAlert | null;
  now: Date;
  actorId: string;
}): Monitor {
  return {
    id: randomUUID(),
    projectId: fields.projectId,
    name: fields.name,
    enabled: true,
    schedule: fields.schedule,
    plan: fields.plan,
    alert: fields.alert ? normalizeAlert(fields.alert) : null,
    // El primer turno se calcula desde ahora, así que crear un monitor no dispara una corrida en
    // el mismo segundo: quien acaba de escribir el horario no ha pedido una corrida, ha pedido un
    // horario. Para lanzarla ya está «Correr ahora».
    nextRunAt: nextOccurrence(fields.schedule, fields.now),
    lastRunAt: null,
    lastOutcome: null,
    consecutiveFailures: 0,
    createdAt: fields.now,
    updatedAt: fields.now,
    createdBy: fields.actorId,
  };
}

/**
 * El monitor con los cambios aplicados, y su turno recalculado cuando hace falta.
 *
 * Apagarlo pone `nextRunAt` en nulo, que es lo que lo saca del reclamo. Encenderlo lo recalcula
 * **desde ahora** y no restaura el turno que tenía: un monitor que se enciende tras dos días
 * apagado no debe una corrida de anteayer.
 */
export function withChanges(monitor: Monitor, input: MonitorInput, now: Date): Monitor {
  const schedule = input.schedule ?? monitor.schedule;
  const enabled = input.enabled ?? monitor.enabled;
  const scheduleChanged = input.schedule !== undefined;
  const turnedOn = enabled && !monitor.enabled;
  return {
    ...monitor,
    name: input.name?.trim() || monitor.name,
    enabled,
    schedule,
    plan: input.plan ?? monitor.plan,
    alert: input.alert === undefined ? monitor.alert : input.alert && normalizeAlert(input.alert),
    nextRunAt: !enabled
      ? null
      : turnedOn || scheduleChanged || !monitor.nextRunAt
        ? nextOccurrence(schedule, now)
        : monitor.nextRunAt,
    updatedAt: now,
  };
}

/** Lo que sale por la API. `plan` y `schedule` van tal cual: no hay nada secreto en ellos. */
export type MonitorView = Omit<Monitor, "projectId" | "createdAt" | "updatedAt" | "nextRunAt" | "lastRunAt"> & {
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Cómo se lee el horario, decidido por el servidor. */
  scheduleLabel: string;
};

export type MonitorExecutionView = Omit<MonitorExecution, "projectId" | "startedAt" | "finishedAt"> & {
  startedAt: string;
  finishedAt: string | null;
};

export function viewMonitor(monitor: Monitor): MonitorView {
  const { projectId: _projectId, ...rest } = monitor;
  return {
    ...rest,
    scheduleLabel: describeSchedule(monitor.schedule),
    nextRunAt: monitor.nextRunAt?.toISOString() ?? null,
    lastRunAt: monitor.lastRunAt?.toISOString() ?? null,
    createdAt: monitor.createdAt.toISOString(),
    updatedAt: monitor.updatedAt.toISOString(),
  };
}

export function viewExecution(execution: MonitorExecution): MonitorExecutionView {
  const { projectId: _projectId, ...rest } = execution;
  return {
    ...rest,
    startedAt: execution.startedAt.toISOString(),
    finishedAt: execution.finishedAt?.toISOString() ?? null,
  };
}

/** Una vuelta que empieza. `runId` nulo mientras no haya corrida: saltada, o fallida al lanzar. */
export function blankExecution(fields: {
  monitorId: string;
  projectId: string;
  runId: string | null;
  outcome: MonitorOutcome;
  now: Date;
  note?: string;
}): MonitorExecution {
  return {
    id: randomUUID(),
    monitorId: fields.monitorId,
    projectId: fields.projectId,
    runId: fields.runId,
    outcome: fields.outcome,
    startedAt: fields.now,
    finishedAt: fields.outcome === "running" ? null : fields.now,
    totals: null,
    note: fields.note ?? "",
  };
}

/**
 * El estado del monitor tras cerrarse una vuelta.
 *
 * Los fallos seguidos se cuentan aquí y no en el aviso, porque son parte de lo que el monitor *es*:
 * la pantalla los enseña aunque no haya ningún canal configurado. Un verde los pone a cero — dos
 * fallos separados por un verde no son una racha, y tratarlos como tal avisaría de algo que ya se
 * arregló.
 *
 * Una vuelta saltada no cuenta ni como fallo ni como acierto: no se midió nada.
 */
export function afterExecution(monitor: Monitor, outcome: MonitorOutcome, at: Date): Monitor {
  if (outcome === "skipped") return { ...monitor, updatedAt: at };
  const failed = outcome === "failed" || outcome === "error";
  return {
    ...monitor,
    lastRunAt: at,
    lastOutcome: outcome,
    consecutiveFailures: failed ? monitor.consecutiveFailures + 1 : 0,
    updatedAt: at,
  };
}

/**
 * Si esta racha toca avisar, y **solo en el turno exacto**.
 *
 * `=== afterFailures` y no `>=`: con «avisa al segundo fallo», un servicio caído toda la noche
 * mandaría un aviso por turno. Se avisa cuando la racha llega al número, y no se vuelve a avisar
 * hasta que haya un verde que la ponga a cero — que además es la otra cosa que hay que contar, y
 * por eso se avisa también de la recuperación.
 */
export function shouldAlert(monitor: Monitor, outcome: MonitorOutcome, previousFailures: number): "down" | "up" | null {
  if (!monitor.alert || outcome === "skipped") return null;
  const failed = outcome === "failed" || outcome === "error";
  if (failed) return previousFailures + 1 === monitor.alert.afterFailures ? "down" : null;
  // Recuperación: solo si antes había llegado a avisar. Si no, no hubo nada de lo que recuperarse.
  return previousFailures >= monitor.alert.afterFailures ? "up" : null;
}
