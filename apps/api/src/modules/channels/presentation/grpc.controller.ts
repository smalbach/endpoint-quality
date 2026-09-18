/**
 * Las rutas propias de un canal gRPC, al lado de las de cualquier canal y con el mismo prefijo.
 *
 * Aparte de `ChannelsController` porque son de un solo protocolo: el `.proto`, la reflexión y el medio
 * cierre no significan nada en un WebSocket, y cada protocolo que llegue trae las suyas sin tocar las
 * de los demás.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";

import { OrgRoleGuard, RequireRole } from "@/modules/auth/infrastructure/guards/auth.guard";
import {
  EndChannelStreamCommand,
  GetGrpcSchemaQuery,
  ReflectGrpcCommand,
  SaveChannelProtosCommand,
} from "../application/commands/manage-grpc";
import { ReflectGrpcDto, SaveProtosDto } from "./dto/grpc.dto";

@Controller("orgs/:organizationId/projects/:projectId/channels")
@UseGuards(OrgRoleGuard)
export class GrpcChannelsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get(":channelId/grpc")
  @RequireRole("viewer")
  schema(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.queryBus.execute(new GetGrpcSchemaQuery(organizationId, projectId, channelId));
  }

  @Put(":channelId/grpc/protos")
  @RequireRole("editor")
  saveProtos(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
    @Body() body: SaveProtosDto,
  ) {
    return this.commandBus.execute(new SaveChannelProtosCommand(organizationId, projectId, channelId, body.files));
  }

  @Post(":channelId/grpc/reflection")
  @RequireRole("editor")
  @HttpCode(200)
  reflect(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("channelId") channelId: string,
    @Body() body: ReflectGrpcDto,
  ) {
    return this.commandBus.execute(
      new ReflectGrpcCommand(organizationId, projectId, channelId, body.environmentId ?? null),
    );
  }

  @Post("sessions/:sessionId/end")
  @RequireRole("editor")
  @HttpCode(202)
  async end(
    @Param("organizationId") organizationId: string,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
  ) {
    await this.commandBus.execute(new EndChannelStreamCommand(organizationId, projectId, sessionId));
    return { accepted: true };
  }
}
