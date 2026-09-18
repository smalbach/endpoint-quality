import type { ForkWritePlan, ProjectFork } from "@/modules/projects/domain/fork";
import type { ProjectForkRepositoryPort, ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import type { EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";

/**
 * Las bifurcaciones en memoria, y el plan escrito a través de los repositorios en memoria de cada
 * módulo —los mismos que leen las rutas—, para que lo que un test ve después de sincronizar sea lo
 * que vería cualquier pantalla.
 *
 * La transacción no se puede imitar aquí; lo que sí se imita es el orden del adaptador de verdad:
 * primero lo que se borra, luego lo que se escribe, y la foto al final.
 */
export class InMemoryProjectForkRepository implements ProjectForkRepositoryPort {
  readonly rows = new Map<string, ProjectFork>();

  constructor(
    private readonly deps: {
      projects: ProjectRepositoryPort;
      endpoints: EndpointRepositoryPort;
      workflows: WorkflowRepositoryPort;
      environments: EnvironmentRepositoryPort;
    },
  ) {}

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
    const projectId = plan.targetProjectId;
    const { endpoints, workflows, environments, projects } = this.deps;
    await endpoints.softDelete(projectId, plan.endpoints.remove, plan.at);
    for (const id of plan.datasets.remove) await workflows.deleteDataset(projectId, id);
    for (const id of plan.workflows.remove) await workflows.deleteWorkflow(projectId, id);
    for (const id of plan.templates.remove) await workflows.deleteTemplate(projectId, id);
    for (const id of plan.environments.remove) await environments.remove(id);
    if (plan.endpoints.save.length) await endpoints.saveMany(plan.endpoints.save);
    for (const row of plan.templates.save) await workflows.saveTemplate(row);
    for (const row of plan.workflows.save) await workflows.saveWorkflow(row);
    for (const row of plan.datasets.save) await workflows.saveDataset(row);
    for (const row of plan.environments.save) await environments.save(row);
    if (plan.project) {
      const current = await projects.findById(plan.project.id);
      if (current) await projects.save({ ...current, activeEnvironmentId: plan.project.activeEnvironmentId });
    }
    await this.save(plan.fork);
  }
}
