/**
 * Crear, cambiar, borrar y lanzar a mano un monitor.
 *
 * Crear **no lanza nada**: el primer turno se calcula desde ahora. Quien acaba de escribir un
 * horario ha pedido un horario, no una corrida, y para eso está «Correr ahora».
 *
 * Apagar pone el turno en nulo, que es lo que lo saca del reclamo; encenderlo lo recalcula desde
 * ahora en vez de restaurar el que tenía. Un monitor que se enciende tras dos días apagado no debe
 * una corrida de anteayer.
 */
import { Inject, Optional } from "@nestjs/common";
import { stepChannelSchema, type StepChannel } from "@eq/runner-core";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { archivedRow, deletedRow, lifecycleState, restoredRow } from "@/shared/lifecycle/lifecycle";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import {
  MAX_MONITORS_PER_PROJECT,
  blankMonitor,
  monitorProblems,
  viewMonitor,
  withChanges,
  type MonitorAlert,
  type MonitorInput,
  type MonitorPlan,
  type MonitorView,
} from "../../domain/model";
import type { MonitorSchedule } from "../../domain/schedule";
import { MONITOR_REPOSITORY, type MonitorRepositoryPort } from "../../domain/ports";
import { MonitorFirer } from "./fire-monitor";

/**
 * El plan con su canal comprobado, cuando lo lleva.
 *
 * `StartRunCommand` lo vuelve a comprobar en cada vuelta —el canal puede borrarse después—, pero
 * guardar un monitor que apunta a un canal de otro proyecto sería un monitor que falla cada noche
 * por un error que ya se veía al pulsar «Guardar». Mismo 422 que un nodo `channel` de un flujo.
 */
async function checkedPlan(
  channels: ChannelRepositoryPort | null,
  projectId: string,
  plan: MonitorPlan | undefined,
): Promise<MonitorPlan | undefined> {
  if (!plan?.channel) return plan;
  const parsed = stepChannelSchema.safeParse(plan.channel);
  if (!parsed.success) {
    throw new InvalidInputError(
      "El monitor no es válido",
      parsed.error.issues.map((issue) => ({
        field: ["plan", "channel", ...issue.path].join("."),
        detail: issue.message,
      })),
    );
  }
  const channel = channels ? await channels.findById(projectId, parsed.data.channelId) : null;
  if (!channel) {
    throw new InvalidInputError("El monitor no es válido", [
      { field: "plan.channel.channelId", detail: "el canal no existe en este proyecto" },
    ]);
  }
  return { ...plan, channel: parsed.data as StepChannel };
}

export class CreateMonitorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: { name: string; schedule: MonitorSchedule; plan: MonitorPlan; alert?: MonitorAlert | null },
    readonly actorId: string,
  ) {}
}

@CommandHandler(CreateMonitorCommand)
export class CreateMonitorHandler implements ICommandHandler<CreateMonitorCommand, MonitorView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}

  async execute(command: CreateMonitorCommand): Promise<MonitorView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const problems = monitorProblems(command.input, { requireAll: true });
    if (problems.length) throw new InvalidInputError("El monitor no es válido", problems);
    const plan = (await checkedPlan(this.channels, project.id, command.input.plan)) as MonitorPlan;

    const existing = await this.monitors.listByProject(project.id);
    if (existing.length >= MAX_MONITORS_PER_PROJECT) {
      throw new ConflictError(
        `Este proyecto ya tiene ${MAX_MONITORS_PER_PROJECT} monitores: borra alguno antes de crear otro`,
        "monitors-full",
      );
    }
    if (existing.some((row) => row.name === command.input.name.trim()))
      throw new ConflictError(`Ya hay un monitor llamado «${command.input.name.trim()}»`, "monitor-duplicate-name");

    const monitor = blankMonitor({
      projectId: project.id,
      name: command.input.name.trim(),
      schedule: command.input.schedule,
      plan,
      alert: command.input.alert ?? null,
      now: this.clock.now(),
      actorId: command.actorId,
    });
    await this.monitors.save(monitor);
    return viewMonitor(monitor);
  }
}

export class UpdateMonitorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
    readonly input: MonitorInput,
  ) {}
}

@CommandHandler(UpdateMonitorCommand)
export class UpdateMonitorHandler implements ICommandHandler<UpdateMonitorCommand, MonitorView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}

  async execute(command: UpdateMonitorCommand): Promise<MonitorView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const current = await this.monitors.findById(project.id, command.monitorId);
    if (!current) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");

    const problems = monitorProblems(command.input);
    if (problems.length) throw new InvalidInputError("El monitor no es válido", problems);

    const name = command.input.name?.trim();
    if (name && name !== current.name) {
      const siblings = await this.monitors.listByProject(project.id);
      if (siblings.some((row) => row.id !== current.id && row.name === name))
        throw new ConflictError(`Ya hay un monitor llamado «${name}»`, "monitor-duplicate-name");
    }

    const plan = await checkedPlan(this.channels, project.id, command.input.plan);
    const updated = withChanges(current, { ...command.input, plan }, this.clock.now());
    await this.monitors.save(updated);
    return viewMonitor(updated);
  }
}

/**
 * Borrar un monitor: **blando por defecto**, definitivo solo si se pide.
 *
 * Un monitor lleva dentro un horario que alguien afinó y un historial que dice desde cuándo algo
 * va mal, y hasta aquí un clic de más se llevaba las dos cosas. Ahora sale de la lista, deja de
 * lanzar corridas y se puede restaurar; su historial sigue colgando de la fila, así que volver no
 * vuelve vacío.
 *
 * `purge` es el borrado de verdad, y **solo sobre algo ya eliminado**: pedirlo sobre un monitor
 * vivo es un 409 y no un atajo. La confirmación de la pantalla no es el guardia —quien llama a la
 * API no pasa por ella—, este orden sí.
 */
