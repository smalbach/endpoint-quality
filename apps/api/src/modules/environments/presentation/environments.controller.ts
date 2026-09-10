/**
 * Environments and the credentials the runner presents to them.
 *
 * **Credentials are `admin`, everything else is `editor`.** That line is where the role ladder
 * earns its keep: an editor curates the test matrix all day, and the two things that can damage
 * something outside this system — a stored credential for somebody's staging environment, and
 * the switch that lets a run write to a target — sit one rung above.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import { OrgRoleGuard, RequireRole } from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateEnvironmentCommand,
  DeleteEnvironmentCommand,
  UpdateEnvironmentCommand,
} from "../application/commands/manage-environment";
import { DeleteCredentialCommand, UpsertCredentialCommand } from "../application/commands/manage-credential";
import { ListEnvironmentsQuery } from "../application/queries/list-environments";
import { CreateEnvironmentDto, CredentialDto, UpdateEnvironmentDto } from "./dto/environments.dto";
import type { CredentialRole } from "../domain/model";

@Controller("orgs/:organizationId/projects/:projectId")
@UseGuards(OrgRoleGuard)
export class EnvironmentsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get("environments")
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListEnvironmentsQuery(organizationId, projectId));
  }

  @Post("environments")
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateEnvironmentDto,
  ) {
    return this.commandBus.execute(new CreateEnvironmentCommand(organizationId, projectId, body));
  }

  @Patch("environments/:environmentId")
  @RequireRole("editor")
  @HttpCode(204)
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Body() body: UpdateEnvironmentDto,
  ): Promise<void> {
    await this.commandBus.execute(new UpdateEnvironmentCommand(organizationId, projectId, environmentId, body));
  }

  @Delete("environments/:environmentId")
  @RequireRole("admin")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteEnvironmentCommand(organizationId, projectId, environmentId));
  }

  // Storing somebody's staging token is one of the two acts in this product that can affect a
  // system outside it. An editor cannot do it.
  @Put("environments/:environmentId/credentials")
  @RequireRole("admin")
  async upsertCredential(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Body() body: CredentialDto,
  ) {
    return this.commandBus.execute(new UpsertCredentialCommand(organizationId, projectId, environmentId, body));
  }

  @Delete("environments/:environmentId/credentials/:role")
  @RequireRole("admin")
  @HttpCode(204)
  async deleteCredential(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Param("role") role: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new DeleteCredentialCommand(organizationId, projectId, environmentId, role as CredentialRole),
    );
  }
}
