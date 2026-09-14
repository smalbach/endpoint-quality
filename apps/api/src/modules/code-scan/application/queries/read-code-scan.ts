import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { CodeConnectorView, CodeScanDetailViewOf, CodeScanSummaryViewOf } from "@eq/contracts";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { CodeConnector, CodeScan } from "../../domain/model";
import {
  CODE_CONNECTOR_REPOSITORY,
  CODE_SCAN_REPOSITORY,
  type CodeConnectorRepositoryPort,
  type CodeScanRepositoryPort,
} from "../../domain/ports";

/** The token never leaves: a read says whether one is stored, never what it is. */
export const connectorView = (connector: CodeConnector | null): CodeConnectorView | null =>
  connector
    ? {
        repo: connector.repo,
        branch: connector.branch,
        basePath: connector.basePath,
        prefix: connector.prefix,
        tokenSet: Boolean(connector.tokenCiphertext),
        updatedAt: connector.updatedAt.toISOString(),
      }
    : null;

export const scanSummaryView = (scan: CodeScan): CodeScanSummaryViewOf<Date> => ({
  id: scan.id,
  source: scan.source,
  ref: scan.ref,
  status: scan.status,
  controllers: scan.result.controllers,
  files: scan.result.files,
  counts: {
    added: scan.diff.added.length,
    removed: scan.diff.removed.length,
    changed: scan.diff.changed.length,
    unchanged: scan.diff.unchanged,
  },
  error: scan.error,
  createdAt: scan.createdAt,
});

export const scanDetailView = (scan: CodeScan): CodeScanDetailViewOf<Date> => ({
  id: scan.id,
  source: scan.source,
  ref: scan.ref,
  status: scan.status,
  result: scan.result,
  diff: scan.diff,
  impact: scan.impact,
  error: scan.error,
  createdAt: scan.createdAt,
});

export class GetConnectorQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}
export class ListScansQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}
export class GetScanQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly scanId: string,
  ) {}
}

@QueryHandler(GetConnectorQuery)
export class GetConnectorHandler implements IQueryHandler<GetConnectorQuery, CodeConnectorView | null> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_CONNECTOR_REPOSITORY) private readonly connectors: CodeConnectorRepositoryPort,
  ) {}

  async execute(query: GetConnectorQuery): Promise<CodeConnectorView | null> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    return connectorView(await this.connectors.find(query.projectId));
  }
}

@QueryHandler(ListScansQuery)
export class ListScansHandler implements IQueryHandler<ListScansQuery, CodeScanSummaryViewOf<Date>[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_SCAN_REPOSITORY) private readonly scans: CodeScanRepositoryPort,
  ) {}

  async execute(query: ListScansQuery): Promise<CodeScanSummaryViewOf<Date>[]> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    return (await this.scans.list(query.projectId)).map(scanSummaryView);
  }
}

@QueryHandler(GetScanQuery)
export class GetScanHandler implements IQueryHandler<GetScanQuery, CodeScanDetailViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_SCAN_REPOSITORY) private readonly scans: CodeScanRepositoryPort,
  ) {}

  async execute(query: GetScanQuery): Promise<CodeScanDetailViewOf<Date>> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const scan = await this.scans.find(query.projectId, query.scanId);
    if (!scan) throw new NotFoundError("El escaneo no existe", "scan-not-found");
    return scanDetailView(scan);
  }
}
