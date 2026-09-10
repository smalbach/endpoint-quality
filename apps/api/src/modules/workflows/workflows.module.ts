import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { RequestTemplateEntity, WorkflowEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { WORKFLOW_REPOSITORY } from "./domain/ports";
import { TypeOrmWorkflowRepository } from "./infrastructure/persistence/typeorm-workflow.repository";
import {
  CreateRequestTemplateHandler,
  DeleteRequestTemplateHandler,
  UpdateRequestTemplateHandler,
} from "./application/commands/manage-request-template";
import {
  CreateWorkflowHandler,
  DeleteWorkflowHandler,
  UpdateWorkflowHandler,
} from "./application/commands/manage-workflow";
import { ListWorkflowsHandler } from "./application/queries/list-workflows";
import { WorkflowsController } from "./presentation/workflows.controller";

export const WORKFLOW_COMMAND_HANDLERS = [
  CreateRequestTemplateHandler,
  UpdateRequestTemplateHandler,
  DeleteRequestTemplateHandler,
  CreateWorkflowHandler,
  UpdateWorkflowHandler,
  DeleteWorkflowHandler,
];
export const WORKFLOW_QUERY_HANDLERS = [ListWorkflowsHandler];
export const WORKFLOW_ADAPTERS = [{ provide: WORKFLOW_REPOSITORY, useClass: TypeOrmWorkflowRepository }];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([RequestTemplateEntity, WorkflowEntity]),
    forwardRef(() => ProjectsModule),
  ],
  controllers: [WorkflowsController],
  providers: [...WORKFLOW_ADAPTERS, ...WORKFLOW_COMMAND_HANDLERS, ...WORKFLOW_QUERY_HANDLERS],
  exports: [WORKFLOW_REPOSITORY],
})
export class WorkflowsModule {}
