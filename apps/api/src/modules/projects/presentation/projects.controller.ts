/**
 * Projects and their contracts, over HTTP.
 *
 * Every route is nested under `/orgs/:organizationId/` so the tenant boundary is enforced by the
 * same guard as everywhere else, on a value that is in the URL rather than inferred from the
 * body. A project id in the path is then checked a second time, in the handler, against that
 * organization — belt and braces, because the guard proves you belong to the *organization* and
 * only the handler can prove the *project* belongs to it too.
 *
 * The role split follows the plan: `viewer` reads, `editor` creates projects and imports
 * contracts, `admin` archives. Importing is `editor` because it is the ordinary daily act of
 * keeping the matrix current; archiving is `admin` because it takes a project out of everyone's
 * list.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import { InvalidInputError, UnauthenticatedError } from "@/shared/errors/domain-error";
import { CurrentUser, OrgRoleGuard, RequireRole, type Principal } from "@/modules/auth/infrastructure/guards/auth.guard";
import { CreateProjectCommand } from "../application/commands/create-project";
import { SetProjectArchivedCommand, UpdateProjectCommand } from "../application/commands/update-project";
import { GetProjectQuery, ListProjectsQuery } from "../application/queries/list-projects";
import { ImportSpecVersionCommand, type SpecSourceInput } from "@/modules/specs/application/commands/import-spec-version";
import { ActivateSpecVersionCommand } from "@/modules/specs/application/commands/activate-spec-version";
import { CheckSpecDriftCommand } from "@/modules/specs/application/commands/check-spec-drift";
import { GetOperationsQuery, ListSpecVersionsQuery } from "@/modules/specs/application/queries/get-operations";
import { ArchiveProjectDto, CreateProjectDto, ImportSpecDto, SpecSourceDto, UpdateProjectDto } from "./dto/projects.dto";

/** The acting identity. A CI token is a legitimate importer — that is how a pipeline keeps the
 * contract fresh — so unlike member management this does not demand a human session. */
function actorId(principal: Principal): string {
  return principal.kind === "user" ? principal.userId : principal.tokenId;
}

/**
 * Turns the request body into the command's input, and rejects the combinations the DTO cannot
 * express on its own — `kind: "url"` with no `url` is valid against every field rule and
 * meaningless as a whole.
 */
/** Undefined when the caller did not say where to read from: the handler falls back to the
 * source the project already has. */
function toSource(dto: SpecSourceDto | undefined): SpecSourceInput | undefined {
  if (!dto) return undefined;
  if (dto.kind === "url") {
    if (!dto.url) throw new InvalidInputError("Falta la URL del contrato", [{ field: "source.url", detail: "Requerida cuando kind es url" }]);
    return { kind: "url", url: dto.url, ...(dto.headers ? { headers: dto.headers } : {}) };
  }
  if (!dto.raw) throw new InvalidInputError("Falta el contenido del contrato", [{ field: "source.raw", detail: `Requerido cuando kind es ${dto.kind}` }]);
  return dto.kind === "upload" ? { kind: "upload", filename: dto.filename ?? "openapi", raw: dto.raw } : { kind: "inline", raw: dto.raw };
}

@Controller("orgs/:organizationId/projects")
@UseGuards(OrgRoleGuard)
export class ProjectsController {
  constructor(private readonly commandBus: CommandBus, private readonly queryBus: QueryBus) {}

  @Get()
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Query("includeArchived") includeArchived?: string) {
    return this.queryBus.execute(new ListProjectsQuery(organizationId, includeArchived === "true"));
  }

  @Post()
  @RequireRole("editor")
  async create(@Param("organizationId") organizationId: string, @Body() body: CreateProjectDto, @CurrentUser() principal: Principal) {
    return this.commandBus.execute(new CreateProjectCommand(organizationId, body.name, body.description ?? "", actorId(principal)));
  }

  @Get(":projectId")
  @RequireRole("viewer")
  async get(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetProjectQuery(organizationId, projectId));
  }

  @Patch(":projectId")
  @RequireRole("editor")
  @HttpCode(204)
  async update(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string, @Body() body: UpdateProjectDto): Promise<void> {
    await this.commandBus.execute(new UpdateProjectCommand(organizationId, projectId, body));
  }

  // Archiving takes a project out of everybody's list, so it sits a rung above editing it.
  @Patch(":projectId/archived")
  @RequireRole("admin")
  @HttpCode(204)
  async setArchived(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string, @Body() body: ArchiveProjectDto): Promise<void> {
    await this.commandBus.execute(new SetProjectArchivedCommand(organizationId, projectId, body.archived));
  }

  @Post(":projectId/spec-versions")
  @RequireRole("editor")
  async importSpec(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportSpecDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportSpecVersionCommand(organizationId, projectId, toSource(body.source), actorId(principal), body.activate ?? true),
    );
  }

  @Get(":projectId/spec-versions")
  @RequireRole("viewer")
  async listVersions(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListSpecVersionsQuery(organizationId, projectId));
  }

  @Post(":projectId/spec-versions/:specVersionId/activate")
  @RequireRole("editor")
  @HttpCode(204)
  async activate(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("specVersionId") specVersionId: string,
  ): Promise<void> {
    await this.commandBus.execute(new ActivateSpecVersionCommand(organizationId, projectId, specVersionId));
  }

  /**
   * Fetches the contract again and reports what moved, without changing what runs use.
   *
   * POST rather than GET because it makes a request to a third party and writes a version row.
   * A GET that does either is a GET somebody's proxy or crawler will eventually repeat.
   */
  @Post(":projectId/spec-drift-check")
  @HttpCode(200)
  @RequireRole("editor")
  async driftCheck(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportSpecDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CheckSpecDriftCommand(organizationId, projectId, toSource(body.source), actorId(principal)));
  }

  @Get(":projectId/operations")
  @RequireRole("viewer")
  async operations(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("specVersionId") specVersionId?: string,
  ) {
    return this.queryBus.execute(new GetOperationsQuery(organizationId, projectId, specVersionId));
  }
}

export { UnauthenticatedError };
