import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import type { SourceInput } from "../../domain/analyze-nest";
import type { CodeScan } from "../../domain/model";
import {
  CODE_CONNECTOR_REPOSITORY,
  CODE_SCAN_REPOSITORY,
  GITHUB_SOURCE,
  type CodeConnectorRepositoryPort,
  type CodeScanRepositoryPort,
  type GithubSourcePort,
} from "../../domain/ports";
import { assembleScan, type ProjectEndpoint } from "../assemble-scan";

export class ScanFromGithubCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
  ) {}
}
export class ScanFromUploadCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly files: SourceInput[],
    readonly prefix: string,
    readonly actorId: string,
  ) {}
}

/** Gathers the project data both scan paths diff against — one place, so github and upload cannot
 * drift on what «the project has» means. */
async function projectData(
  endpoints: EndpointRepositoryPort,
  roles: RoleRepositoryPort,
  workflows: WorkflowRepositoryPort,
  projectId: string,
): Promise<{
  endpoints: ProjectEndpoint[];
  roleNames: string[];
  permissionCountByEndpoint: Map<string, number>;
  flowCountByOperation: Map<string, number>;
}> {
  const [allEndpoints, allRoles, permissions, templates, flows] = await Promise.all([
    endpoints.listAll(projectId),
    roles.list(projectId),
    roles.listPermissions(projectId),
    workflows.listTemplates(projectId),
    workflows.listWorkflows(projectId),
  ]);

  const permissionCountByEndpoint = new Map<string, number>();
  for (const permission of permissions)
    permissionCountByEndpoint.set(
      permission.endpointId,
      (permissionCountByEndpoint.get(permission.endpointId) ?? 0) + 1,
    );

  const operationByTemplate = new Map(templates.map((template) => [template.id, template.operationId]));
  const flowCountByOperation = new Map<string, number>();
  for (const flow of flows) {
    const operations = new Set<string>();
    for (const step of flow.definition.steps) {
      const operationId = operationByTemplate.get(step.requestTemplateId);
      if (operationId) operations.add(operationId);
    }
    for (const operationId of operations)
      flowCountByOperation.set(operationId, (flowCountByOperation.get(operationId) ?? 0) + 1);
  }

  return {
    endpoints: allEndpoints.map((endpoint) => ({
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      requiresAuth: endpoint.requiresAuth,
      operationId: endpoint.operationId,
    })),
    roleNames: allRoles.map((role) => role.name),
    permissionCountByEndpoint,
    flowCountByOperation,
  };
}

@CommandHandler(ScanFromGithubCommand)
export class ScanFromGithubHandler implements ICommandHandler<ScanFromGithubCommand, { scanId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_CONNECTOR_REPOSITORY) private readonly connectors: CodeConnectorRepositoryPort,
    @Inject(CODE_SCAN_REPOSITORY) private readonly scans: CodeScanRepositoryPort,
    @Inject(GITHUB_SOURCE) private readonly github: GithubSourcePort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ScanFromGithubCommand): Promise<{ scanId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const connector = await this.connectors.find(command.projectId);
    if (!connector) throw new NotFoundError("No hay repositorio conectado", "connector-not-found");

    const now = this.clock.now();
    const scanId = randomUUID();
    const token = connector.tokenCiphertext ? this.cipher.decrypt(connector.tokenCiphertext) : null;
    const data = await projectData(this.endpoints, this.roles, this.workflows, command.projectId);

    try {
      const { sources, ref } = await this.github.fetchControllers({
        repo: connector.repo,
        branch: connector.branch,
        basePath: connector.basePath,
        token,
      });
      const { result, diff, impact } = assembleScan({ ...data, sources, prefix: connector.prefix });
      const scan: CodeScan = {
        id: scanId,
        projectId: command.projectId,
        source: "github",
        ref,
        status: "ok",
        result,
        diff,
        impact,
        error: null,
        createdAt: now,
        createdBy: command.actorId,
      };
      await this.scans.save(scan);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.scans.save({
        id: scanId,
        projectId: command.projectId,
        source: "github",
        ref: connector.branch,
        status: "error",
        result: { endpoints: [], files: 0, controllers: 0 },
        diff: { added: [], removed: [], changed: [], unchanged: 0 },
        impact: { unknownRoles: [], removedWithPermissions: [], removedWithFlows: [] },
        error: messageText,
        createdAt: now,
        createdBy: command.actorId,
      });
    }
    return { scanId };
  }
}

@CommandHandler(ScanFromUploadCommand)
export class ScanFromUploadHandler implements ICommandHandler<ScanFromUploadCommand, { scanId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_SCAN_REPOSITORY) private readonly scans: CodeScanRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ScanFromUploadCommand): Promise<{ scanId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    if (!command.files.length)
      throw new InvalidInputError(
        "No hay ficheros que analizar",
        [{ field: "files", detail: "Sube al menos un fichero" }],
        "scan-empty",
      );

    const data = await projectData(this.endpoints, this.roles, this.workflows, command.projectId);
    const { result, diff, impact } = assembleScan({ ...data, sources: command.files, prefix: command.prefix });
    const now = this.clock.now();
    const scanId = randomUUID();
    await this.scans.save({
      id: scanId,
      projectId: command.projectId,
      source: "upload",
      ref: "upload",
      status: "ok",
      result,
      diff,
      impact,
      error: null,
      createdAt: now,
      createdBy: command.actorId,
    });
    return { scanId };
  }
}
