/**
 * Roles, their permission per endpoint, and the rules between them.
 *
 * `viewer` reads, `editor` writes, and deleting a role is `admin`: it takes the credentials stored
 * for it in every environment with it, and storing or removing credentials is an admin's call.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import { CreateRoleCommand, DeleteRoleCommand, UpdateRoleCommand } from "../application/commands/manage-roles";
import {
  ReplaceRoleRulesCommand,
  SetEndpointRoleAccessCommand,
  SetRolePermissionsCommand,
} from "../application/commands/permissions";
import {
  GetEndpointRoleAccessQuery,
  GetRolePermissionsQuery,
  ListRoleRulesQuery,
  ListRolesQuery,
} from "../application/queries/list-roles";
import {
  CreateRoleDto,
  ReplaceRoleRulesDto,
  SetEndpointRoleAccessDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from "./dto/roles.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId")
@UseGuards(OrgRoleGuard)
export class RolesController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get("roles")
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListRolesQuery(organizationId, projectId));
  }

  @Post("roles")
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateRoleDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CreateRoleCommand(organizationId, projectId, body, actorId(principal)));
  }

  @Get("role-rules")
  @RequireRole("viewer")
  async rules(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListRoleRulesQuery(organizationId, projectId));
  }

  @Put("role-rules")
  @RequireRole("editor")
  async replaceRules(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ReplaceRoleRulesDto,
  ) {
    return this.commandBus.execute(new ReplaceRoleRulesCommand(organizationId, projectId, body.rules));
  }

  @Patch("roles/:roleId")
  @RequireRole("editor")
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("roleId") roleId: string,
    @Body() body: UpdateRoleDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new UpdateRoleCommand(organizationId, projectId, roleId, body, actorId(principal)));
  }

  @Delete("roles/:roleId")
  @RequireRole("admin")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("roleId") roleId: string,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteRoleCommand(organizationId, projectId, roleId, actorId(principal)));
  }

  @Get("roles/:roleId/permissions")
  @RequireRole("viewer")
  async permissions(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("roleId") roleId: string,
  ) {
    return this.queryBus.execute(new GetRolePermissionsQuery(organizationId, projectId, roleId));
  }

  @Put("roles/:roleId/permissions")
  @RequireRole("editor")
  async setPermissions(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("roleId") roleId: string,
    @Body() body: SetRolePermissionsDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new SetRolePermissionsCommand(organizationId, projectId, roleId, body.permissions, actorId(principal)),
    );
  }

  @Get("endpoints/:endpointId/role-access")
  @RequireRole("viewer")
  async endpointAccess(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("endpointId") endpointId: string,
  ) {
    return this.queryBus.execute(new GetEndpointRoleAccessQuery(organizationId, projectId, endpointId));
  }

  @Put("endpoints/:endpointId/role-access")
  @RequireRole("editor")
  async setEndpointAccess(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("endpointId") endpointId: string,
    @Body() body: SetEndpointRoleAccessDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new SetEndpointRoleAccessCommand(organizationId, projectId, endpointId, body.permissions, actorId(principal)),
    );
  }
}
