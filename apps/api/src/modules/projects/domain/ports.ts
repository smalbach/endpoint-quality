import type { ForkWritePlan, ProjectFork } from "./fork";
import type { ForkMergeRequest, MergeRequestEvent } from "./merge-request";
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
 * `apply` escribe un plan de sincronización entero —endpoints, pruebas, flujos, datasets, suites,
 * entornos, roles, secciones y la nueva foto— o nada, y solo si la bifurcación sigue en la versión
 * que el plan espera: si no, un `ConflictError` y nada escrito. Vive aquí y no repartido entre los repositorios de cada módulo porque
 * «todo o nada» solo lo puede prometer quien abre la transacción, y ese tiene que ser uno.
 */
export interface ProjectForkRepositoryPort {
  findByFork(forkProjectId: string): Promise<ProjectFork | null>;
  listByParent(parentProjectId: string): Promise<ProjectFork[]>;
  save(fork: ProjectFork): Promise<void>;
  apply(plan: ForkWritePlan): Promise<void>;
}

export const MERGE_REQUEST_REPOSITORY = Symbol("MERGE_REQUEST_REPOSITORY");

/**
 * Las solicitudes de fusión y su hilo. Guardar una fusionada va por `ProjectForkRepositoryPort.apply`,
 * dentro de la transacción del plan: una solicitud «fusionada» cuyo plan no se escribió, o al revés,
 * es justo lo que no puede quedar.
 */
export interface MergeRequestRepositoryPort {
  findById(organizationId: string, id: string): Promise<ForkMergeRequest | null>;
  /** Las de un proyecto, como original o como bifurcación, las más recientes primero. */
  listForProject(organizationId: string, projectId: string): Promise<ForkMergeRequest[]>;
  save(request: ForkMergeRequest): Promise<void>;
  listEvents(requestId: string): Promise<MergeRequestEvent[]>;
  addEvent(event: MergeRequestEvent): Promise<void>;
}
