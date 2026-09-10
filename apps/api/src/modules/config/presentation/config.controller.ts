/**
 * The project's configuration, and the matrix it produces.
 *
 * Same URLs as before — these routes used to live on `EnvironmentsController` because the query
 * that builds the matrix needs the contract, the configuration *and* the environment. That is
 * still true, and it is a fact about `GetScenariosQuery`, which has not moved: it reads
 * environments through their port. What was wrong was the controller, which is the one layer that
 * should read like the URL it serves.
 *
 * Everything here is `editor`. A configuration edit changes what is asserted, never what is
 * reached: it cannot store a credential and it cannot let a run write to a target, which are the
 * two acts this product reserves for `admin`.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { OrderMode } from "@eq/runner-core";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import { ResetConfigSectionCommand, UpsertConfigSectionCommand } from "../application/commands/upsert-config-section";
import { GetProjectConfigQuery } from "../application/queries/get-project-config";
import { GetScenariosQuery } from "../application/queries/get-scenarios";
import { GetCoverageQuery } from "../application/queries/get-coverage";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId")
@UseGuards(OrgRoleGuard)
export class ProjectConfigController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get("config")
  @RequireRole("viewer")
  async config(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetProjectConfigQuery(organizationId, projectId));
  }

  /**
   * The body is `unknown` on purpose: the section's real shape is a zod schema in the engine, and
   * a class-validator DTO on top of it would be a second, weaker statement of the same rule.
   */
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
    await this.commandBus.execute(
      new UpsertConfigSectionCommand(organizationId, projectId, section, body, actorId(principal)),
    );
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
