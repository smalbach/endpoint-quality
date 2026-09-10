import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import type { SpecOperation, SpecVersionSummary } from "../../domain/model";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "../../domain/ports";

export class GetOperationsQuery implements IQuery {
  /** `specVersionId` absent means the project's active version, which is what every caller
   * wants except the drift view. */
  constructor(readonly organizationId: string, readonly projectId: string, readonly specVersionId?: string) {}
}
export class ListSpecVersionsQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string) {}
}

export type OperationsView = {
  specVersionId: string;
  contractVersion: string;
  operations: SpecOperation[];
  /** Every distinct tag, in first-seen order, for the filter the dashboard renders. Derived
   * here rather than in the browser so a client that paginates still gets the full set. */
  tags: string[];
};

@QueryHandler(GetOperationsQuery)
export class GetOperationsHandler implements IQueryHandler<GetOperationsQuery, OperationsView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
  ) {}

  async execute(query: GetOperationsQuery): Promise<OperationsView> {
    const project = await this.projects.findById(query.projectId);
    if (!project || project.organizationId !== query.organizationId) throw new NotFoundError("El proyecto no existe", "project-not-found");

    const versionId = query.specVersionId ?? project.activeSpecVersionId;
    if (!versionId) throw new ConflictError("El proyecto todavía no tiene contrato importado", "no-active-spec");

    const version = await this.specs.findVersionById(versionId);
    if (!version || version.projectId !== project.id) throw new NotFoundError("La versión no existe", "spec-version-not-found");

    const operations = await this.specs.listOperations(version.id);
    return {
      specVersionId: version.id,
      contractVersion: version.contractVersion,
      operations,
      tags: [...new Set(operations.map((operation) => operation.tag).filter(Boolean))],
    };
  }
}

@QueryHandler(ListSpecVersionsQuery)
export class ListSpecVersionsHandler implements IQueryHandler<ListSpecVersionsQuery, { active: string | null; versions: SpecVersionSummary[] }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
  ) {}

  async execute(query: ListSpecVersionsQuery) {
    const project = await this.projects.findById(query.projectId);
    if (!project || project.organizationId !== query.organizationId) throw new NotFoundError("El proyecto no existe", "project-not-found");
    // Summaries, never the raw documents: ten versions of a 120 KB contract is 1.2 MB the
    // browser has no use for.
    return { active: project.activeSpecVersionId, versions: await this.specs.listVersions(project.id) };
  }
}
