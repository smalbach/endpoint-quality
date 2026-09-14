import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { EndpointEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { ENDPOINT_REPOSITORY } from "./domain/ports";
import { SCRIPT_SANDBOX } from "@/shared/scripts/script-sandbox";
import { ProcessScriptSandbox } from "@/shared/scripts/process-script-sandbox";
import { TypeOrmEndpointRepository } from "./infrastructure/persistence/typeorm-endpoint.repository";
import {
  CreateEndpointHandler,
  DeleteEndpointsHandler,
  SetEndpointStatusHandler,
  UpdateEndpointHandler,
} from "./application/commands/manage-endpoints";
import { ImportEndpointCurlHandler, ImportEndpointFileHandler } from "./application/commands/import-endpoints";
import { SendEndpointRequestHandler } from "./application/commands/send-endpoint-request";
import { GetEndpointHandler, ListEndpointsHandler } from "./application/queries/list-endpoints";
import { SyncContractEndpointsHandler } from "./application/events/sync-contract-endpoints";
import { EndpointsController } from "./presentation/endpoints.controller";

export const ENDPOINT_COMMAND_HANDLERS = [
  CreateEndpointHandler,
  UpdateEndpointHandler,
  DeleteEndpointsHandler,
  SetEndpointStatusHandler,
  ImportEndpointFileHandler,
  ImportEndpointCurlHandler,
  SendEndpointRequestHandler,
];
export const ENDPOINT_QUERY_HANDLERS = [ListEndpointsHandler, GetEndpointHandler];
export const ENDPOINT_EVENT_HANDLERS = [SyncContractEndpointsHandler];
export const ENDPOINT_ADAPTERS = [
  { provide: ENDPOINT_REPOSITORY, useClass: TypeOrmEndpointRepository },
  { provide: SCRIPT_SANDBOX, useClass: ProcessScriptSandbox },
];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([EndpointEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
    forwardRef(() => EnvironmentsModule),
  ],
  controllers: [EndpointsController],
  providers: [
    ...ENDPOINT_ADAPTERS,
    ...ENDPOINT_COMMAND_HANDLERS,
    ...ENDPOINT_QUERY_HANDLERS,
    ...ENDPOINT_EVENT_HANDLERS,
  ],
  exports: [ENDPOINT_REPOSITORY],
})
export class EndpointsModule {}
