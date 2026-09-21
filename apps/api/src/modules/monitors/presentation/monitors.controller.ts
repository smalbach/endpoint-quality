/**
 * Los monitores de un proyecto.
 *
 * `viewer` lista y lee el historial: saber si la vigilancia está verde es parte de mirar un
 * proyecto. Todo lo demás es `editor`, **incluido «Correr ahora»** — lanza una corrida real contra
 * un servicio real, y eso no es una lectura.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import {
  CurrentUser,
  OrgRoleGuard,
  RequireRole,
  type Principal,
} from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  CreateMonitorCommand,
  DeleteMonitorCommand,
  RestoreMonitorCommand,
  RunMonitorNowCommand,
  SetMonitorArchivedCommand,
  UpdateMonitorCommand,
} from "../application/commands/manage-monitors";
import { parseLifecycleState } from "@/shared/lifecycle/lifecycle";
import { SetArchivedDto } from "@/shared/lifecycle/lifecycle.dto";
import { ListMonitorsQuery, MonitorHistoryQuery } from "../application/queries/list-monitors";
import { CreateMonitorDto, UpdateMonitorDto } from "./dto/monitors.dto";

const actorId = (principal: Principal): string => (principal.kind === "user" ? principal.userId : principal.tokenId);

@Controller("orgs/:organizationId/projects/:projectId/monitors")
@UseGuards(OrgRoleGuard)
export class MonitorsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @RequireRole("viewer")
  async list(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Query("state") state?: string,
  ) {
    return this.queryBus.execute(new ListMonitorsQuery(organizationId, projectId, parseLifecycleState(state)));
  }

  @Get(":monitorId/executions")
  @RequireRole("viewer")
  async history(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("monitorId") monitorId: string,
  ) {
    return this.queryBus.execute(new MonitorHistoryQuery(organizationId, projectId, monitorId));
  }

  @Post()
  @RequireRole("editor")
  async create(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateMonitorDto,
    @CurrentUser() principal: Principal,
  ) {
    return this.commandBus.execute(
      new CreateMonitorCommand(
        organizationId,
        projectId,
        { name: body.name, schedule: body.schedule, plan: body.plan, alert: body.alert ?? null },
        actorId(principal),
      ),
    );
  }

  @Patch(":monitorId")
  @RequireRole("editor")
  async update(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("monitorId") monitorId: string,
    @Body() body: UpdateMonitorDto,
  ) {
    return this.commandBus.execute(new UpdateMonitorCommand(organizationId, projectId, monitorId, body));
  }

  /** Lanza la corrida ya, **sin tocar el turno**: el botón dice «correr», no «reprogramar». */
  @Post(":monitorId/runs")
  @RequireRole("editor")
  @HttpCode(202)
  async runNow(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("monitorId") monitorId: string,
  ) {
    return this.commandBus.execute(new RunMonitorNowCommand(organizationId, projectId, monitorId));
  }

  /** Fuera de la lista y sin lanzar corridas, sin perder el horario ni el historial. */
  @Patch(":monitorId/archived")
  @RequireRole("editor")
  async setArchived(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("monitorId") monitorId: string,
    @Body() body: SetArchivedDto,
  ) {
    return this.commandBus.execute(
      new SetMonitorArchivedCommand(organizationId, projectId, monitorId, body.archived),
    );
  }

  /** Lo que devuelve un eliminado a donde estaba: a la lista, o a los archivados si lo estaba. */
  @Post(":monitorId/restore")
  @RequireRole("editor")
  async restore(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("monitorId") monitorId: string,
  ) {
    return this.commandBus.execute(new RestoreMonitorCommand(organizationId, projectId, monitorId));
  }

  /**
   * Borrado blando. `?purge=true` es el definitivo, y solo vale sobre algo ya eliminado: quien
   * llama a la API no pasa por el diálogo de la pantalla, así que el orden lo guarda el comando.
   */
  @Delete(":monitorId")
  @RequireRole("editor")
  @HttpCode(204)
  async remove(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("monitorId") monitorId: string,
    @Query("purge") purge?: string,
  ) {
    await this.commandBus.execute(new DeleteMonitorCommand(organizationId, projectId, monitorId, purge === "true"));
  }
}
