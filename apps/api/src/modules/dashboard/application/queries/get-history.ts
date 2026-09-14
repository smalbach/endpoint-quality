import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { HistoryEntryView, HistoryKind, HistoryPageView } from "@eq/contracts";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { RUN_REPOSITORY, type RunRepositoryPort } from "@/modules/runs/domain/ports";
import { SECURITY_RUN_REPOSITORY, type SecurityRunRepositoryPort } from "@/modules/security-runs/domain/ports";
import { PERFORMANCE_RUN_REPOSITORY, type PerformanceRunRepositoryPort } from "@/modules/performance/domain/ports";
import { CODE_SCAN_REPOSITORY, type CodeScanRepositoryPort } from "@/modules/code-scan/domain/ports";

export type HistoryFilters = { search: string; kind: HistoryKind | "all"; page: number; pageSize: number };

export class GetHistoryQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly filters: HistoryFilters,
  ) {}
}

const PER_PROJECT = 50;
const pct = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Every analysis the organization has run, from every module, in one list.
 *
 * The value is the single timeline: «what was run, and how did it go» without opening four screens.
 * Each module keeps its own rows; this reads the recent ones from each, tags them with a kind and a
 * headline number, and merges them by time. Search and paging happen in memory over that merged list
 * — honest for a history of hundreds, and the point at which it stops being honest is the point to
 * give history its own table.
 */
@QueryHandler(GetHistoryQuery)
export class GetHistoryHandler implements IQueryHandler<GetHistoryQuery, HistoryPageView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly securityRuns: SecurityRunRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly performanceRuns: PerformanceRunRepositoryPort,
    @Inject(CODE_SCAN_REPOSITORY) private readonly scans: CodeScanRepositoryPort,
  ) {}

  async execute(query: GetHistoryQuery): Promise<HistoryPageView> {
    const projects = await this.projects.listForOrganization(query.organizationId, true);
    const entries: HistoryEntryView[] = [];

    for (const project of projects) {
      const p = (path: string) => `/p/${project.id}/${path}`;
      const [security, contract, performance, scans] = await Promise.all([
        this.securityRuns.listForProject(project.id, PER_PROJECT),
        this.runs.listForProject(project.id, PER_PROJECT),
        this.performanceRuns.list(project.id),
        this.scans.list(project.id),
      ]);

      for (const run of security)
        entries.push({
          id: run.id,
          projectId: project.id,
          projectName: project.name,
          kind: "security",
          title: run.label || "Corrida de seguridad",
          status: run.status,
          metric: run.score != null ? `${run.score}/100` : null,
          href: p(`security/${run.id}`),
          createdAt: run.startedAt.toISOString(),
        });

      for (const run of contract)
        entries.push({
          id: run.id,
          projectId: project.id,
          projectName: project.name,
          kind: "contract",
          title: "Corrida de contrato",
          status: run.status,
          metric:
            run.totals.passed + run.totals.failed > 0
              ? pct(run.totals.passed / (run.totals.passed + run.totals.failed))
              : null,
          href: p(`runs/${run.id}`),
          createdAt: run.startedAt.toISOString(),
        });

      for (const run of performance.slice(0, PER_PROJECT))
        entries.push({
          id: run.id,
          projectId: project.id,
          projectName: project.name,
          kind: "performance",
          title: `Carga: ${run.planName}`,
          status: run.status,
          metric: run.summary ? `p95 ${Math.round(run.summary.p95Ms)} ms` : null,
          href: p(`performance/${run.id}`),
          createdAt: run.startedAt.toISOString(),
        });

      for (const scan of scans.slice(0, PER_PROJECT))
        entries.push({
          id: scan.id,
          projectId: project.id,
          projectName: project.name,
          kind: "scan",
          title: `Escaneo (${scan.source === "github" ? scan.ref : "subida"})`,
          status: scan.status,
          metric: `+${scan.diff.added.length} ~${scan.diff.changed.length} −${scan.diff.removed.length}`,
          href: p("code-scan"),
          createdAt: scan.createdAt.toISOString(),
        });
    }

    const search = query.filters.search.trim().toLowerCase();
    const filtered = entries
      .filter((entry) => query.filters.kind === "all" || entry.kind === query.filters.kind)
      .filter((entry) => !search || `${entry.projectName} ${entry.title}`.toLowerCase().includes(search))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const page = Math.max(1, query.filters.page);
    const pageSize = Math.min(100, Math.max(1, query.filters.pageSize));
    const start = (page - 1) * pageSize;
    return { entries: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize };
  }
}
