import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { SecurityRun } from "../../domain/model";
import { SECURITY_RUN_REPOSITORY, type SecurityRunRepositoryPort } from "../../domain/ports";
import { owned } from "../commands/manage-security-run";
import { toSecurityReportHtml, toSecurityReportJson, type SecurityReportFormat } from "../../presentation/report";

/** Resolves endpoint labels once and renders the run as JSON or HTML. */
async function render(
  endpoints: EndpointRepositoryPort,
  run: SecurityRun,
  format: SecurityReportFormat,
  now: Date,
): Promise<{ contentType: string; body: string | unknown }> {
  const labels = new Map(
    (await endpoints.listAll(run.projectId)).map((endpoint) => [endpoint.id, `${endpoint.method} ${endpoint.path}`]),
  );
  const endpointLabel = (id: string | null) => (id ? (labels.get(id) ?? id.slice(0, 8)) : "—");
  const input = { run, endpointLabel, generatedAt: now };
  return format === "html"
    ? { contentType: "text/html; charset=utf-8", body: toSecurityReportHtml(input) }
    : { contentType: "application/json", body: toSecurityReportJson(input) };
}

export class GetSecurityReportQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
    readonly format: SecurityReportFormat,
  ) {}
}

@QueryHandler(GetSecurityReportQuery)
export class GetSecurityReportHandler implements IQueryHandler<GetSecurityReportQuery> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(query: GetSecurityReportQuery) {
    const run = await owned(this.projects, this.runs, query.organizationId, query.projectId, query.runId);
    return render(this.endpoints, run, query.format, this.clock.now());
  }
}

export class GetSharedSecurityReportQuery implements IQuery {
  constructor(
    readonly shareToken: string,
    readonly format: SecurityReportFormat,
  ) {}
}

@QueryHandler(GetSharedSecurityReportQuery)
export class GetSharedSecurityReportHandler implements IQueryHandler<GetSharedSecurityReportQuery> {
  constructor(
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(query: GetSharedSecurityReportQuery) {
    const run = await this.runs.findByShareToken(query.shareToken);
    if (!run || run.visibility !== "public")
      throw new NotFoundError("La corrida no existe o no es pública", "security-run-not-found");
    return render(this.endpoints, run, query.format, this.clock.now());
  }
}
