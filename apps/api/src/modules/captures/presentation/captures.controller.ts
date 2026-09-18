/**
 * La captura de tráfico de un proyecto.
 *
 * Leer es `viewer`: lo grabado llega tapado. Abrir, parar, borrar e importar es `editor`: abrir una
 * sesión es abrir un proxy con salida a la red desde el servidor, y eso es tan capaz de cambiar
 * cosas como un `POST`.
 *
 * La lista en vivo es una consulta con cursor y no un stream: la pantalla pregunta cada segundo y
 * medio por lo que vino después de lo último que tiene. Con un SSE, una API con varias instancias
 * tendría que llevar cada petición a la instancia que sirve el stream; con el cursor, cualquiera
 * contesta leyendo la tabla.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { SkipThrottle } from "@nestjs/throttler";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  DeleteCaptureCommand,
  ImportCaptureCommand,
  StartCaptureCommand,
  StopCaptureCommand,
} from "../application/commands/manage-captures";
import { GetCaptureItemQuery, GetCapturePageQuery, GetCapturesQuery } from "../application/queries/read-captures";
import { ImportCaptureDto } from "./dto/captures.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

/** Un id que no es un uuid no es de ninguna sesión: 404, y no un error de Postgres. */
const Id = new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND });

@Controller("orgs/:organizationId/projects/:projectId/captures")
@UseGuards(OrgRoleGuard)
export class CapturesController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @RequireRole("viewer")
  overview(@Param("organizationId") organizationId: string, @Param("projectId") projectId: string) {
    return this.queryBus.execute(new GetCapturesQuery(organizationId, projectId));
  }

  @Post()
  @RequireRole("editor")
  start(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(new StartCaptureCommand(organizationId, projectId, actorId(principal)));
  }

  /** La lista en vivo. Sin límite de ritmo: la pantalla pregunta mientras la sesión está abierta. */
  @Get(":sessionId")
  @SkipThrottle()
  @RequireRole("viewer")
  page(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId", Id) sessionId: string,
    @Query("after") after?: string,
  ) {
    const cursor = Number.parseInt(after ?? "0", 10);
    return this.queryBus.execute(
      new GetCapturePageQuery(organizationId, projectId, sessionId, Number.isFinite(cursor) ? cursor : 0),
    );
  }

  @Get(":sessionId/items/:itemId")
  @RequireRole("viewer")
  item(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId", Id) sessionId: string,
    @Param("itemId", Id) itemId: string,
  ) {
    return this.queryBus.execute(new GetCaptureItemQuery(organizationId, projectId, sessionId, itemId));
  }

  @Post(":sessionId/stop")
  @RequireRole("editor")
  @HttpCode(200)
  stop(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId", Id) sessionId: string,
  ) {
    return this.commandBus.execute(new StopCaptureCommand(organizationId, projectId, sessionId));
  }

  @Post(":sessionId/import")
  @RequireRole("editor")
  @HttpCode(200)
  import(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId", Id) sessionId: string,
    @Body() body: ImportCaptureDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new ImportCaptureCommand(organizationId, projectId, sessionId, body, actorId(principal)),
    );
  }

  @Delete(":sessionId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId", Id) sessionId: string,
  ): Promise<void> {
    await this.commandBus.execute(new DeleteCaptureCommand(organizationId, projectId, sessionId));
  }
}
