import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";

export class ListProjectsQuery implements IQuery {
  constructor(readonly organizationId: string, readonly includeArchived: boolean) {}
}
export class GetProjectQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string) {}
}

export type ProjectSummary = {
  id: string; name: string; slug: string; description: string; archivedAt: Date | null;
  contract: { versionId: string; title: string; version: string; operationCount: number; importedAt: Date } | null;
};

@QueryHandler(ListProjectsQuery)
export class ListProjectsHandler implements IQueryHandler<ListProjectsQuery, ProjectSummary[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
  ) {}

  async execute(query: ListProjectsQuery): Promise<ProjectSummary[]> {
    const projects = await this.projects.listForOrganization(query.organizationId, query.includeArchived);
    return Promise.all(projects.map((project) => summarize(project, this.specs)));
  }
}

@QueryHandler(GetProjectQuery)
export class GetProjectHandler implements IQueryHandler<GetProjectQuery, ProjectSummary> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
  ) {}

  async execute(query: GetProjectQuery): Promise<ProjectSummary> {
    const project = await this.projects.findById(query.projectId);
    if (!project || project.organizationId !== query.organizationId) throw new NotFoundError("El proyecto no existe", "project-not-found");
    return summarize(project, this.specs);
  }
}

async function summarize(project: { id: string; name: string; slug: string; description: string; archivedAt: Date | null; activeSpecVersionId: string | null }, specs: SpecRepositoryPort): Promise<ProjectSummary> {
  // `contract: null` is a real state and the UI has to render it: a project exists before its
  // first import, because importing can fail and losing the project with it helps nobody.
  const active = project.activeSpecVersionId ? await specs.findVersionById(project.activeSpecVersionId) : null;
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    archivedAt: project.archivedAt,
    contract: active ? { versionId: active.id, title: active.title, version: active.contractVersion, operationCount: active.operationCount, importedAt: active.importedAt } : null,
  };
}
