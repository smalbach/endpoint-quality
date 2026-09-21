import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import type { DataScope, Role, RoleAccess, RoleRule } from "../../domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "../../domain/ports";
import { ownedRole } from "../commands/manage-roles";

export type RoleView = Role & { allowed: number; denied: number };

export class ListRolesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Qué lista se pide: los roles en uso, los archivados o los eliminados. */
    readonly state: LifecycleState = "active",
  ) {}
}

@QueryHandler(ListRolesQuery)
export class ListRolesHandler implements IQueryHandler<ListRolesQuery, RoleView[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  async execute(query: ListRolesQuery): Promise<RoleView[]> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const [roles, permissions] = await Promise.all([
      this.roles.list(project.id, query.state),
      this.roles.listPermissions(project.id),
    ]);
    return roles.map((role) => ({
      ...role,
      allowed: permissions.filter((cell) => cell.roleId === role.id && cell.access === "allow").length,
      denied: permissions.filter((cell) => cell.roleId === role.id && cell.access === "deny").length,
    }));
  }
}

export class GetRolePermissionsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly roleId: string,
  ) {}
}

@QueryHandler(GetRolePermissionsQuery)
export class GetRolePermissionsHandler implements IQueryHandler<GetRolePermissionsQuery> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  /** Only the decided cells. Everything absent is undecided, which the screen draws as such. */
  async execute(query: GetRolePermissionsQuery) {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const role = await ownedRole(this.roles, project.id, query.roleId);
    const permissions = await this.roles.listPermissions(project.id, { roleId: role.id });
    return {
      permissions: permissions.map(({ endpointId, access, dataScope }) => ({ endpointId, access, dataScope })),
    };
  }
}

export class GetEndpointRoleAccessQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly endpointId: string,
  ) {}
}

export type EndpointRoleAccessView = {
  roleId: string;
  name: string;
  color: string;
  access: RoleAccess;
  dataScope: DataScope;
};

@QueryHandler(GetEndpointRoleAccessQuery)
export class GetEndpointRoleAccessHandler implements IQueryHandler<GetEndpointRoleAccessQuery> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
  ) {}

  async execute(query: GetEndpointRoleAccessQuery): Promise<{ roles: EndpointRoleAccessView[] }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const endpoint = await this.endpoints.findById(project.id, query.endpointId);
    if (!endpoint) throw new NotFoundError("El endpoint no existe", "endpoint-not-found");
    const [roles, permissions] = await Promise.all([
      this.roles.list(project.id),
      this.roles.listPermissions(project.id, { endpointId: endpoint.id }),
    ]);
    return {
      roles: roles.map((role) => {
        const cell = permissions.find((permission) => permission.roleId === role.id);
        return {
          roleId: role.id,
          name: role.name,
          color: role.color,
          access: cell?.access ?? "undecided",
          dataScope: cell?.dataScope ?? "all",
        };
      }),
    };
  }
}

export class ListRoleRulesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

@QueryHandler(ListRoleRulesQuery)
export class ListRoleRulesHandler implements IQueryHandler<ListRoleRulesQuery> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
  ) {}

  /**
   * Solo las reglas **entre roles vivos**.
   *
   * Las filas de un rol archivado o eliminado se quedan en la tabla —es lo que hace que restaurarlo
   * devuelva la matriz como estaba—, pero enseñarlas aquí sería una decisión sobre alguien que ya
   * no sale en ninguna lista, y la pantalla no tendría dónde dibujarla.
   */
  async execute(query: ListRoleRulesQuery): Promise<{ rules: Omit<RoleRule, "projectId">[] }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const [rules, live] = await Promise.all([this.roles.listRules(project.id), this.roles.list(project.id)]);
    const alive = new Set(live.map((role) => role.id));
    return {
      rules: rules
        .filter((rule) => alive.has(rule.sourceRoleId) && alive.has(rule.targetRoleId))
        .map(({ projectId: _project, ...rule }) => rule),
    };
  }
}
