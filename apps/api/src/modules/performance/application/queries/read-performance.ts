import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type {
  PerformanceComparisonViewOf,
  PerformancePlanViewOf,
  PerformanceRunDetailViewOf,
  PerformanceRunSummaryViewOf,
} from "@eq/contracts";

import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { compareRuns } from "../../domain/compare";
import type { PerformancePlanRow, PerformanceRun } from "../../domain/model";
import {
  PERFORMANCE_PLAN_REPOSITORY,
  PERFORMANCE_RUN_REPOSITORY,
  type PerformancePlanRepositoryPort,
  type PerformanceRunRepositoryPort,
} from "../../domain/ports";

export const planView = (row: PerformancePlanRow): PerformancePlanViewOf<Date> => ({
  id: row.id,
  name: row.name,
  description: row.description,
  definition: row.definition,
  updatedAt: row.updatedAt,
});

export const runSummaryView = (run: PerformanceRun): PerformanceRunSummaryViewOf<Date> => ({
  id: run.id,
  planId: run.planId,
  planName: run.planName,
  status: run.status,
  summary: run.summary,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

export const runDetailView = (run: PerformanceRun): PerformanceRunDetailViewOf<Date> => ({
  id: run.id,
  projectId: run.projectId,
  planId: run.planId,
  planName: run.planName,
  environmentId: run.environmentId,
  status: run.status,
  definition: run.definition,
  progress: run.progress,
  summary: run.summary,
  windows: run.windows,
  endpoints: run.endpoints,
  thresholds: run.thresholds,
  error: run.error,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

export class ListPlansQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}
export class GetPlanQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string,
  ) {}
}
export class ListRunsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string | undefined,
  ) {}
}
export class GetRunQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

export class CompareRunsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly baseRunId: string,
    readonly targetRunId: string,
  ) {}
}

@QueryHandler(ListPlansQuery)
export class ListPlansHandler implements IQueryHandler<ListPlansQuery, PerformancePlanViewOf<Date>[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
  ) {}

  async execute(query: ListPlansQuery): Promise<PerformancePlanViewOf<Date>[]> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    return (await this.plans.list(query.projectId)).map(planView);
  }
}

@QueryHandler(GetPlanQuery)
export class GetPlanHandler implements IQueryHandler<GetPlanQuery, PerformancePlanViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
  ) {}

  async execute(query: GetPlanQuery): Promise<PerformancePlanViewOf<Date>> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const plan = await this.plans.find(query.projectId, query.planId);
    if (!plan) throw new NotFoundError("El plan no existe", "performance-plan-not-found");
    return planView(plan);
  }
}

@QueryHandler(ListRunsQuery)
export class ListRunsHandler implements IQueryHandler<ListRunsQuery, PerformanceRunSummaryViewOf<Date>[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
  ) {}

  async execute(query: ListRunsQuery): Promise<PerformanceRunSummaryViewOf<Date>[]> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    return (await this.runs.list(query.projectId, query.planId)).map(runSummaryView);
  }
}

@QueryHandler(GetRunQuery)
export class GetRunHandler implements IQueryHandler<GetRunQuery, PerformanceRunDetailViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
  ) {}

  async execute(query: GetRunQuery): Promise<PerformanceRunDetailViewOf<Date>> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const run = await this.runs.find(query.projectId, query.runId);
    if (!run) throw new NotFoundError("La corrida no existe", "performance-run-not-found");
    return runDetailView(run);
  }
}

@QueryHandler(CompareRunsQuery)
export class CompareRunsHandler implements IQueryHandler<CompareRunsQuery, PerformanceComparisonViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
  ) {}

  async execute(query: CompareRunsQuery): Promise<PerformanceComparisonViewOf<Date>> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    if (query.baseRunId === query.targetRunId) {
      throw new InvalidInputError("Elige dos corridas distintas para comparar", [], "performance-compare-same-run");
    }
    const base = await this.runs.find(query.projectId, query.baseRunId);
    if (!base) throw new NotFoundError("La corrida base no existe", "performance-run-not-found");
    const target = await this.runs.find(query.projectId, query.targetRunId);
    if (!target) throw new NotFoundError("La corrida a comparar no existe", "performance-run-not-found");
    return compareRuns(base, target);
  }
}
