import type { ProjectSummaryOf } from "@eq/contracts";

import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { RUN_REPOSITORY, type RunRepositoryPort } from "@/modules/runs/domain/ports";
import type { Project } from "../../domain/model";
import { viewProjectAuth } from "../../domain/project-auth";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";

export class ListProjectsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly includeArchived: boolean,
  ) {}
}
export class GetProjectQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

/** The wire shape, with this side's timestamps. Written once in `@eq/contracts`, so the browser
 * cannot hold a different opinion about what this returns. */
export type ProjectSummary = ProjectSummaryOf<Date>;

@QueryHandler(ListProjectsQuery)
export class ListProjectsHandler implements IQueryHandler<ListProjectsQuery, ProjectSummary[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}

  async execute(query: ListProjectsQuery): Promise<ProjectSummary[]> {
    const projects = await this.projects.listForOrganization(query.organizationId, query.includeArchived);
    return Promise.all(projects.map((project) => summarize(project, this.specs, this.runs)));
  }
}

@QueryHandler(GetProjectQuery)
export class GetProjectHandler implements IQueryHandler<GetProjectQuery, ProjectSummary> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}

  async execute(query: GetProjectQuery): Promise<ProjectSummary> {
    const project = await this.projects.findById(query.projectId);
    if (!project || project.organizationId !== query.organizationId)
      throw new NotFoundError("El proyecto no existe", "project-not-found");
    return summarize(project, this.specs, this.runs);
  }
}

async function summarize(
  project: Project,
  specs: SpecRepositoryPort,
  runs: RunRepositoryPort,
): Promise<ProjectSummary> {
  // The latest run, whatever it was — a matrix, a flow or a suite — is what the card says the
  // project's health is. The analyzer showed three figures; security and performance join this one
  // when those runs exist.
  const [lastRun] = await runs.listForProject(project.id, 1);
  // `contract: null` is a real state and the UI has to render it: a project exists before its
  // first import, because importing can fail and losing the project with it helps nobody.
  const active = project.activeSpecVersionId ? await specs.findVersionById(project.activeSpecVersionId) : null;
  const source = await specs.findLatestSource(project.id);
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    archivedAt: project.archivedAt,
    baseUrl: project.baseUrl,
    activeEnvironmentId: project.activeEnvironmentId,
    tags: project.tags,
    auth: viewProjectAuth(project.auth),
    lastRun: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          totals: lastRun.totals,
        }
      : null,
    contract: active
      ? {
          versionId: active.id,
          title: active.title,
          version: active.contractVersion,
          operationCount: active.operationCount,
          importedAt: active.importedAt,
        }
      : null,
    source: source
      ? { kind: source.kind, location: source.location, headersStored: source.headersCiphertext !== null }
      : null,
  };
}
