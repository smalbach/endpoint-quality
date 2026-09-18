/**
 * Los canales: lo que un proyecto prueba cuando no es una petición. WebSocket, MQTT y gRPC.
 *
 * No importa `SpecsModule` —a diferencia de los monitores— porque un socket no sale por `SAFE_FETCH`:
 * sale por `safe-socket.ts`, con la política leída de `policyFromEnv`, que es el mismo sitio del que
 * la lee `SAFE_FETCH`. Dos consumidores, una lectura.
 */
import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  ChannelEndpointEntity,
  ChannelMessageEntity,
  ChannelProtoFileEntity,
  ChannelSessionEntity,
} from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { CHANNEL_REPOSITORY, CHANNEL_SESSION_REPOSITORY } from "./domain/ports";
import {
  TypeOrmChannelRepository,
  TypeOrmChannelSessionRepository,
} from "./infrastructure/persistence/typeorm-channel.repository";
import { CHANNEL_TRANSPORT, WsChannelTransport } from "./infrastructure/ws-transport";
import { MQTT_TRANSPORT, MqttChannelTransport } from "./infrastructure/mqtt-transport";
import { ChannelProgressStream } from "./infrastructure/channel-progress.stream";
import { ChannelSessionRegistry } from "./infrastructure/session-registry";
import {
  CreateChannelHandler,
  DeleteChannelHandler,
  UpdateChannelHandler,
} from "./application/commands/manage-channels";
import { CHANNEL_SESSION_COMMAND_HANDLERS, ChannelSessionOpener } from "./application/commands/manage-sessions";
import { HeadlessChannelRunner } from "./application/headless-session";
import { CHANNEL_QUERY_HANDLERS as READ_CHANNEL_HANDLERS } from "./application/queries/read-channels";
import { ChannelsController } from "./presentation/channels.controller";
import { CHANNEL_PROTO_REPOSITORY } from "./domain/grpc";
import { TypeOrmChannelProtoRepository } from "./infrastructure/persistence/typeorm-proto.repository";
import { GRPC_TRANSPORT, GrpcChannelTransport } from "./infrastructure/grpc-transport";
import { GrpcSessionPlanner } from "./application/grpc";
import { GRPC_COMMAND_HANDLERS, GRPC_QUERY_HANDLERS } from "./application/commands/manage-grpc";
import { GrpcChannelsController } from "./presentation/grpc.controller";

export const CHANNEL_COMMAND_HANDLERS = [
  CreateChannelHandler,
  UpdateChannelHandler,
  DeleteChannelHandler,
  ...CHANNEL_SESSION_COMMAND_HANDLERS,
  ...GRPC_COMMAND_HANDLERS,
];
export const CHANNEL_QUERY_HANDLERS = [...READ_CHANNEL_HANDLERS, ...GRPC_QUERY_HANDLERS];
export const CHANNEL_ADAPTERS = [
  { provide: CHANNEL_REPOSITORY, useClass: TypeOrmChannelRepository },
  { provide: CHANNEL_SESSION_REPOSITORY, useClass: TypeOrmChannelSessionRepository },
  { provide: CHANNEL_TRANSPORT, useClass: WsChannelTransport },
  { provide: MQTT_TRANSPORT, useClass: MqttChannelTransport },
  ChannelProgressStream,
  ChannelSessionRegistry,
  { provide: CHANNEL_PROTO_REPOSITORY, useClass: TypeOrmChannelProtoRepository },
  { provide: GRPC_TRANSPORT, useClass: GrpcChannelTransport },
  GrpcSessionPlanner,
  ChannelSessionOpener,
  HeadlessChannelRunner,
];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([
      ChannelEndpointEntity,
      ChannelSessionEntity,
      ChannelMessageEntity,
      ChannelProtoFileEntity,
    ]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EnvironmentsModule),
  ],
  controllers: [ChannelsController, GrpcChannelsController],
  providers: [...CHANNEL_ADAPTERS, ...CHANNEL_COMMAND_HANDLERS, ...CHANNEL_QUERY_HANDLERS],
  // Para los flujos: el nodo canal corre por la misma apertura que «Conectar», y guardar un flujo
  // comprueba que el canal que nombra es de su proyecto. Los `.proto`, para bifurcar y sincronizar.
  exports: [CHANNEL_REPOSITORY, CHANNEL_PROTO_REPOSITORY, HeadlessChannelRunner],
})
export class ChannelsModule {}
