import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  RequestTemplateEntity,
  WorkflowDatasetEntity,
  WorkflowEntity,
  WorkflowSuiteEntity,
} from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { WORKFLOW_REPOSITORY } from "./domain/ports";
import { TypeOrmWorkflowRepository } from "./infrastructure/persistence/typeorm-workflow.repository";
import {
  CreateRequestTemplateHandler,
  DeleteRequestTemplateHandler,
  UpdateRequestTemplateHandler,
} from "./application/commands/manage-request-template";
import { ImportRequestTemplatesHandler } from "./application/commands/import-request-templates";
import { ImportPostmanFlowsHandler } from "./application/commands/import-postman-flows";
import {
  CreateWorkflowHandler,
  DeleteWorkflowHandler,
  DuplicateWorkflowHandler,
  UpdateWorkflowHandler,
} from "./application/commands/manage-workflow";
import {
  CreateDatasetHandler,
  DeleteDatasetHandler,
  UpdateDatasetHandler,
} from "./application/commands/manage-dataset";
import { CreateSuiteHandler, DeleteSuiteHandler, UpdateSuiteHandler } from "./application/commands/manage-suite";
import { ListWorkflowsHandler } from "./application/queries/list-workflows";
import { GetDatasetHandler } from "./application/queries/get-dataset";
import { WorkflowsController } from "./presentation/workflows.controller";

export const WORKFLOW_COMMAND_HANDLERS = [
  CreateRequestTemplateHandler,
  UpdateRequestTemplateHandler,
  DeleteRequestTemplateHandler,
  ImportRequestTemplatesHandler,
  ImportPostmanFlowsHandler,
  CreateWorkflowHandler,
  UpdateWorkflowHandler,
  DeleteWorkflowHandler,
  DuplicateWorkflowHandler,
  CreateDatasetHandler,
  UpdateDatasetHandler,
  DeleteDatasetHandler,
  CreateSuiteHandler,
  UpdateSuiteHandler,
  DeleteSuiteHandler,
];
export const WORKFLOW_QUERY_HANDLERS = [ListWorkflowsHandler, GetDatasetHandler];
export const WORKFLOW_ADAPTERS = [{ provide: WORKFLOW_REPOSITORY, useClass: TypeOrmWorkflowRepository }];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([RequestTemplateEntity, WorkflowEntity, WorkflowDatasetEntity, WorkflowSuiteEntity]),
    forwardRef(() => ProjectsModule),
    // The importer reads the active contract's operations: a request that lands on no operation is
    // reported rather than imported, which is what keeps the contract the source of the endpoints.
    forwardRef(() => SpecsModule),
  ],
  controllers: [WorkflowsController],
  providers: [...WORKFLOW_ADAPTERS, ...WORKFLOW_COMMAND_HANDLERS, ...WORKFLOW_QUERY_HANDLERS],
  exports: [WORKFLOW_REPOSITORY],
})
export class WorkflowsModule {}
