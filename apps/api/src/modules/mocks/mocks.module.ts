import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { MockCallEntity, MockServerEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { MOCK_REPOSITORY } from "./domain/ports";
import { TypeOrmMockRepository } from "./infrastructure/persistence/typeorm-mock.repository";
import {
  CreateMockHandler,
  DeleteMockHandler,
  RotateMockKeyHandler,
  UpdateMockHandler,
} from "./application/commands/manage-mocks";
import { RecordMockCallHandler } from "./application/commands/record-mock-call";
import { ListMockCallsHandler } from "./application/queries/list-mock-calls";
import { ListMocksHandler } from "./application/queries/list-mocks";
import { AnswerMockHandler } from "./application/queries/answer-mock";
import { MocksController } from "./presentation/mocks.controller";
import { MockServeController } from "./presentation/mock-serve.controller";

export const MOCK_COMMAND_HANDLERS = [
  CreateMockHandler,
  UpdateMockHandler,
  RotateMockKeyHandler,
  DeleteMockHandler,
  RecordMockCallHandler,
];
export const MOCK_QUERY_HANDLERS = [ListMocksHandler, ListMockCallsHandler, AnswerMockHandler];
export const MOCK_ADAPTERS = [{ provide: MOCK_REPOSITORY, useClass: TypeOrmMockRepository }];

/**
 * `MockServeController` va **primero** en la lista, y eso importa: es una ruta comodín bajo
 * `/mock/:publicId`, y Nest registra en el orden en que se declaran.
 */
@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([MockServerEntity, MockCallEntity]),
    forwardRef(() => EndpointsModule),
    forwardRef(() => ProjectsModule),
  ],
  controllers: [MockServeController, MocksController],
  providers: [...MOCK_ADAPTERS, ...MOCK_COMMAND_HANDLERS, ...MOCK_QUERY_HANDLERS],
  exports: [MOCK_REPOSITORY],
})
export class MocksModule {}
