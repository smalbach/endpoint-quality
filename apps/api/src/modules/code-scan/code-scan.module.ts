import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CodeConnectorEntity, CodeScanEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { RolesModule } from "@/modules/roles/roles.module";
import { WorkflowsModule } from "@/modules/workflows/workflows.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { CODE_CONNECTOR_REPOSITORY, CODE_SCAN_REPOSITORY, GITHUB_SOURCE } from "./domain/ports";
import {
  TypeOrmCodeConnectorRepository,
  TypeOrmCodeScanRepository,
} from "./infrastructure/persistence/typeorm-code-scan.repository";
import { GithubSource } from "./infrastructure/github-source";
import { DeleteConnectorHandler, SaveConnectorHandler } from "./application/commands/manage-connector";
import { ScanFromGithubHandler, ScanFromUploadHandler } from "./application/commands/scan";
import { ImportScanHandler } from "./application/commands/import-scan";
import { GetConnectorHandler, GetScanHandler, ListScansHandler } from "./application/queries/read-code-scan";
import { CodeScanController } from "./presentation/code-scan.controller";

export const CODE_SCAN_COMMAND_HANDLERS = [
  SaveConnectorHandler,
  DeleteConnectorHandler,
  ScanFromGithubHandler,
  ScanFromUploadHandler,
  ImportScanHandler,
];
export const CODE_SCAN_QUERY_HANDLERS = [GetConnectorHandler, ListScansHandler, GetScanHandler];
export const CODE_SCAN_ADAPTERS = [
  { provide: CODE_CONNECTOR_REPOSITORY, useClass: TypeOrmCodeConnectorRepository },
  { provide: CODE_SCAN_REPOSITORY, useClass: TypeOrmCodeScanRepository },
  { provide: GITHUB_SOURCE, useClass: GithubSource },
];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([CodeConnectorEntity, CodeScanEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EndpointsModule),
    forwardRef(() => RolesModule),
    forwardRef(() => WorkflowsModule),
    // SpecsModule exports SAFE_FETCH, the guard the GitHub API is read through.
    forwardRef(() => SpecsModule),
  ],
  controllers: [CodeScanController],
  providers: [...CODE_SCAN_ADAPTERS, ...CODE_SCAN_COMMAND_HANDLERS, ...CODE_SCAN_QUERY_HANDLERS],
  exports: [CODE_SCAN_REPOSITORY],
})
export class CodeScanModule {}
