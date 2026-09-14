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

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateEnvironmentCommand,
  DeleteEnvironmentCommand,
  UpdateEnvironmentCommand,
} from "../application/commands/manage-environment";
import { DeleteCredentialCommand, UpsertCredentialCommand } from "../application/commands/manage-credential";
import { ActivateEnvironmentCommand } from "../application/commands/active-environment";
import { ClearSessionTokenCommand, GetSessionTokenQuery } from "../application/commands/session-token";
import { ListEnvironmentsQuery } from "../application/queries/list-environments";
import { RevealVariablesQuery } from "../application/queries/reveal-variables";
import { CreateEnvironmentDto, CredentialDto, UpdateEnvironmentDto } from "./dto/environments.dto";
import type { CredentialRole } from "../domain/model";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

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

  /** The clear text of the sensitive variables, and nothing else. `admin`, like credentials: it
   * answers the same question, so it sits on the same rung. */
  @Get("environments/:environmentId/variables/reveal")
  @RequireRole("admin")
  async reveal(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
  ) {
    return this.queryBus.execute(new RevealVariablesQuery(organizationId, projectId, environmentId));
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

  /** Makes it the one every screen starts from. `editor`: it changes what everybody's «Enviar» uses. */
  @Post("environments/:environmentId/activate")
  @RequireRole("editor")
  @HttpCode(204)
  async activate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
  ): Promise<void> {
    await this.commandBus.execute(new ActivateEnvironmentCommand(organizationId, projectId, environmentId));
  }

  /** The caller's own captured token: who it says they are and when it runs out, never the token. */
  @Get("session-token")
  @RequireRole("viewer")
  async sessionToken(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
  ) {
    return this.queryBus.execute(new GetSessionTokenQuery(organizationId, projectId, actorId(principal)));
  }

  @Delete("session-token")
  @RequireRole("viewer")
  @HttpCode(204)
  async clearSessionToken(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(new ClearSessionTokenCommand(organizationId, projectId, actorId(principal)));
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
