import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import { SEVERITY_RANK, type Finding, type ProbeResult, type Severity } from "@eq/security-rules";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { SecurityRun } from "../../domain/model";
import { SECURITY_RUN_LIST_FIELDS } from "../../domain/model";
import { SECURITY_RUN_REPOSITORY, type SecurityRunRepositoryPort } from "../../domain/ports";
import { owned } from "../commands/manage-security-run";

/** The list view: the head of the run, no findings or probes. */
export type SecurityRunSummaryView = Pick<SecurityRun, (typeof SECURITY_RUN_LIST_FIELDS)[number]>;

export class ListSecurityRunsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly limit: number,
  ) {}
}

@QueryHandler(ListSecurityRunsQuery)
export class ListSecurityRunsHandler implements IQueryHandler<ListSecurityRunsQuery, SecurityRunSummaryView[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
  ) {}

  async execute(query: ListSecurityRunsQuery): Promise<SecurityRunSummaryView[]> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const runs = await this.runs.listForProject(query.projectId, Math.min(Math.max(query.limit, 1), 100));
    return runs.map((run) => pick(run));
  }
}

const pick = (run: SecurityRun): SecurityRunSummaryView =>
  Object.fromEntries(SECURITY_RUN_LIST_FIELDS.map((field) => [field, run[field]])) as SecurityRunSummaryView;

export type SecurityRunFilters = {
  severity?: Severity;
  ruleKey?: string;
  endpointId?: string;
  method?: string;
  /** Probes: only those whose status is in this HTTP family (2, 4, 5…). */
  statusFamily?: number;
  testType?: string;
  page: number;
  pageSize: number;
};

/**
 * The detail view: the run's head, its findings (filtered, worst first) and a page of probes.
 *
 * Findings and probes are filtered and paged in the handler over the stored jsonb, the same way the
 * contract run detail slices its cases — a table per finding would be one more thing to keep in
 * step with the jsonb the report is built from.
 */
export type SecurityRunDetailView = Omit<SecurityRun, "probes"> & {
  probes: { data: ProbeResult[]; page: number; pageSize: number; total: number };
  findingsTotal: number;
};

export class GetSecurityRunQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
    readonly filters: SecurityRunFilters,
  ) {}
}

@QueryHandler(GetSecurityRunQuery)
export class GetSecurityRunHandler implements IQueryHandler<GetSecurityRunQuery, SecurityRunDetailView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
  ) {}

  async execute(query: GetSecurityRunQuery): Promise<SecurityRunDetailView> {
    const run = await owned(this.projects, this.runs, query.organizationId, query.projectId, query.runId);
    return buildDetail(run, query.filters);
  }
}

export function buildDetail(run: SecurityRun, filters: SecurityRunFilters): SecurityRunDetailView {
  const findings = filterFindings(run.findings, filters).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const probes = filterProbes(run.probes, filters);
  const page = Math.max(1, filters.page);
  const pageSize = Math.min(Math.max(filters.pageSize, 1), 200);
  const start = (page - 1) * pageSize;
  return {
    ...run,
    findings,
    findingsTotal: findings.length,
    probes: { data: probes.slice(start, start + pageSize), page, pageSize, total: probes.length },
  };
}

function filterFindings(findings: Finding[], filters: SecurityRunFilters): Finding[] {
  return findings.filter(
    (finding) =>
      (!filters.severity || finding.severity === filters.severity) &&
      (!filters.ruleKey || finding.ruleKey === filters.ruleKey) &&
      (!filters.endpointId || finding.endpointId === filters.endpointId),
  );
}

function filterProbes(probes: ProbeResult[], filters: SecurityRunFilters): ProbeResult[] {
  return probes.filter(
    (probe) =>
      (!filters.endpointId || probe.endpointId === filters.endpointId) &&
      (!filters.method || probe.method === filters.method) &&
      (!filters.testType || probe.testType.startsWith(filters.testType)) &&
      (!filters.statusFamily || Math.floor(probe.status / 100) === filters.statusFamily),
  );
}

/** Loads a run by its share token — the public read, no session. */
export class GetSharedSecurityRunQuery implements IQuery {
  constructor(
    readonly shareToken: string,
    readonly filters: SecurityRunFilters,
  ) {}
}

@QueryHandler(GetSharedSecurityRunQuery)
export class GetSharedSecurityRunHandler implements IQueryHandler<GetSharedSecurityRunQuery, SecurityRunDetailView> {
  constructor(@Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort) {}

  async execute(query: GetSharedSecurityRunQuery): Promise<SecurityRunDetailView> {
    // A share link works only while the run is public: turning it private closes the link even
    // though the token still exists, so the check is on `visibility`, not on the token alone.
    const run = await this.runs.findByShareToken(query.shareToken);
    if (!run || run.visibility !== "public")
      throw new NotFoundError("La corrida no existe o no es pública", "security-run-not-found");
    return buildDetail(run, query.filters);
  }
}
