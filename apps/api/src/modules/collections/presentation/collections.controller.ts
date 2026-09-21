/**
 * Colecciones: el árbol que alguien trajo de Postman, y las corridas de él.
 *
 * `viewer` lee; `editor` escribe el árbol, envía una petición y lanza o cancela una corrida — las
 * tres cosas alcanzan el API de alguien y pueden crear filas. El entorno sigue decidiendo si una
 * escritura se permite: esa autoridad no se muda aquí.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Sse, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { concat, from, map, takeWhile, type Observable } from "rxjs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateCollectionCommand,
  DeleteCollectionCommand,
  UpdateCollectionCommand,
} from "../application/commands/manage-collection";
import { ImportPostmanCollectionCommand } from "../application/commands/import-postman-collection";
import { SendCollectionRequestCommand } from "../application/commands/send-collection-request";
import {
  CancelCollectionRunCommand,
  DeleteCollectionRunCommand,
  RunCollectionCommand,
} from "../application/commands/run-collection";
import {
  ExportCollectionQuery,
  GetCollectionQuery,
  GetCollectionRunQuery,
  ListCollectionRunsQuery,
  ListCollectionsQuery,
} from "../application/queries/read-collections";
import { CollectionProgressStream } from "../infrastructure/collection-progress.stream";
import type { CollectionRequest } from "../domain/model";
import {
  CreateCollectionDto,
  ImportPostmanCollectionDto,
  RunCollectionDto,
  SendCollectionRequestDto,
  UpdateCollectionDto,
} from "./dto/collections.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/collections")
@UseGuards(OrgRoleGuard)
export class CollectionsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly progress: CollectionProgressStream,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new ListCollectionsQuery(organizationId, projectId));
  }

  @Post()
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateCollectionDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new CreateCollectionCommand(organizationId, projectId, body, actorId(principal)));
  }

  /** Una colección de Postman, tal cual. Creada, o actualizada si el proyecto ya tenía ese nombre. */
  @Post("import")
  @RequireRole("editor")
  async import(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportPostmanCollectionDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportPostmanCollectionCommand(organizationId, projectId, body, actorId(principal)),
    );
  }

  // ----- Corridas: antes que `:collectionId`, o «runs» se leería como el id de una colección -----

  @Get("runs")
  @RequireRole("viewer")
  async listRuns(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("collectionId") collectionId?: string,
  ) {
    return this.queryBus.execute(new ListCollectionRunsQuery(organizationId, projectId, collectionId || undefined));
  }

  @Get("runs/:runId")
  @RequireRole("viewer")
  async getRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ) {
    return this.queryBus.execute(new GetCollectionRunQuery(organizationId, projectId, runId));
  }

  @Post("runs/:runId/cancel")
  @RequireRole("editor")
  @HttpCode(204)
  async cancelRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new CancelCollectionRunCommand(organizationId, projectId, runId));
  }

  @Delete("runs/:runId")
  @RequireRole("editor")
  @HttpCode(204)
  async deleteRun(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteCollectionRunCommand(organizationId, projectId, runId));
  }

  /** La corrida en vivo: el estado de ahora, luego cada petición según acaba, y el final la cierra. */
  @Sse("runs/:runId/stream")
  @RequireRole("viewer")
  stream(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
  ): Observable<{ data: unknown; type: string }> {
    const snapshot = from(this.queryBus.execute(new GetCollectionRunQuery(organizationId, projectId, runId))).pipe(
      map((run: unknown) => {
        const detail = run as { status: string; totals: { requests: number } };
        return {
          type: detail.status === "running" ? "result" : "finished",
          data: {
            runId,
            status: detail.status,
            totals: detail.totals,
            progress: { done: detail.totals.requests, total: detail.totals.requests },
          },
        };
      }),
    );
    return concat(snapshot, this.progress.forRun(runId)).pipe(takeWhile((event) => event.type !== "finished", true));
  }

  // ----- Una colección -----

  @Get(":collectionId")
  @RequireRole("viewer")
  async get(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
  ) {
    return this.queryBus.execute(new GetCollectionQuery(organizationId, projectId, collectionId));
  }

  /** El fichero de Postman: lo que se descarga, y qué credencial se quedó fuera. */
  @Get(":collectionId/export")
  @RequireRole("viewer")
  async export(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
  ) {
    return this.queryBus.execute(new ExportCollectionQuery(organizationId, projectId, collectionId));
  }

  @Put(":collectionId")
  @RequireRole("editor")
  @HttpCode(204)
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
    @Body() body: UpdateCollectionDto,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(
      new UpdateCollectionCommand(organizationId, projectId, collectionId, body, actorId(principal)),
    );
  }

  /** Renombrar y describir sin mandar el árbol entero, que es lo que hace la lista. */
  @Patch(":collectionId")
  @RequireRole("editor")
  @HttpCode(204)
  async rename(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
    @Body() body: UpdateCollectionDto,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.commandBus.execute(
      new UpdateCollectionCommand(
        organizationId,
        projectId,
        collectionId,
        { name: body.name, description: body.description },
        actorId(principal),
      ),
    );
  }

  @Delete(":collectionId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteCollectionCommand(organizationId, projectId, collectionId));
  }

  /** «Enviar»: la petición que hay en pantalla, con los scripts y la autenticación que hereda. */
  @Post(":collectionId/send")
  @RequireRole("editor")
  async send(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
    @Body() body: SendCollectionRequestDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new SendCollectionRequestCommand(
        organizationId,
        projectId,
        collectionId,
        {
          environmentId: body.environmentId ?? null,
          itemId: body.itemId ?? null,
          request: body.request as unknown as CollectionRequest,
          preRequestScript: body.preRequestScript ?? "",
          postResponseScript: body.postResponseScript ?? "",
        },
        actorId(principal),
      ),
    );
  }

  /** «Run collection»: la corrida entera, o la de una carpeta. */
  @Post(":collectionId/runs")
  @RequireRole("editor")
  @HttpCode(202)
  async run(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("collectionId") collectionId: string,
    @Body() body: RunCollectionDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new RunCollectionCommand(
        organizationId,
        projectId,
        collectionId,
        {
          environmentId: body.environmentId ?? null,
          ...(body.iterations === undefined ? {} : { iterations: body.iterations }),
          ...(body.delayMs === undefined ? {} : { delayMs: body.delayMs }),
          ...(body.stopOnFailure === undefined ? {} : { stopOnFailure: body.stopOnFailure }),
          folderId: body.folderId ?? null,
        },
        actorId(principal),
      ),
    );
  }
}
