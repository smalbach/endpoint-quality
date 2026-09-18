import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  ForkMergeRequestEntity,
  ForkMergeRequestEventEntity,
  ProjectEntity,
  ProjectForkEntity,
} from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { ProjectConfigModule } from "@/modules/config/config.module";
import { WorkflowsModule } from "@/modules/workflows/workflows.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { MERGE_REQUEST_REPOSITORY, PROJECT_FORK_REPOSITORY, PROJECT_REPOSITORY } from "./domain/ports";
import { TypeOrmProjectRepository } from "./infrastructure/persistence/typeorm-project.repository";
import { TypeOrmProjectForkRepository } from "./infrastructure/persistence/typeorm-project-fork.repository";
import { TypeOrmMergeRequestRepository } from "./infrastructure/persistence/typeorm-merge-request.repository";
import {
  CommentMergeRequestHandler,
  CreateMergeRequestHandler,
  GetMergeRequestHandler,
  ListMergeRequestsHandler,
  MergeMergeRequestHandler,
  ReviewMergeRequestHandler,
} from "./application/commands/merge-requests";
import { MergeRequestNotifier } from "./application/merge-request-notifier";
import { MergeRequestViews } from "./application/merge-request-views";
import { CreateProjectHandler } from "./application/commands/create-project";
import { ForkProjectHandler } from "./application/commands/fork-project";
import { GetForkDiffHandler, SyncForkHandler } from "./application/commands/sync-fork";
import { ForkSync } from "./application/fork-sync";
import { ImportElementsHandler } from "./application/commands/import-elements";
import { ImportProjectBundleHandler } from "./application/commands/import-project-bundle";
import { ImportAnythingHandler } from "./application/commands/import-anything";
import { ExportProjectHandler } from "./application/queries/export-project";
import { ExportPostmanHandler } from "./application/queries/export-postman";
import { RolesModule } from "@/modules/roles/roles.module";
import { PerformanceModule } from "@/modules/performance/performance.module";
import { GetImportPreviewHandler } from "./application/queries/import-preview";
import { SetProjectArchivedHandler, UpdateProjectHandler } from "./application/commands/update-project";
import { DeleteProjectHandler } from "./application/commands/delete-project";
import { RunsModule } from "@/modules/runs/runs.module";
import { ChannelsModule } from "@/modules/channels/channels.module";
import { GetProjectHandler, ListProjectsHandler } from "./application/queries/list-projects";
import { ProjectsController } from "./presentation/projects.controller";

export const PROJECT_COMMAND_HANDLERS = [
  CreateProjectHandler,
  UpdateProjectHandler,
  SetProjectArchivedHandler,
  DeleteProjectHandler,
  ForkProjectHandler,
  SyncForkHandler,
  CreateMergeRequestHandler,
  CommentMergeRequestHandler,
  ReviewMergeRequestHandler,
  MergeMergeRequestHandler,
  ImportElementsHandler,
  ImportProjectBundleHandler,
  ImportAnythingHandler,
];
export const PROJECT_QUERY_HANDLERS = [
  ListProjectsHandler,
  GetProjectHandler,
  GetImportPreviewHandler,
  ExportProjectHandler,
  ExportPostmanHandler,
  GetForkDiffHandler,
  ListMergeRequestsHandler,
  GetMergeRequestHandler,
];
/** Lo que comparten la vista previa y la aplicación de una sincronización —ver `fork-sync.ts`—, y
 * la lectura y los avisos de las solicitudes de fusión. */
export const PROJECT_SERVICES = [ForkSync, MergeRequestViews, MergeRequestNotifier];
export const PROJECT_ADAPTERS = [
  { provide: PROJECT_REPOSITORY, useClass: TypeOrmProjectRepository },
  { provide: PROJECT_FORK_REPOSITORY, useClass: TypeOrmProjectForkRepository },
  { provide: MERGE_REQUEST_REPOSITORY, useClass: TypeOrmMergeRequestRepository },
];

/**
 * The controller lives here and serves both modules' routes, because a contract is not a
 * resource of its own: it is always "the contract *of* this project", and splitting the routes
 * would put `/projects/:id/spec-versions` in a module that knows nothing about projects.
 */
@Module({
  imports: [
    CqrsModule,
    TypeOrmModule.forFeature([ProjectEntity, ProjectForkEntity, ForkMergeRequestEntity, ForkMergeRequestEventEntity]),
    forwardRef(() => SpecsModule),
    // Copying a project reads the other one's configuration, its flows and its environments, so
    // this module needs all three repositories. Circular, because each of those modules already
    // needs the project repository to resolve tenancy — which is what `forwardRef` is for.
    forwardRef(() => ProjectConfigModule),
    forwardRef(() => WorkflowsModule),
    forwardRef(() => EnvironmentsModule),
    forwardRef(() => EndpointsModule),
    // Exporting and importing a project file reads and writes its roles and performance plans too.
    forwardRef(() => RolesModule),
    forwardRef(() => PerformanceModule),
    // The project list shows the health of each project's latest run.
    forwardRef(() => RunsModule),
    // Bifurcar y sincronizar llevan los canales y sus `.proto`.
    forwardRef(() => ChannelsModule),
    AuthModule,
    IamModule,
  ],
  controllers: [ProjectsController],
  providers: [...PROJECT_ADAPTERS, ...PROJECT_SERVICES, ...PROJECT_COMMAND_HANDLERS, ...PROJECT_QUERY_HANDLERS],
  exports: [PROJECT_REPOSITORY, PROJECT_FORK_REPOSITORY],
})
export class ProjectsModule {}
