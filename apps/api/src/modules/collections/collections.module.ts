import { Module, forwardRef, type OnApplicationBootstrap } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CollectionEntity, CollectionRunEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { COLLECTION_REPOSITORY, COLLECTION_RUN_QUEUE, COLLECTION_RUN_REPOSITORY } from "./domain/ports";
import {
  TypeOrmCollectionRepository,
  TypeOrmCollectionRunRepository,
} from "./infrastructure/persistence/typeorm-collection.repository";
import { InMemoryCollectionRunQueue } from "./infrastructure/in-memory-collection-queue";
import { CollectionRunner } from "./infrastructure/collection-runner";
import { CollectionProgressStream } from "./infrastructure/collection-progress.stream";
import {
  CreateCollectionHandler,
  DeleteCollectionHandler,
  UpdateCollectionHandler,
} from "./application/commands/manage-collection";
import { ImportPostmanCollectionHandler } from "./application/commands/import-postman-collection";
import { SendCollectionRequestHandler } from "./application/commands/send-collection-request";
import {
  CancelCollectionRunHandler,
  DeleteCollectionRunHandler,
  RunCollectionHandler,
} from "./application/commands/run-collection";
import {
  ExportCollectionHandler,
  GetCollectionHandler,
  GetCollectionRunHandler,
  ListCollectionRunsHandler,
  ListCollectionsHandler,
} from "./application/queries/read-collections";
import { CollectionsController } from "./presentation/collections.controller";

export const COLLECTION_COMMAND_HANDLERS = [
  CreateCollectionHandler,
  UpdateCollectionHandler,
  DeleteCollectionHandler,
  ImportPostmanCollectionHandler,
  SendCollectionRequestHandler,
  RunCollectionHandler,
  CancelCollectionRunHandler,
  DeleteCollectionRunHandler,
];
export const COLLECTION_QUERY_HANDLERS = [
  ListCollectionsHandler,
  GetCollectionHandler,
  ExportCollectionHandler,
  ListCollectionRunsHandler,
  GetCollectionRunHandler,
];
export const COLLECTION_ADAPTERS = [
  { provide: COLLECTION_REPOSITORY, useClass: TypeOrmCollectionRepository },
  { provide: COLLECTION_RUN_REPOSITORY, useClass: TypeOrmCollectionRunRepository },
  { provide: COLLECTION_RUN_QUEUE, useClass: InMemoryCollectionRunQueue },
];
export const COLLECTION_SERVICES = [CollectionProgressStream, CollectionRunner];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([CollectionEntity, CollectionRunEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EnvironmentsModule),
    // Enviar una petición es el comando de endpoints: la misma guardia, la misma cadena de
    // credenciales, el mismo tarro de cookies y los mismos scripts aislados.
    forwardRef(() => EndpointsModule),
  ],
  controllers: [CollectionsController],
  providers: [
    ...COLLECTION_ADAPTERS,
    ...COLLECTION_SERVICES,
    ...COLLECTION_COMMAND_HANDLERS,
    ...COLLECTION_QUERY_HANDLERS,
  ],
  exports: [COLLECTION_REPOSITORY, COLLECTION_RUN_REPOSITORY],
})
export class CollectionsModule implements OnApplicationBootstrap {
  constructor(private readonly runner: CollectionRunner) {}

  onApplicationBootstrap(): void {
    this.runner.listen();
  }
}
