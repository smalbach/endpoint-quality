import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ProjectEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { PROJECT_REPOSITORY } from "./domain/ports";
import { TypeOrmProjectRepository } from "./infrastructure/persistence/typeorm-project.repository";
import { CreateProjectHandler } from "./application/commands/create-project";
import { SetProjectArchivedHandler, UpdateProjectHandler } from "./application/commands/update-project";
import { GetProjectHandler, ListProjectsHandler } from "./application/queries/list-projects";
import { ProjectsController } from "./presentation/projects.controller";

export const PROJECT_COMMAND_HANDLERS = [CreateProjectHandler, UpdateProjectHandler, SetProjectArchivedHandler];
export const PROJECT_QUERY_HANDLERS = [ListProjectsHandler, GetProjectHandler];
export const PROJECT_ADAPTERS = [{ provide: PROJECT_REPOSITORY, useClass: TypeOrmProjectRepository }];

/**
 * The controller lives here and serves both modules' routes, because a contract is not a
 * resource of its own: it is always "the contract *of* this project", and splitting the routes
 * would put `/projects/:id/spec-versions` in a module that knows nothing about projects.
 */
@Module({
  imports: [CqrsModule, TypeOrmModule.forFeature([ProjectEntity]), forwardRef(() => SpecsModule), AuthModule, IamModule],
  controllers: [ProjectsController],
  providers: [...PROJECT_ADAPTERS, ...PROJECT_COMMAND_HANDLERS, ...PROJECT_QUERY_HANDLERS],
  exports: [PROJECT_REPOSITORY],
})
export class ProjectsModule {}
