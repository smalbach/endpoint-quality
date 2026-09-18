import type { ForkWritePlan, ProjectFork } from "./fork";
import type { Project } from "./model";

export const PROJECT_REPOSITORY = Symbol("PROJECT_REPOSITORY");

export interface ProjectRepositoryPort {
  findById(id: string): Promise<Project | null>;
  findBySlug(organizationId: string, slug: string): Promise<Project | null>;
  listForOrganization(organizationId: string, includeArchived: boolean): Promise<Project[]>;
  save(project: Project): Promise<void>;
}

export const PROJECT_FORK_REPOSITORY = Symbol("PROJECT_FORK_REPOSITORY");

/**
 * Las bifurcaciones y su foto común.
 *
 * `apply` escribe un plan de sincronización entero —endpoints, pruebas, flujos, datasets, entornos
 * y la nueva foto— o nada. Vive aquí y no repartido entre los repositorios de cada módulo porque
 * «todo o nada» solo lo puede prometer quien abre la transacción, y ese tiene que ser uno.
 */
export interface ProjectForkRepositoryPort {
  findByFork(forkProjectId: string): Promise<ProjectFork | null>;
  listByParent(parentProjectId: string): Promise<ProjectFork[]>;
  save(fork: ProjectFork): Promise<void>;
  apply(plan: ForkWritePlan): Promise<void>;
}
