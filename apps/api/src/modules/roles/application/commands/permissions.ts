import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import {
  DATA_SCOPES,
  ROLE_ACCESS,
  type DataScope,
  type PermissionChange,
  type RoleAccess,
  type RoleRule,
} from "../../domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "../../domain/ports";
import { syncAccessSection } from "../sync-access";
import { ownedRole } from "./manage-roles";

type Problem = { field: string; detail: string };
type Cell = { access: RoleAccess; dataScope?: DataScope };

function cellProblems(cell: Cell, field: string): Problem[] {
  const problems: Problem[] = [];
  if (!(ROLE_ACCESS as readonly string[]).includes(cell.access))
    problems.push({ field: `${field}.access`, detail: "allow, deny o undecided" });
  if (cell.dataScope !== undefined && !(DATA_SCOPES as readonly string[]).includes(cell.dataScope))
    problems.push({ field: `${field}.dataScope`, detail: "all, own o none" });
  return problems;
}

function assertNoProblems(problems: Problem[]) {
  if (problems.length) throw new InvalidInputError("Los permisos no son válidos", problems);
}

export class SetRolePermissionsCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly roleId: string,
    readonly permissions: (Cell & { endpointId: string })[],
    readonly actorId: string,
  ) {}
}

/**
 * One role's permissions over the endpoints it lists — and only those.
 *
 * The analyzer replaced every row of the role with what the screen sent, and the screen had only
 * loaded the active endpoints: saving erased the permissions of every archived one. This is a
 * patch: a cell not in the request keeps what it had.
 */
@CommandHandler(SetRolePermissionsCommand)
export class SetRolePermissionsHandler implements ICommandHandler<SetRolePermissionsCommand, { updated: number }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetRolePermissionsCommand) {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const role = await ownedRole(this.roles, project.id, command.roleId);
    const known = new Set((await this.endpoints.listAll(project.id)).map((endpoint) => endpoint.id));
    const seen = new Set<string>();
    const problems: Problem[] = [];
    command.permissions.forEach((cell, index) => {
      const field = `permissions.${index}`;
      problems.push(...cellProblems(cell, field));
      if (!known.has(cell.endpointId))
        problems.push({ field: `${field}.endpointId`, detail: "No es un endpoint de este proyecto" });
      else if (seen.has(cell.endpointId))
        problems.push({ field: `${field}.endpointId`, detail: "Repetido en la petición" });
      seen.add(cell.endpointId);
    });
    assertNoProblems(problems);

    const changes: PermissionChange[] = command.permissions.map((cell) => ({
      roleId: role.id,
      endpointId: cell.endpointId,
      access: cell.access,
      dataScope: cell.dataScope ?? "all",
    }));
    await this.roles.applyPermissions(changes);
    await syncAccessSection(
      { roles: this.roles, endpoints: this.endpoints, config: this.config, clock: this.clock },
      project.id,
      command.actorId,
    );
    return { updated: changes.length };
  }
}

export class SetEndpointRoleAccessCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointId: string,
    readonly permissions: (Cell & { roleId: string })[],
    readonly actorId: string,
  ) {}
}

/** The same cells seen from one endpoint: every role's access to it, from the endpoint editor. */
@CommandHandler(SetEndpointRoleAccessCommand)
export class SetEndpointRoleAccessHandler implements ICommandHandler<
  SetEndpointRoleAccessCommand,
  { updated: number }
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetEndpointRoleAccessCommand) {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const endpoint = await this.endpoints.findById(project.id, command.endpointId);
    if (!endpoint) throw new NotFoundError("El endpoint no existe", "endpoint-not-found");
    const known = new Set((await this.roles.list(project.id)).map((role) => role.id));
    const seen = new Set<string>();
    const problems: Problem[] = [];
    command.permissions.forEach((cell, index) => {
      const field = `permissions.${index}`;
      problems.push(...cellProblems(cell, field));
      if (!known.has(cell.roleId)) problems.push({ field: `${field}.roleId`, detail: "No es un rol de este proyecto" });
      else if (seen.has(cell.roleId)) problems.push({ field: `${field}.roleId`, detail: "Repetido en la petición" });
      seen.add(cell.roleId);
    });
    assertNoProblems(problems);

    await this.roles.applyPermissions(
      command.permissions.map((cell) => ({
        roleId: cell.roleId,
        endpointId: endpoint.id,
        access: cell.access,
        dataScope: cell.dataScope ?? "all",
      })),
    );
    await syncAccessSection(
      { roles: this.roles, endpoints: this.endpoints, config: this.config, clock: this.clock },
      project.id,
      command.actorId,
    );
    return { updated: command.permissions.length };
  }
}

export class ReplaceRoleRulesCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly rules: Omit<RoleRule, "projectId">[],
  ) {}
}

/**
 * The R/W/D matrix, whole: it is one grid on one screen, and saved as one.
 *
 * A cell with all three off is not stored — «no puede nada» is what no row already says — and a
 * role over itself is refused: that question is the role's own isolation switch.
 */
@CommandHandler(ReplaceRoleRulesCommand)
export class ReplaceRoleRulesHandler implements ICommandHandler<ReplaceRoleRulesCommand, { stored: number }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  async execute(command: ReplaceRoleRulesCommand) {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const known = new Set((await this.roles.list(project.id)).map((role) => role.id));
    const seen = new Set<string>();
    const problems: Problem[] = [];
    command.rules.forEach((rule, index) => {
      const field = `rules.${index}`;
      if (!known.has(rule.sourceRoleId))
        problems.push({ field: `${field}.sourceRoleId`, detail: "No es un rol de este proyecto" });
      if (!known.has(rule.targetRoleId))
        problems.push({ field: `${field}.targetRoleId`, detail: "No es un rol de este proyecto" });
      if (rule.sourceRoleId === rule.targetRoleId)
        problems.push({
          field: `${field}.targetRoleId`,
          detail: "Un rol sobre sí mismo es su aislamiento, no una regla",
        });
      const key = `${rule.sourceRoleId}:${rule.targetRoleId}`;
      if (seen.has(key)) problems.push({ field, detail: "Par de roles repetido" });
      seen.add(key);
    });
    if (problems.length) throw new InvalidInputError("Las reglas entre roles no son válidas", problems);

    const stored = command.rules
      .filter((rule) => rule.canRead || rule.canWrite || rule.canDelete)
      .map((rule) => ({ ...rule, projectId: project.id }));
    await this.roles.replaceRules(project.id, stored);
    return { stored: stored.length };
  }
}
