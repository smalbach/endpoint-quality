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
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
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
  ) {}

  async execute(command: CreateMonitorCommand): Promise<MonitorView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const problems = monitorProblems(command.input, { requireAll: true });
    if (problems.length) throw new InvalidInputError("El monitor no es válido", problems);

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
      plan: command.input.plan,
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

    const updated = withChanges(current, command.input, this.clock.now());
    await this.monitors.save(updated);
    return viewMonitor(updated);
  }
}

export class DeleteMonitorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
  ) {}
}

@CommandHandler(DeleteMonitorCommand)
export class DeleteMonitorHandler implements ICommandHandler<DeleteMonitorCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
  ) {}

  async execute(command: DeleteMonitorCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const gone = await this.monitors.remove(project.id, command.monitorId);
    if (!gone) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");
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
