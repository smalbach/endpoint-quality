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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { DeleteProjectCommand } from "../application/commands/delete-project";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import { InvalidInputError } from "@/shared/errors/domain-error";
import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";

import { CreateProjectCommand } from "../application/commands/create-project";
import { ForkProjectCommand } from "../application/commands/fork-project";
import { assertDirection, GetForkDiffQuery, SyncForkCommand } from "../application/commands/sync-fork";
import {
  assertReviewAction,
  CommentMergeRequestCommand,
  CreateMergeRequestCommand,
  GetMergeRequestQuery,
  ListMergeRequestsQuery,
  MergeMergeRequestCommand,
  ReviewMergeRequestCommand,
} from "../application/commands/merge-requests";
import { ImportElementsCommand } from "../application/commands/import-elements";
import { GetImportPreviewQuery } from "../application/queries/import-preview";
import { ExportProjectQuery } from "../application/queries/export-project";
import { ExportPostmanQuery } from "../application/queries/export-postman";
import { ImportProjectBundleCommand } from "../application/commands/import-project-bundle";
import { ImportAnythingCommand } from "../application/commands/import-anything";
import { SetProjectArchivedCommand, UpdateProjectCommand } from "../application/commands/update-project";
import { GetProjectQuery, ListProjectsQuery } from "../application/queries/list-projects";
import {
  ImportSpecVersionCommand,
  type SpecSourceInput,
} from "@/modules/specs/application/commands/import-spec-version";
import { ActivateSpecVersionCommand } from "@/modules/specs/application/commands/activate-spec-version";
import { CheckSpecDriftCommand } from "@/modules/specs/application/commands/check-spec-drift";
import { GetOperationsQuery, ListSpecVersionsQuery } from "@/modules/specs/application/queries/get-operations";
import {
  ForkProjectDto,
  SyncForkDto,
  CreateMergeRequestDto,
  MergeRequestCommentDto,
  MergeRequestReviewDto,
  ImportElementsDto,
  ImportProjectBundleDto,
  ImportAnythingDto,
  ArchiveProjectDto,
  CreateProjectDto,
  ImportSpecDto,
  SpecSourceDto,
  UpdateProjectDto,
} from "./dto/projects.dto";

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
    if (!dto.url)
      throw new InvalidInputError("Falta la URL del contrato", [
        { field: "source.url", detail: "Requerida cuando kind es url" },
      ]);
    return { kind: "url", url: dto.url, ...(dto.headers ? { headers: dto.headers } : {}) };
  }
  if (!dto.raw)
    throw new InvalidInputError("Falta el contenido del contrato", [
      { field: "source.raw", detail: `Requerido cuando kind es ${dto.kind}` },
    ]);
  return dto.kind === "upload"
    ? { kind: "upload", filename: dto.filename ?? "openapi", raw: dto.raw }
    : { kind: "inline", raw: dto.raw };
}

/** `?parts=flows,roles` as a list; absent or empty is none given. */
const listParam = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

