import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Run, RunCase, RunStep } from "../../domain/model";
import { RUN_REPOSITORY, type RunRepositoryPort } from "../../domain/ports";

export class ListRunsQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string, readonly limit = 25) {}
}
export class GetRunQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string, readonly runId: string) {}
}
export class GetRunCaseQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string, readonly runId: string, readonly caseId: string) {}
}

export type RunView = Run & { cases: RunCase[] };
export type RunCaseView = RunCase & { steps: RunStep[] };

@QueryHandler(ListRunsQuery)
export class ListRunsHandler implements IQueryHandler<ListRunsQuery, Run[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}
  async execute(query: ListRunsQuery): Promise<Run[]> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    return this.runs.listForProject(project.id, Math.min(100, Math.max(1, query.limit)));
  }
}

/**
 * A run with its case list, but **without the steps**.
 *
 * The steps hold full response bodies — a 311-case run is close to a thousand of them — and the
 * run view is what the progress screen polls. Shipping every body to render a list of green and
 * red rows would make the page slower the more there is to show.
 */
@QueryHandler(GetRunQuery)
export class GetRunHandler implements IQueryHandler<GetRunQuery, RunView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}
  async execute(query: GetRunQuery): Promise<RunView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const run = await this.runs.findById(query.runId);
    if (!run || run.projectId !== project.id) throw new NotFoundError("La corrida no existe", "run-not-found");
    return { ...run, cases: await this.runs.listCases(run.id) };
  }
}

/** One case with everything it did: the request as sent, the response as received, and every
 * assertion. This is the evidence view, and it is fetched one case at a time. */
@QueryHandler(GetRunCaseQuery)
export class GetRunCaseHandler implements IQueryHandler<GetRunCaseQuery, RunCaseView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}
  async execute(query: GetRunCaseQuery): Promise<RunCaseView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const run = await this.runs.findById(query.runId);
    if (!run || run.projectId !== project.id) throw new NotFoundError("La corrida no existe", "run-not-found");
    const runCase = await this.runs.findCase(query.caseId);
    if (!runCase || runCase.runId !== run.id) throw new NotFoundError("El caso no existe", "run-case-not-found");
    return { ...runCase, steps: await this.runs.listSteps(runCase.id) };
  }
}
