import { ConflictError } from "@/shared/errors/domain-error";
import type { ForkWritePlan, ProjectFork } from "@/modules/projects/domain/fork";
import type { ForkMergeRequest, MergeRequestEvent } from "@/modules/projects/domain/merge-request";
import type {
  MergeRequestRepositoryPort,
  ProjectForkRepositoryPort,
  ProjectRepositoryPort,
} from "@/modules/projects/domain/ports";
import type { ConfigRepositoryPort } from "@/modules/config/domain/ports";
import type { EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { RoleRepositoryPort } from "@/modules/roles/domain/ports";
import type { WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";

/**
 * Las solicitudes de fusión en memoria, con el índice único parcial de la migración respetado: una
 * segunda pendiente para la misma bifurcación es el mismo 409 que daría Postgres.
 */
export class InMemoryMergeRequestRepository implements MergeRequestRepositoryPort {
  readonly rows = new Map<string, ForkMergeRequest>();
  readonly events: MergeRequestEvent[] = [];

  async findById(organizationId: string, id: string): Promise<ForkMergeRequest | null> {
    const row = this.rows.get(id);
    return row && row.organizationId === organizationId ? structuredClone(row) : null;
  }

  async listForProject(organizationId: string, projectId: string): Promise<ForkMergeRequest[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.organizationId === organizationId &&
          (row.parentProjectId === projectId || row.forkProjectId === projectId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => structuredClone(row));
  }

  async save(request: ForkMergeRequest): Promise<void> {
    const pending = (row: ForkMergeRequest) => row.status === "open" || row.status === "approved";
    if (pending(request)) {
      for (const other of this.rows.values())
        if (other.id !== request.id && other.forkProjectId === request.forkProjectId && pending(other))
          throw new ConflictError("Esta bifurcación ya tiene una solicitud pendiente", "merge-request-pending");
    }
    this.rows.set(request.id, structuredClone(request));
  }

  async listEvents(requestId: string): Promise<MergeRequestEvent[]> {
    return this.events.filter((event) => event.requestId === requestId).map((event) => ({ ...event }));
  }

  async addEvent(event: MergeRequestEvent): Promise<void> {
    this.events.push({ ...event });
  }
}

/**
 * Las bifurcaciones en memoria, y el plan escrito a través de los repositorios en memoria de cada
 * módulo —los mismos que leen las rutas—, para que lo que un test ve después de sincronizar sea lo
 * que vería cualquier pantalla.
 *
 * La transacción no se puede imitar aquí; lo que sí se imita es el orden del adaptador de verdad
 * —primero lo que se borra, luego lo que se escribe, y la foto al final— y su bloqueo: un `apply`
 * espera a que termine el anterior sobre la misma bifurcación, como el `FOR UPDATE`, y después
 * compara la versión. `holdApplies(n)` deja a los tests juntar `n` aplicaciones antes de soltar
 * ninguna, que es la carrera que el bloqueo existe para ganar.
 */
export class InMemoryProjectForkRepository implements ProjectForkRepositoryPort {
  readonly rows = new Map<string, ProjectFork>();
  private readonly locks = new Map<string, Promise<void>>();
  private gate: { waiting: number; needed: number; open: () => void; opened: Promise<void> } | null = null;

  constructor(
    private readonly deps: {
      projects: ProjectRepositoryPort;
      endpoints: EndpointRepositoryPort;
      workflows: WorkflowRepositoryPort;
      environments: EnvironmentRepositoryPort;
      roles: RoleRepositoryPort;
      config: ConfigRepositoryPort;
      mergeRequests: MergeRequestRepositoryPort;
    },
  ) {}

  /** Las próximas `count` aplicaciones esperan hasta que hayan llegado todas. */
  holdApplies(count: number): void {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    this.gate = { waiting: 0, needed: count, open, opened };
  }

  async findByFork(forkProjectId: string): Promise<ProjectFork | null> {
    const row = this.rows.get(forkProjectId);
    return row ? structuredClone(row) : null;
  }

  async listByParent(parentProjectId: string): Promise<ProjectFork[]> {
    return [...this.rows.values()]
      .filter((row) => row.parentProjectId === parentProjectId)
      .map((row) => structuredClone(row));
  }

  async save(fork: ProjectFork): Promise<void> {
    this.rows.set(fork.forkProjectId, structuredClone(fork));
  }

  async apply(plan: ForkWritePlan): Promise<void> {
    const gate = this.gate;
    if (gate) {
      gate.waiting += 1;
      if (gate.waiting >= gate.needed) {
        this.gate = null;
        gate.open();
      }
      await gate.opened;
    }
    const id = plan.fork.forkProjectId;
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(
      id,
      previous.then(() => mine),
    );
    await previous;
    try {
      if (this.rows.get(id)?.version !== plan.expectedVersion)
        throw new ConflictError(
          "Alguien sincronizó esta bifurcación mientras tanto: vuelve a cargar la comparación",
          "fork-diff-stale",
        );
      await this.write(plan);
    } finally {
      release();
    }
  }

  private async write(plan: ForkWritePlan): Promise<void> {
    const projectId = plan.targetProjectId;
    const { endpoints, workflows, environments, projects, roles, config, mergeRequests } = this.deps;
    await endpoints.softDelete(projectId, plan.endpoints.remove, plan.at);
    for (const id of plan.datasets.remove) await workflows.deleteDataset(projectId, id);
    for (const id of plan.workflows.remove) await workflows.deleteWorkflow(projectId, id);
    for (const id of plan.templates.remove) await workflows.deleteTemplate(projectId, id);
    for (const id of plan.suites.remove) await workflows.deleteSuite(projectId, id);
    for (const id of plan.environments.remove) await environments.remove(id);
    for (const id of plan.roles.remove) await roles.remove(projectId, id);
    for (const section of plan.sections.remove) await config.deleteSection(projectId, section);
    if (plan.endpoints.save.length) await endpoints.saveMany(plan.endpoints.save);
    for (const row of plan.templates.save) await workflows.saveTemplate(row);
    for (const row of plan.workflows.save) await workflows.saveWorkflow(row);
    for (const row of plan.datasets.save) await workflows.saveDataset(row);
    for (const row of plan.suites.save) await workflows.saveSuite(row);
    for (const row of plan.environments.save) await environments.save(row);
    for (const row of plan.roles.save) await roles.save(row);
    const cleared = new Set(plan.roles.permissions.clear);
    const stale = (await roles.listPermissions(projectId)).filter((cell) => cleared.has(cell.roleId));
    await roles.applyPermissions(stale.map((cell) => ({ ...cell, access: "undecided" as const })));
    await roles.applyPermissions(plan.roles.permissions.save);
    if (plan.roles.rules) await roles.replaceRules(projectId, plan.roles.rules);
    for (const row of plan.sections.save) await config.saveSection(row);
    if (plan.project) {
      const current = await projects.findById(plan.project.id);
      if (current) await projects.save({ ...current, activeEnvironmentId: plan.project.activeEnvironmentId });
    }
    await this.save(plan.fork);
    if (plan.mergeRequest) {
      await mergeRequests.save(plan.mergeRequest.request);
      await mergeRequests.addEvent(plan.mergeRequest.event);
    }
  }
}
