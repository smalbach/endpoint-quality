import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { EnvironmentCredentialEntity, EnvironmentEntity, ProjectConfigEntity } from "@/shared/database/entities";
import { SECRET_CIPHER } from "@/shared/crypto/secret-cipher";
import { SecretCipherProvider } from "@/shared/crypto/secret-cipher.provider";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { ENVIRONMENT_REPOSITORY } from "./domain/ports";
import { TypeOrmEnvironmentRepository } from "./infrastructure/persistence/typeorm-environment.repository";
import { CreateEnvironmentHandler, DeleteEnvironmentHandler, UpdateEnvironmentHandler } from "./application/commands/manage-environment";
import { DeleteCredentialHandler, UpsertCredentialHandler } from "./application/commands/manage-credential";
import { ListEnvironmentsHandler } from "./application/queries/list-environments";
import { CONFIG_REPOSITORY } from "@/modules/config/domain/ports";
import { TypeOrmConfigRepository } from "@/modules/config/infrastructure/persistence/typeorm-config.repository";
import { ResetConfigSectionHandler, UpsertConfigSectionHandler } from "@/modules/config/application/commands/upsert-config-section";
import { GetProjectConfigHandler } from "@/modules/config/application/queries/get-project-config";
import { GetScenariosHandler } from "@/modules/config/application/queries/get-scenarios";
import { GetCoverageHandler } from "@/modules/config/application/queries/get-coverage";
import { EnvironmentsController } from "./presentation/environments.controller";

export const ENVIRONMENT_COMMAND_HANDLERS = [
  CreateEnvironmentHandler, UpdateEnvironmentHandler, DeleteEnvironmentHandler,
  UpsertCredentialHandler, DeleteCredentialHandler,
  UpsertConfigSectionHandler, ResetConfigSectionHandler,
];
export const ENVIRONMENT_QUERY_HANDLERS = [ListEnvironmentsHandler, GetProjectConfigHandler, GetScenariosHandler, GetCoverageHandler];
export const ENVIRONMENT_ADAPTERS = [
  { provide: ENVIRONMENT_REPOSITORY, useClass: TypeOrmEnvironmentRepository },
  { provide: CONFIG_REPOSITORY, useClass: TypeOrmConfigRepository },
  { provide: SECRET_CIPHER, useClass: SecretCipherProvider },
];

/**
 * Environments and configuration ship together because the matrix needs both: the contract says
 * what could be tested, the configuration says with which values, and the environment says which
 * of it may actually run tonight. Splitting them would put `GET /scenarios` in a module that
 * knows only one of the three.
 */
@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([EnvironmentEntity, EnvironmentCredentialEntity, ProjectConfigEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
  ],
  controllers: [EnvironmentsController],
  providers: [...ENVIRONMENT_ADAPTERS, ...ENVIRONMENT_COMMAND_HANDLERS, ...ENVIRONMENT_QUERY_HANDLERS],
  exports: [ENVIRONMENT_REPOSITORY, CONFIG_REPOSITORY, SECRET_CIPHER],
})
export class EnvironmentsModule {}
