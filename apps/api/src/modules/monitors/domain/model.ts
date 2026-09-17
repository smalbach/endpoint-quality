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
 * A quién se avisa y cuándo.
 *
 * `urlVariable` es **un nombre**, y la URL vive en el entorno del monitor —cifrada si es sensible—
 * por lo mismo que en un nodo `notify`: quien tiene una URL de webhook entrante puede escribir en
 * ese canal, así que es una credencial y no se guarda aquí.
 *
 * `afterFailures` existe por el monitor que parpadea. Avisar del primer fallo es lo que se espera y
 * es el valor por defecto; poder pedir dos o tres seguidos es lo que evita que el canal se llene de
 * avisos y alguien lo silencie — que es el fallo de verdad, porque entonces tampoco se ve el grave.
 */
export type MonitorAlert = {
  channel: NotifyChannel;
  urlVariable: string;
  afterFailures: number;
};

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
  if (!NOTIFY_CHANNELS.includes(alert.channel))
    problems.push({ field: "alert.channel", detail: "Tiene que ser «slack», «teams» o «webhook»" });
  if (!alert.urlVariable?.trim() || !VARIABLE_NAME.test(alert.urlVariable.trim())) {
    problems.push({
      field: "alert.urlVariable",
      detail: "Escribe el nombre de la variable del entorno que contiene la URL, no la URL",
    });
  }
  if (!Number.isInteger(alert.afterFailures) || alert.afterFailures < 1 || alert.afterFailures > MAX_ALERT_FAILURES) {
    problems.push({ field: "alert.afterFailures", detail: `Un entero entre 1 y ${MAX_ALERT_FAILURES}` });
  }
  return problems;
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
    alert: fields.alert ?? null,
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
    alert: input.alert === undefined ? monitor.alert : input.alert,
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
