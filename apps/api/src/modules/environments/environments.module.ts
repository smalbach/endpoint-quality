import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { EnvironmentCredentialEntity, EnvironmentEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { ENVIRONMENT_REPOSITORY } from "./domain/ports";
import { TypeOrmEnvironmentRepository } from "./infrastructure/persistence/typeorm-environment.repository";
import {
  CreateEnvironmentHandler,
  DeleteEnvironmentHandler,
  UpdateEnvironmentHandler,
} from "./application/commands/manage-environment";
import { DeleteCredentialHandler, UpsertCredentialHandler } from "./application/commands/manage-credential";
import { ListEnvironmentsHandler } from "./application/queries/list-environments";
import { RevealVariablesHandler } from "./application/queries/reveal-variables";
import { EnvironmentsController } from "./presentation/environments.controller";

export const ENVIRONMENT_COMMAND_HANDLERS = [
  CreateEnvironmentHandler,
  UpdateEnvironmentHandler,
  DeleteEnvironmentHandler,
  UpsertCredentialHandler,
  DeleteCredentialHandler,
];
export const ENVIRONMENT_QUERY_HANDLERS = [ListEnvironmentsHandler, RevealVariablesHandler];
export const ENVIRONMENT_ADAPTERS = [{ provide: ENVIRONMENT_REPOSITORY, useClass: TypeOrmEnvironmentRepository }];

/**
 * Only environments and their credentials. The configuration used to ship inside this module
 * because the matrix needs both — that dependency is real, and it now runs the other way:
 * `ProjectConfigModule` imports this one and reads environments through their port.
 */
@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([EnvironmentEntity, EnvironmentCredentialEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
  ],
  controllers: [EnvironmentsController],
  providers: [...ENVIRONMENT_ADAPTERS, ...ENVIRONMENT_COMMAND_HANDLERS, ...ENVIRONMENT_QUERY_HANDLERS],
  exports: [ENVIRONMENT_REPOSITORY],
})
export class EnvironmentsModule {}
