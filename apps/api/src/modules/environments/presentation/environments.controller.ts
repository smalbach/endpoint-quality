/**
 * Environments, their credentials, the project's configuration and the matrix it produces.
 *
 * **Credentials are `admin`, everything else is `editor`.** That line is where the role ladder
 * earns its keep: an editor curates the test matrix all day, and the two things that can damage
 * something outside this system — a stored credential for somebody's staging environment, and
 * the switch that lets a run write to a target — sit one rung above.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { OrderMode } from "@eq/runner-core";

import { CurrentUser, OrgRoleGuard, RequireRole, type Principal } from "@/modules/auth/infrastructure/guards/auth.guard";
import { CreateEnvironmentCommand, DeleteEnvironmentCommand, UpdateEnvironmentCommand } from "../application/commands/manage-environment";
import { DeleteCredentialCommand, UpsertCredentialCommand } from "../application/commands/manage-credential";
import { ListEnvironmentsQuery } from "../application/queries/list-environments";
import { UpsertConfigSectionCommand, ResetConfigSectionCommand } from "@/modules/config/application/commands/upsert-config-section";
import { GetProjectConfigQuery } from "@/modules/config/application/queries/get-project-config";
import { GetScenariosQuery } from "@/modules/config/application/queries/get-scenarios";
import { GetCoverageQuery } from "@/modules/config/application/queries/get-coverage";
import { CredentialDto, EnvironmentDto } from "./dto/environments.dto";
import type { CredentialRole } from "../domain/model";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId")
@UseGuards(OrgRoleGuard)
export class EnvironmentsController {
  constructor(private readonly commandBus: CommandBus, private readonly queryBus: QueryBus) {}

  @Get("environments")
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListEnvironmentsQuery(organizationId, projectId));
  }

  @Post("environments")
  @RequireRole("editor")
  async create(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string, @Body() body: EnvironmentDto) {
    return this.commandBus.execute(new CreateEnvironmentCommand(organizationId, projectId, body));
  }

  @Patch("environments/:environmentId")
  @RequireRole("editor")
  @HttpCode(204)
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Body() body: EnvironmentDto,
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
    await this.commandBus.execute(new DeleteCredentialCommand(organizationId, projectId, environmentId, role as CredentialRole));
  }

  @Get("config")
  @RequireRole("viewer")
  async config(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetProjectConfigQuery(organizationId, projectId));
  }

  @Put("config/:section")
  @RequireRole("editor")
  @HttpCode(204)
  async putConfig(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("section") section: string,
    @Body() body: unknown,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(new UpsertConfigSectionCommand(organizationId, projectId, section, body, actorId(principal)));
  }

  /** Removes the section so the project falls back to the engine's defaults. Writing the
   * defaults into it instead would look like somebody chose them. */
  @Delete("config/:section")
  @RequireRole("editor")
  @HttpCode(204)
  async resetConfig(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("section") section: string,
  ): Promise<void> {
    await this.commandBus.execute(new ResetConfigSectionCommand(organizationId, projectId, section));
  }

  /**
   * What the matrix reaches of what the contract declares, and what it misses.
   *
   * No environment: coverage is a property of the contract and the configuration. A read-only
   * target blocks the write cases it would run, and calling those uncovered would report "the
   * contract is untested" when what happened is that somebody picked a safe target.
   */
  @Get("coverage")
  @RequireRole("viewer")
  async coverage(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetCoverageQuery(organizationId, projectId));
  }

  @Get("scenarios")
  @RequireRole("viewer")
  async scenarios(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("environmentId") environmentId?: string,
    @Query("order") order?: string,
  ) {
    const mode: OrderMode = order === "contract" || order === "custom" ? order : "safe";
    return this.queryBus.execute(new GetScenariosQuery(organizationId, projectId, environmentId, mode));
  }
}
