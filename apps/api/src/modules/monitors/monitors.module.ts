import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { MonitorEntity, MonitorExecutionEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { RunsModule } from "@/modules/runs/runs.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
// `ChannelsModule` exporta el repositorio con el que se comprueba el canal de un monitor de canal.
import { ChannelsModule } from "@/modules/channels/channels.module";
// `SpecsModule` exporta `SAFE_FETCH`, el fetch con guardia de SSRF por el que sale el aviso.
import { SpecsModule } from "@/modules/specs/specs.module";
import { MONITOR_REPOSITORY } from "./domain/ports";
import { TypeOrmMonitorRepository } from "./infrastructure/persistence/typeorm-monitor.repository";
import { MonitorAlerter } from "./infrastructure/monitor-alert";
import { MonitorScheduler } from "./infrastructure/monitor.scheduler";
import { MonitorFirer } from "./application/commands/fire-monitor";
import {
  CreateMonitorHandler,
  DeleteMonitorHandler,
  RunMonitorNowHandler,
  UpdateMonitorHandler,
} from "./application/commands/manage-monitors";
import { FireDueMonitorsHandler } from "./application/commands/fire-due-monitors";
import { ListMonitorsHandler, MonitorHistoryHandler } from "./application/queries/list-monitors";
import { CloseMonitorExecutionHandler } from "./application/events/close-monitor-execution";
import { MonitorsController } from "./presentation/monitors.controller";

export const MONITOR_COMMAND_HANDLERS = [
  CreateMonitorHandler,
  UpdateMonitorHandler,
  DeleteMonitorHandler,
  RunMonitorNowHandler,
  FireDueMonitorsHandler,
];
export const MONITOR_QUERY_HANDLERS = [ListMonitorsHandler, MonitorHistoryHandler];
export const MONITOR_EVENT_HANDLERS = [CloseMonitorExecutionHandler];
export const MONITOR_ADAPTERS = [
  { provide: MONITOR_REPOSITORY, useClass: TypeOrmMonitorRepository },
  MonitorAlerter,
  MonitorFirer,
];

/**
 * `MonitorScheduler` se registra aquí y corre en **todas** las instancias, a propósito: lo que
 * reparte los monitores es el reclamo de la base de datos, y elegir una instancia «líder» haría que
 * un despliegue sin ella dejara de vigilar en silencio.
 */
@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([MonitorEntity, MonitorExecutionEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => RunsModule),
    forwardRef(() => EnvironmentsModule),
    forwardRef(() => ChannelsModule),
    forwardRef(() => SpecsModule),
  ],
  controllers: [MonitorsController],
  providers: [
    ...MONITOR_ADAPTERS,
    ...MONITOR_COMMAND_HANDLERS,
    ...MONITOR_QUERY_HANDLERS,
    ...MONITOR_EVENT_HANDLERS,
    MonitorScheduler,
  ],
  exports: [MONITOR_REPOSITORY],
})
export class MonitorsModule {}
