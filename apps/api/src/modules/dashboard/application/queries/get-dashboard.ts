import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { DashboardProjectView, DashboardView } from "@eq/contracts";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { RUN_REPOSITORY, type RunRepositoryPort } from "@/modules/runs/domain/ports";
import { SECURITY_RUN_REPOSITORY, type SecurityRunRepositoryPort } from "@/modules/security-runs/domain/ports";
import { PERFORMANCE_RUN_REPOSITORY, type PerformanceRunRepositoryPort } from "@/modules/performance/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";

export class GetDashboardQuery implements IQuery {
  constructor(readonly organizationId: string) {}
}

const TERMINAL = new Set(["passed", "failed", "cancelled", "error"]);
const time = (date: Date | null | undefined) => (date ? date.getTime() : 0);

/**
 * The organization's projects, each reduced to the numbers a dashboard shows.
 *
 * A read across every module — endpoints, contract runs, security, performance, flows — so it lives
 * in its own module that imports the others' repositories rather than any one of them reaching across.
 * N queries per project, which is fine for a dashboard of a handful of projects and honest about what
 * it costs; a materialised summary is the thing to reach for only once that stops being true.
 */
@QueryHandler(GetDashboardQuery)
export class GetDashboardHandler implements IQueryHandler<GetDashboardQuery, DashboardView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly securityRuns: SecurityRunRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly performanceRuns: PerformanceRunRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(query: GetDashboardQuery): Promise<DashboardView> {
    const projects = await this.projects.listForOrganization(query.organizationId, true);
    const rows = await Promise.all(
      projects.map((project) => this.projectRow(project.id, project.name, project.archivedAt != null)),
    );

    const scores = rows.map((row) => row.securityScore).filter((score): score is number => score != null);
    return {
      totals: {
        projects: projects.filter((project) => project.archivedAt == null).length,
        endpoints: rows.reduce((sum, row) => sum + row.endpoints, 0),
        avgSecurityScore: scores.length
          ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
          : null,
      },
      projects: rows,
    };
  }

  private async projectRow(projectId: string, name: string, archived: boolean): Promise<DashboardProjectView> {
    const [counts, flows, security, contract, performance] = await Promise.all([
      this.endpoints.counts(projectId),
      this.workflows.listWorkflows(projectId),
      this.securityRuns.listForProject(projectId, 20),
      this.runs.listForProject(projectId, 10),
      this.performanceRuns.list(projectId),
    ]);

    const lastSecurity = security.find((run) => TERMINAL.has(run.status));
    const lastContract = contract.find((run) => TERMINAL.has(run.status));
    const lastPerf = performance.find((run) => run.summary != null);

    const passRate =
      lastContract && lastContract.totals.passed + lastContract.totals.failed > 0
        ? lastContract.totals.passed / (lastContract.totals.passed + lastContract.totals.failed)
        : null;

    const lastActivity = Math.max(
      time(security[0]?.startedAt),
      time(contract[0]?.startedAt),
      time(performance[0]?.startedAt),
    );

    return {
      id: projectId,
      name,
      archived,
      endpoints: counts.active ?? 0,
      flows: flows.length,
      securityScore: lastSecurity?.score ?? null,
      passRate,
      perfP95Ms: lastPerf?.summary?.p95Ms ?? null,
      lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
    };
  }
}