@Controller("orgs/:organizationId/projects")
@UseGuards(OrgRoleGuard)
export class ProjectsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Query("includeArchived") includeArchived?: string) {
    return this.queryBus.execute(new ListProjectsQuery(organizationId, includeArchived === "true"));
  }

  @Post()
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Body() body: CreateProjectDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new CreateProjectCommand(organizationId, body.name, body.description ?? "", actorId(principal), {
        baseUrl: body.baseUrl,
        tags: body.tags,
        auth: body.auth,
      }),
    );
  }

  // Deleting is final for everybody in the organization, so it is the same rung as archiving.
  @Delete(":projectId")
  @RequireRole("admin")
  @HttpCode(204)
  async remove(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string): Promise<void> {
    await this.commandBus.execute(new DeleteProjectCommand(organizationId, projectId));
  }

  @Get(":projectId")
  @RequireRole("viewer")
  async get(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetProjectQuery(organizationId, projectId));
  }

  @Patch(":projectId")
  @RequireRole("editor")
  @HttpCode(204)
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: UpdateProjectDto,
  ): Promise<void> {
    await this.commandBus.execute(new UpdateProjectCommand(organizationId, projectId, body));
  }

  // Archiving takes a project out of everybody's list, so it sits a rung above editing it.
  @Patch(":projectId/archived")
  @RequireRole("admin")
  @HttpCode(204)
  async setArchived(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ArchiveProjectDto,
  ): Promise<void> {
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
      new ImportSpecVersionCommand(
        organizationId,
        projectId,
        toSource(body.source),
        actorId(principal),
        body.activate ?? true,
      ),
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
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(
      new ActivateSpecVersionCommand(organizationId, projectId, specVersionId, actorId(principal)),
    );
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
    return this.commandBus.execute(
      new CheckSpecDriftCommand(organizationId, projectId, toSource(body.source), actorId(principal)),
    );
  }

  /**
   * Bifurcar: un proyecto nuevo con todo lo de este, que recuerda de dónde salió.
   *
   * `editor`, como crear un proyecto: es lo que hace. Sustituye a «copiar de otro proyecto», que
   * pedía `admin` porque reemplazaba secciones enteras de un proyecto que ya existía; esto no toca
   * nada que exista, crea.
   */
  @Post(":projectId/fork")
  @RequireRole("editor")
  async fork(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ForkProjectDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ForkProjectCommand(
        organizationId,
        projectId,
        { name: body.name, description: body.description },
        actorId(principal),
      ),
    );
  }

  /**
   * La comparación a tres bandas de una bifurcación con su original, en un sentido: `pull` trae del
   * original, `merge` lleva al original. `editor` y no `viewer`, como exportar: enseña scripts y
   * cabeceras de los dos proyectos enteros.
   */
  @Get(":projectId/fork/:direction")
  @RequireRole("editor")
  async forkDiff(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("direction") direction: string,
  ) {
    return this.queryBus.execute(new GetForkDiffQuery(organizationId, projectId, assertDirection(direction)));
  }

  /**
   * Aplicar la comparación. Al fusionar se escribe en el original, y el permiso es el de escribir en
   * él: `editor` en esta organización, que es donde viven los dos, y el original sin archivar.
   */
  @Post(":projectId/fork/:direction")
  @RequireRole("editor")
  @HttpCode(200)
  async syncFork(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("direction") direction: string,
    @Body() body: SyncForkDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new SyncForkCommand(
        organizationId,
        projectId,
        assertDirection(direction),
        body.token,
        body.resolutions ?? {},
        actorId(principal),
      ),
    );
  }

  /**
   * Crear una solicitud de fusión desde la bifurcación. `editor`, como fusionar: es pedir escribir
   * en el original, y quien no puede escribir en esta organización tampoco lo pide.
   */
  @Post(":projectId/merge-requests")
  @RequireRole("editor")
  async createMergeRequest(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateMergeRequestDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new CreateMergeRequestCommand(
        organizationId,
        projectId,
        { title: body.title, description: body.description },
        actorId(principal),
      ),
    );
  }

  /**
   * Las solicitudes de un proyecto, como original o como bifurcación. `viewer`: la lista es título,
   * estado y quién, sin la comparación, y cualquiera del equipo puede ver qué está pendiente.
   */
  @Get(":projectId/merge-requests")
  @RequireRole("viewer")
  async listMergeRequests(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListMergeRequestsQuery(organizationId, projectId));
  }

  /** Una solicitud con su hilo y su comparación. `editor`, como la comparación directa: enseña los
   * scripts y las cabeceras de los dos proyectos. */
  @Get(":projectId/merge-requests/:requestId")
  @RequireRole("editor")
  async getMergeRequest(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @CurrentUser() principal: Principal,
  ) {
    return this.queryBus.execute(new GetMergeRequestQuery(organizationId, projectId, requestId, actorId(principal)));
  }

  @Post(":projectId/merge-requests/:requestId/comments")
  @RequireRole("editor")
  @HttpCode(204)
  async commentMergeRequest(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @Body() body: MergeRequestCommentDto,
    @CurrentUser() principal: Principal,
  ) {
    await this.commandBus.execute(
      new CommentMergeRequestCommand(organizationId, projectId, requestId, body.body, actorId(principal)),
    );
  }

  /**
   * Fusionar la solicitud: la comparación de ahora, con su huella y las decisiones de quien fusiona.
   * Declarada antes que `:action` para que «merge» no se lea como una acción de revisión.
   */
  @Post(":projectId/merge-requests/:requestId/merge")
  @RequireRole("editor")
  @HttpCode(200)
  async mergeMergeRequest(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @Body() body: SyncForkDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new MergeMergeRequestCommand(
        organizationId,
        projectId,
        requestId,
        body.token,
        body.resolutions ?? {},
        actorId(principal),
      ),
    );
  }

  /** `approve`, `decline` o `close`. Quién puede cada una lo decide el dominio: ver `merge-request.ts`. */
  @Post(":projectId/merge-requests/:requestId/:action")
  @RequireRole("editor")
  @HttpCode(204)
  async reviewMergeRequest(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("requestId") requestId: string,
    @Param("action") action: string,
    @Body() body: MergeRequestReviewDto,
    @CurrentUser() principal: Principal,
  ) {
    await this.commandBus.execute(
      new ReviewMergeRequestCommand(
        organizationId,
        projectId,
        requestId,
        assertReviewAction(action),
        body.body ?? "",
        actorId(principal),
      ),
    );
  }

  @Get(":projectId/import-preview")
  @RequireRole("editor")
  async importPreview(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("sourceProjectId") sourceProjectId: string,
  ) {
    return this.queryBus.execute(new GetImportPreviewQuery(organizationId, projectId, sourceProjectId));
  }

  @Post(":projectId/import-elements")
  @RequireRole("editor")
  async importElements(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportElementsDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportElementsCommand(
        organizationId,
        projectId,
        {
          sourceProjectId: body.sourceProjectId,
          endpointIds: body.endpointIds ?? [],
          workflowIds: body.workflowIds ?? [],
          environmentIds: body.environmentIds ?? [],
        },
        actorId(principal),
      ),
    );
  }

  /**
   * The project as a JSON file (see `project-bundle.ts`): no credential and no secret value in it.
   * `editor`, like importing: the file carries scripts and headers somebody may not want a viewer
   * to walk away with in one click.
   */
  @Get(":projectId/export")
  @RequireRole("editor")
  async exportProject(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("parts") parts?: string,
    @Query("workflowIds") workflowIds?: string,
  ) {
    return this.queryBus.execute(
      new ExportProjectQuery(organizationId, projectId, listParam(parts), listParam(workflowIds)),
    );
  }

  /**
   * El mismo proyecto, escrito como lo escribiría Postman: una colección, sus entornos, o el
   * volcado con las dos cosas.
   *
   * Separada de la exportación propia y no un `?format=` de ella, porque no es el mismo fichero
   * con otro traje: el propio lo vuelve a leer este producto entero —roles, suites, planes de
   * carga— y este solo puede llevar lo que Postman sabe expresar. Dos ficheros que contestan
   * preguntas distintas.
   *
   * `editor` como la otra, y por lo mismo: el fichero lleva scripts y cabeceras que un `viewer` no
   * debería poder llevarse con un clic.
   */
  @Get(":projectId/export/postman")
  @RequireRole("editor")
  async exportPostman(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("kind") kind?: string,
    @Query("workflowIds") workflowIds?: string,
  ) {
    return this.queryBus.execute(
      new ExportPostmanQuery(organizationId, projectId, kind ?? "collection", listParam(workflowIds)),
    );
  }

  @Post(":projectId/import-bundle")
  @RequireRole("editor")
  async importBundle(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportProjectBundleDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportProjectBundleCommand(organizationId, projectId, body.bundle, body.parts ?? [], actorId(principal)),
    );
  }

  /**
   * One import for everything, the way Postman's is: files, a paste or a link, and it detects what
   * each one is instead of asking.
   *
   * `dryRun` answers with the plan and writes nothing — which is the half that makes an import
   * readable before it happens. `editor`, like every other write: importing a contract, endpoints,
   * flows and variables is the editor's daily work, and a secret in an environment file is
   * encrypted on arrival by the command that stores it.
   */
  @Post(":projectId/import")
  @RequireRole("editor")
  async importAnything(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportAnythingDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new ImportAnythingCommand(organizationId, projectId, body, actorId(principal)));
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

