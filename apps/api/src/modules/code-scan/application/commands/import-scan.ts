import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import {
  ENDPOINT_METHODS,
  blankEndpoint,
  endpointKey,
  reconcilePathParameters,
  type EndpointMethod,
} from "@/modules/endpoints/domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import { ROLE_COLORS } from "@/modules/roles/domain/model";
import { CODE_SCAN_REPOSITORY, type CodeScanRepositoryPort } from "../../domain/ports";

export class ImportScanCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly scanId: string,
    readonly options: { createRoles: boolean },
    readonly actorId: string,
  ) {}
}

export type ImportScanResult = { created: number; updated: number; rolesCreated: number };

const isMethod = (method: string): method is EndpointMethod => (ENDPOINT_METHODS as readonly string[]).includes(method);

/**
 * Applies a scan's diff: the routes the code added become endpoints, the ones whose auth changed are
 * updated, and — when asked — the roles the code names that the project lacks are created.
 *
 * Re-checked against the project as it is *now*, not as it was when the scan ran: a route already
 * created since is skipped rather than duplicated, and a `@All` route (no single HTTP method) is left
 * out because an endpoint is one method. Nothing is removed — deleting an endpoint a flow or a
 * permission still points at is a decision the impact panel surfaces and a person makes, not an
 * import.
 */
@CommandHandler(ImportScanCommand)
export class ImportScanHandler implements ICommandHandler<ImportScanCommand, ImportScanResult> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_SCAN_REPOSITORY) private readonly scans: CodeScanRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportScanCommand): Promise<ImportScanResult> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const scan = await this.scans.find(command.projectId, command.scanId);
    if (!scan) throw new NotFoundError("El escaneo no existe", "scan-not-found");
    if (scan.status !== "ok") throw new ConflictError("El escaneo no terminó bien", "scan-not-ok");

    const now = this.clock.now();
    const current = await this.endpoints.listAll(command.projectId);
    const existingKeys = new Set(current.map((endpoint) => endpointKey(endpoint.method, endpoint.path)));

    let orderIndex = await this.endpoints.nextOrderIndex(command.projectId);
    const toCreate = scan.diff.added
      .filter((endpoint) => isMethod(endpoint.method) && !existingKeys.has(endpointKey(endpoint.method, endpoint.path)))
      .map((endpoint) => {
        const base = blankEndpoint({
          id: randomUUID(),
          projectId: command.projectId,
          origin: "import",
          orderIndex: orderIndex++,
          now,
          actorId: command.actorId,
        });
        return {
          ...base,
          method: endpoint.method as EndpointMethod,
          path: endpoint.path,
          pathParameters: reconcilePathParameters(endpoint.path, []),
          requiresAuth: endpoint.requiresAuth,
          description: `Importado del código (${endpoint.controller}.${endpoint.handler})`,
        };
      });
    if (toCreate.length) await this.endpoints.saveMany(toCreate);

    let updated = 0;
    for (const change of scan.diff.changed) {
      const endpoint = await this.endpoints.findById(command.projectId, change.id);
      if (!endpoint) continue;
      const scanned = scan.result.endpoints.find(
        (item) => item.method === endpoint.method && item.path === endpoint.path,
      );
      if (!scanned || scanned.requiresAuth === endpoint.requiresAuth) continue;
      await this.endpoints.save({
        ...endpoint,
        requiresAuth: scanned.requiresAuth,
        updatedAt: now,
        updatedBy: command.actorId,
      });
      updated += 1;
    }

    let rolesCreated = 0;
    if (command.options.createRoles && scan.impact.unknownRoles.length) {
      const roles = await this.roles.list(command.projectId);
      const taken = new Set(roles.map((role) => role.name.toLowerCase()));
      let position = roles.reduce((max, role) => Math.max(max, role.position), -1) + 1;
      for (const name of scan.impact.unknownRoles) {
        if (taken.has(name.toLowerCase())) continue;
        await this.roles.save({
          id: randomUUID(),
          projectId: command.projectId,
          name,
          description: "Creado desde un escaneo del código",
          color: ROLE_COLORS[position % ROLE_COLORS.length],
          sameRoleDataIsolation: false,
          position: position++,
          createdAt: now,
          updatedAt: now,
        });
        rolesCreated += 1;
      }
    }

    return { created: toCreate.length, updated, rolesCreated };
  }
}
