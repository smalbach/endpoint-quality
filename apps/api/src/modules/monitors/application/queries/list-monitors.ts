import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { NotFoundError } from "@/shared/errors/domain-error";
import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import {
  MONITOR_HISTORY,
  viewExecution,
  viewMonitor,
  type MonitorExecutionView,
  type MonitorView,
} from "../../domain/model";
import { MONITOR_REPOSITORY, type MonitorRepositoryPort } from "../../domain/ports";

/**
 * Los monitores del proyecto, con **las últimas vueltas de cada uno**.
 *
 * Las últimas y no todas: lo que se quiere saber de un monitor al abrir la pantalla es si va bien
 * ahora y si ha ido mal últimamente, y eso son cinco filas. El historial entero se pide por monitor.
 */
export type MonitorListView = {
  monitors: (MonitorView & { recent: MonitorExecutionView[] })[];
};

export class ListMonitorsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Qué lista se pide: los que vigilan, los archivados o los eliminados. */
    readonly state: LifecycleState = "active",
  ) {}
}

const RECENT = 5;

@QueryHandler(ListMonitorsQuery)
export class ListMonitorsHandler implements IQueryHandler<ListMonitorsQuery, MonitorListView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
  ) {}

  async execute(query: ListMonitorsQuery): Promise<MonitorListView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const monitors = await this.monitors.listByProject(project.id, query.state);
    return {
      monitors: await Promise.all(
        monitors.map(async (monitor) => ({
          ...viewMonitor(monitor),
          recent: (await this.monitors.listExecutions(monitor.id, RECENT)).map(viewExecution),
        })),
      ),
    };
  }
}

/** El historial de un monitor: lo que se abre cuando se quiere saber desde cuándo va mal. */
export class MonitorHistoryQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly monitorId: string,
  ) {}
}

export type MonitorHistoryView = { monitor: MonitorView; executions: MonitorExecutionView[] };

@QueryHandler(MonitorHistoryQuery)
export class MonitorHistoryHandler implements IQueryHandler<MonitorHistoryQuery, MonitorHistoryView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
  ) {}

  async execute(query: MonitorHistoryQuery): Promise<MonitorHistoryView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const monitor = await this.monitors.findById(project.id, query.monitorId);
    if (!monitor) throw new NotFoundError("Ese monitor no existe", "monitor-not-found");
    return {
      monitor: viewMonitor(monitor),
      executions: (await this.monitors.listExecutions(monitor.id, MONITOR_HISTORY)).map(viewExecution),
    };
  }
}
