import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ProjectEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { ProjectConfigModule } from "@/modules/config/config.module";
import { WorkflowsModule } from "@/modules/workflows/workflows.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { PROJECT_REPOSITORY } from "./domain/ports";
import { TypeOrmProjectRepository } from "./infrastructure/persistence/typeorm-project.repository";
import { CreateProjectHandler } from "./application/commands/create-project";
import { CopyFromProjectHandler } from "./application/commands/copy-from-project";
import { SetProjectArchivedHandler, UpdateProjectHandler } from "./application/commands/update-project";
import { DeleteProjectHandler } from "./application/commands/delete-project";
import { RunsModule } from "@/modules/runs/runs.module";
import { GetProjectHandler, ListProjectsHandler } from "./application/queries/list-projects";
import { ProjectsController } from "./presentation/projects.controller";

export const PROJECT_COMMAND_HANDLERS = [
  CreateProjectHandler,
  UpdateProjectHandler,
  SetProjectArchivedHandler,
  DeleteProjectHandler,
  CopyFromProjectHandler,
];
export const PROJECT_QUERY_HANDLERS = [ListProjectsHandler, GetProjectHandler];
export const PROJECT_ADAPTERS = [{ provide: PROJECT_REPOSITORY, useClass: TypeOrmProjectRepository }];

/**
 * The controller lives here and serves both modules' routes, because a contract is not a
 * resource of its own: it is always "the contract *of* this project", and splitting the routes
 * would put `/projects/:id/spec-versions` in a module that knows nothing about projects.
 */
@Module({
  imports: [
    CqrsModule,
    TypeOrmModule.forFeature([ProjectEntity]),
    forwardRef(() => SpecsModule),
    // Copying a project reads the other one's configuration, its flows and its environments, so
    // this module needs all three repositories. Circular, because each of those modules already
    // needs the project repository to resolve tenancy — which is what `forwardRef` is for.
    forwardRef(() => ProjectConfigModule),
    forwardRef(() => WorkflowsModule),
    forwardRef(() => EnvironmentsModule),
    // The project list shows the health of each project's latest run.
    forwardRef(() => RunsModule),
    AuthModule,
    IamModule,
  ],
  controllers: [ProjectsController],
  providers: [...PROJECT_ADAPTERS, ...PROJECT_COMMAND_HANDLERS, ...PROJECT_QUERY_HANDLERS],
  exports: [PROJECT_REPOSITORY],
})
export class ProjectsModule {}
