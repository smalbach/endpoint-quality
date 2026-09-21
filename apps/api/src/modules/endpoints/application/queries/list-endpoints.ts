import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Project } from "@/modules/projects/domain/model";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { endpointKey, viewEndpoint, type EndpointStatus, type EndpointView } from "../../domain/model";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "../../domain/ports";

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

export type EndpointListFilter = {
  status?: EndpointStatus | "all";
  search?: string;
  /**
   * `deleted` enseña la papelera; cualquier otra cosa, los vivos.
   *
   * No hay `archived` aquí porque para un endpoint archivar **es** su `status`, y ese ya viaja en
   * `status`: dos maneras de pedir lo mismo acabarían contradiciéndose.
   */
  state?: "active" | "deleted";
  page?: number;
  limit?: number;
};

export class ListEndpointsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly filter: EndpointListFilter,
  ) {}
}

export class GetEndpointQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointId: string,
  ) {}
}

export type EndpointPage = {
  data: EndpointView[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  /** Per status, whatever the filter: what the segmented control shows next to each option. */
  counts: Record<EndpointStatus, number>;
  /** Cuántos hay en la papelera, para el mismo control. */
  deleted: number;
  /** Whether the project has an active contract to compare the rows with. */
  hasContract: boolean;
};

/**
 * The method-and-path keys the active contract declares, or `null` without one.
 *
 * Normalized the same way an endpoint's path is, so `/users/{id}` in the document and a row
 * imported as `/users/:id` are the same endpoint.
 */
export async function contractKeysOf(specs: SpecRepositoryPort, project: Project): Promise<Set<string> | null> {
  if (!project.activeSpecVersionId) return null;
  const operations = await specs.listOperations(project.activeSpecVersionId);
  return new Set(operations.map((operation) => endpointKey(operation.method, operation.path)));
}

@QueryHandler(ListEndpointsQuery)
export class ListEndpointsHandler implements IQueryHandler<ListEndpointsQuery, EndpointPage> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
  ) {}

  async execute(query: ListEndpointsQuery): Promise<EndpointPage> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const page = Math.max(1, Math.floor(query.filter.page ?? 1));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.filter.limit ?? DEFAULT_PAGE_SIZE)));
    const deleted = query.filter.state === "deleted";
    const [{ rows, total }, counts, deletedCount, keys] = await Promise.all([
      this.endpoints.list(project.id, {
        // En la papelera el estado no filtra: lo que se quiere ver es todo lo borrado, y si el
        // control se hubiera quedado en «Activos» la lista saldría vacía sin decir por qué.
        status: deleted ? "all" : query.filter.status ?? "active",
        search: query.filter.search?.trim() ?? "",
        deleted,
        offset: (page - 1) * limit,
        limit,
      }),
      this.endpoints.counts(project.id),
      this.endpoints.countDeleted(project.id),
      contractKeysOf(this.specs, project),
    ]);
    return {
      data: rows.map((row) => viewEndpoint(row, keys)),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      counts,
      deleted: deletedCount,
      hasContract: keys !== null,
    };
  }
}

@QueryHandler(GetEndpointQuery)
export class GetEndpointHandler implements IQueryHandler<GetEndpointQuery, EndpointView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
  ) {}

  async execute(query: GetEndpointQuery): Promise<EndpointView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const endpoint = await this.endpoints.findById(project.id, query.endpointId);
    if (!endpoint) throw new NotFoundError("El endpoint no existe", "endpoint-not-found");
    return viewEndpoint(endpoint, await contractKeysOf(this.specs, project));
  }
}
