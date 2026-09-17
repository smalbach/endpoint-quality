import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { EnvironmentCredentialEntity, EnvironmentEntity, SessionTokenEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { ENVIRONMENT_REPOSITORY, SESSION_TOKEN_REPOSITORY } from "./domain/ports";
import { TypeOrmEnvironmentRepository } from "./infrastructure/persistence/typeorm-environment.repository";
import { TypeOrmSessionTokenRepository } from "./infrastructure/persistence/typeorm-session-token.repository";
import { ActivateEnvironmentHandler } from "./application/commands/active-environment";
import { ClearSessionTokenHandler, GetSessionTokenHandler } from "./application/commands/session-token";
import {
  CreateEnvironmentHandler,
  DeleteEnvironmentHandler,
  UpdateEnvironmentHandler,
} from "./application/commands/manage-environment";
import { DeleteCredentialHandler, UpsertCredentialHandler } from "./application/commands/manage-credential";
import { ImportPostmanEnvironmentHandler } from "./application/commands/import-postman-environment";
import { ListEnvironmentsHandler } from "./application/queries/list-environments";
import { RevealVariablesHandler } from "./application/queries/reveal-variables";
import { EnvironmentsController } from "./presentation/environments.controller";

export const ENVIRONMENT_COMMAND_HANDLERS = [
  CreateEnvironmentHandler,
  UpdateEnvironmentHandler,
  DeleteEnvironmentHandler,
  ImportPostmanEnvironmentHandler,
  UpsertCredentialHandler,
  DeleteCredentialHandler,
  ActivateEnvironmentHandler,
  ClearSessionTokenHandler,
];
export const ENVIRONMENT_QUERY_HANDLERS = [ListEnvironmentsHandler, RevealVariablesHandler, GetSessionTokenHandler];
export const ENVIRONMENT_ADAPTERS = [
  { provide: ENVIRONMENT_REPOSITORY, useClass: TypeOrmEnvironmentRepository },
  { provide: SESSION_TOKEN_REPOSITORY, useClass: TypeOrmSessionTokenRepository },
];

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
    TypeOrmModule.forFeature([EnvironmentEntity, EnvironmentCredentialEntity, SessionTokenEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
  ],
  controllers: [EnvironmentsController],
  providers: [...ENVIRONMENT_ADAPTERS, ...ENVIRONMENT_COMMAND_HANDLERS, ...ENVIRONMENT_QUERY_HANDLERS],
  exports: [ENVIRONMENT_REPOSITORY, SESSION_TOKEN_REPOSITORY],
})
export class EnvironmentsModule {}
