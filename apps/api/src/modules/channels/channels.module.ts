/**
 * Los canales: lo que un proyecto prueba cuando no es una petición. WebSocket y MQTT.
 *
 * No importa `SpecsModule` —a diferencia de los monitores— porque un socket no sale por `SAFE_FETCH`:
 * sale por `safe-socket.ts`, con la política leída de `policyFromEnv`, que es el mismo sitio del que
 * la lee `SAFE_FETCH`. Dos consumidores, una lectura.
 */
import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ChannelEndpointEntity, ChannelMessageEntity, ChannelSessionEntity } from "@/shared/database/entities";
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
import { CHANNEL_SESSION_COMMAND_HANDLERS } from "./application/commands/manage-sessions";
import { CHANNEL_QUERY_HANDLERS } from "./application/queries/read-channels";
import { ChannelsController } from "./presentation/channels.controller";

export const CHANNEL_COMMAND_HANDLERS = [
  CreateChannelHandler,
  UpdateChannelHandler,
  DeleteChannelHandler,
  ...CHANNEL_SESSION_COMMAND_HANDLERS,
];
export { CHANNEL_QUERY_HANDLERS };
export const CHANNEL_ADAPTERS = [
  { provide: CHANNEL_REPOSITORY, useClass: TypeOrmChannelRepository },
  { provide: CHANNEL_SESSION_REPOSITORY, useClass: TypeOrmChannelSessionRepository },
  { provide: CHANNEL_TRANSPORT, useClass: WsChannelTransport },
  { provide: MQTT_TRANSPORT, useClass: MqttChannelTransport },
  ChannelProgressStream,
  ChannelSessionRegistry,
];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([ChannelEndpointEntity, ChannelSessionEntity, ChannelMessageEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EnvironmentsModule),
  ],
  controllers: [ChannelsController],
  providers: [...CHANNEL_ADAPTERS, ...CHANNEL_COMMAND_HANDLERS, ...CHANNEL_QUERY_HANDLERS],
})
export class ChannelsModule {}
