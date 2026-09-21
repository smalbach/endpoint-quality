/**
 * Environments and the credentials the runner presents to them.
 *
 * **Credentials are `admin`, everything else is `editor`.** That line is where the role ladder
 * earns its keep: an editor curates the test matrix all day, and the two things that can damage
 * something outside this system — a stored credential for somebody's staging environment, and
 * the switch that lets a run write to a target — sit one rung above.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
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
  SetEnvironmentArchivedCommand,
  RestoreEnvironmentCommand,
} from "../application/commands/manage-environment";
import { DeleteCredentialCommand, UpsertCredentialCommand } from "../application/commands/manage-credential";
import { ActivateEnvironmentCommand } from "../application/commands/active-environment";
import { ImportPostmanEnvironmentCommand } from "../application/commands/import-postman-environment";
import { ClearSessionTokenCommand, GetSessionTokenQuery } from "../application/commands/session-token";
import { DeleteCookiesCommand, ListCookiesQuery, SetCookieCommand } from "../application/commands/cookies";
import { ListEnvironmentsQuery } from "../application/queries/list-environments";
import { parseLifecycleState } from "@/shared/lifecycle/lifecycle";
import { SetArchivedDto } from "@/shared/lifecycle/lifecycle.dto";
import { RevealVariablesQuery } from "../application/queries/reveal-variables";
import {
  CreateEnvironmentDto,
  CredentialDto,
  ImportPostmanEnvironmentDto,
  SetCookieDto,
  UpdateEnvironmentDto,
} from "./dto/environments.dto";
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
  async list(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("state") state?: string,
  ) {
    return this.queryBus.execute(new ListEnvironmentsQuery(organizationId, projectId, parseLifecycleState(state)));
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

  /**
   * A Postman environment file, as an environment of this project — created, or updated when one of
   * that name is already here.
   *
   * `editor`, like creating one by hand. A secret in the file is encrypted on arrival and never
   * comes back out, and a variable this project already holds a value for is not blanked by a file
   * that ships its secrets empty.
   */
  @Post("environments/import/postman")
  @RequireRole("editor")
  async importPostman(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportPostmanEnvironmentDto,
  ) {
    return this.commandBus.execute(new ImportPostmanEnvironmentCommand(organizationId, projectId, body));
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

  /**
   * El tarro de cookies de quien pregunta.
   *
   * `reveal=true` para ver los valores. Por defecto salen con la máscara: una cookie de sesión es
   * una credencial, y una lista que la enseña de serie la deja en cualquier captura de pantalla.
   */
  @Get("cookies")
  @RequireRole("viewer")
  async cookies(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
    @Query("reveal") reveal?: string,
  ) {
    return this.queryBus.execute(new ListCookiesQuery(organizationId, projectId, actorId(principal), reveal === "true"));
  }

  /** Una cookie a mano, en el formato en el que la manda un servidor: se copia y se pega. */
  @Post("cookies")
  @RequireRole("editor")
  async setCookie(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
    @Body() body: SetCookieDto,
  ) {
    return this.commandBus.execute(
      new SetCookieCommand(organizationId, projectId, actorId(principal), body.url, body.setCookie),
    );
  }

  /** Vaciar el tarro, que es «ciérrame la sesión» y para lo que se usa la pantalla. */
  @Delete("cookies")
  @RequireRole("viewer")
  @HttpCode(204)
  async clearCookies(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
    @Query("domain") domain?: string,
    @Query("path") path?: string,
    @Query("name") name?: string,
  ): Promise<void> {
    // Los tres o ninguno: con dos de los tres no se identifica una cookie, y borrar «la que más se
    // parezca» es borrar la de otra ruta.
    const key = domain && path && name ? { domain, path, name } : null;
    await this.commandBus.execute(new DeleteCookiesCommand(organizationId, projectId, actorId(principal), key));
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

  /**
   * Fuera del selector, y deja de poder ejecutarse. `admin` como borrar: lo que guarda dentro son
   * las credenciales del entorno, y sacarlas de circulación no es una edición cualquiera.
   */
  @Patch("environments/:environmentId/archived")
  @RequireRole("admin")
  @HttpCode(204)
  async setArchived(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Body() body: SetArchivedDto,
  ): Promise<void> {
    await this.commandBus.execute(
      new SetEnvironmentArchivedCommand(organizationId, projectId, environmentId, body.archived),
    );
  }

  /** Devuelve un entorno eliminado, con sus variables y sus credenciales. */
  @Post("environments/:environmentId/restore")
  @RequireRole("admin")
  @HttpCode(204)
  async restore(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
  ): Promise<void> {
    await this.commandBus.execute(new RestoreEnvironmentCommand(organizationId, projectId, environmentId));
  }

  /** Borrado blando. `?purge=true` es el definitivo, y se lleva las credenciales por cascada. */
  @Delete("environments/:environmentId")
  @RequireRole("admin")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("environmentId") environmentId: string,
    @Query("purge") purge?: string,
  ): Promise<void> {
    await this.commandBus.execute(
      new DeleteEnvironmentCommand(organizationId, projectId, environmentId, purge === "true"),
    );
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