export class DeleteMonitorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
    readonly purge = false,
  ) {}
}

@CommandHandler(DeleteMonitorCommand)
export class DeleteMonitorHandler implements ICommandHandler<DeleteMonitorCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeleteMonitorCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const monitor = await this.monitors.findById(project.id, command.monitorId);
    if (!monitor) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");

    if (command.purge) {
      if (lifecycleState(monitor) !== "deleted")
        throw new ConflictError("Elimina el monitor antes de borrarlo para siempre", "monitor-not-deleted");
      const gone = await this.monitors.remove(project.id, monitor.id);
      if (!gone) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");
      return;
    }

    if (monitor.deletedAt) return;
    const now = this.clock.now();
    // Sin turno: un monitor eliminado no puede quedar vencido esperando a que alguien lo restaure,
    // porque al restaurarlo dispararía en el acto la corrida de la noche en que se borró.
    await this.monitors.save({ ...deletedRow(monitor, now), nextRunAt: null, updatedAt: now });
  }
}

/**
 * Archivar: fuera de la lista y **deja de lanzar corridas**, sin perder nada.
 *
 * Lo segundo es lo que lo distingue de apagarlo a medias: un monitor archivado que siguiera
 * avisando a las tres de la mañana estaría archivado solo en la pantalla.
 *
 * Desarchivar recalcula el turno desde ahora por el mismo motivo por el que encenderlo lo hace: no
 * se deben las corridas de los días que estuvo fuera.
 */
export class SetMonitorArchivedCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
    readonly archived: boolean,
  ) {}
}

@CommandHandler(SetMonitorArchivedCommand)
export class SetMonitorArchivedHandler implements ICommandHandler<SetMonitorArchivedCommand, MonitorView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetMonitorArchivedCommand): Promise<MonitorView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const monitor = await this.monitors.findById(project.id, command.monitorId);
    if (!monitor) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");
    if (monitor.deletedAt)
      throw new ConflictError("Restaura el monitor antes de archivarlo", "monitor-deleted");

    const now = this.clock.now();
    // Archivar deja el turno en nulo, que es lo que lo saca del reclamo; desarchivar lo recalcula
    // desde ahora por el mismo camino que encenderlo, y por el mismo motivo.
    const updated = command.archived
      ? { ...archivedRow(monitor, now), nextRunAt: null, updatedAt: now }
      : withChanges(archivedRow(monitor, null), {}, now);
    await this.monitors.save(updated);
    return viewMonitor(updated);
  }
}

/**
 * Restaurar lo eliminado. Vuelve **a donde estaba**: si se archivó antes de borrarlo, vuelve a los
 * archivados, porque `archivedAt` nunca se tocó.
 *
 * El nombre puede haber sido reutilizado mientras estaba fuera —la comprobación de duplicados solo
 * mira los vivos—, así que esto es un 409 y no un cambio de nombre a espaldas de nadie.
 */
export class RestoreMonitorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
  ) {}
}

@CommandHandler(RestoreMonitorCommand)
export class RestoreMonitorHandler implements ICommandHandler<RestoreMonitorCommand, MonitorView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestoreMonitorCommand): Promise<MonitorView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const monitor = await this.monitors.findById(project.id, command.monitorId);
    if (!monitor) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");
    if (!monitor.deletedAt) return viewMonitor(monitor);

    const live = await this.monitors.listByProject(project.id);
    if (live.some((row) => row.name === monitor.name))
      throw new ConflictError(`Ya hay un monitor llamado «${monitor.name}»`, "monitor-duplicate-name");
    if (live.length >= MAX_MONITORS_PER_PROJECT)
      throw new ConflictError(
        `Este proyecto ya tiene ${MAX_MONITORS_PER_PROJECT} monitores: borra alguno antes de restaurar este`,
        "monitors-full",
      );

    const now = this.clock.now();
    // El turno quedó en nulo al borrarlo, así que esto lo recalcula desde ahora: al volver no debe
    // las corridas de los días que estuvo fuera. Lo que vuelve archivado sigue sin turno.
    const back = withChanges(restoredRow(monitor), {}, now);
    const updated = back.archivedAt ? { ...back, nextRunAt: null } : back;
    await this.monitors.save(updated);
    return viewMonitor(updated);
  }
}

/**
 * «Correr ahora»: el mismo camino que el turno, y **sin tocar el turno**.
 *
 * Adelantar el siguiente turno por haber corrido a mano convertiría el botón en «reprogramar»,
 * que no es lo que dice. Y se salta igual si la anterior sigue viva: el motivo de no solapar no
 * cambia porque quien pulsa sea una persona.
 */
export class RunMonitorNowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
  ) {}
}

@CommandHandler(RunMonitorNowCommand)
export class RunMonitorNowHandler implements ICommandHandler<
  RunMonitorNowCommand,
  { runId: string | null; outcome: string; note: string }
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    private readonly firer: MonitorFirer,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RunMonitorNowCommand) {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const monitor = await this.monitors.findById(project.id, command.monitorId);
    if (!monitor) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");

    const fired = await this.firer.fire(monitor, project.organizationId, this.clock.now());
    return { runId: fired.runId, outcome: fired.execution.outcome, note: fired.execution.note };
  }
}
