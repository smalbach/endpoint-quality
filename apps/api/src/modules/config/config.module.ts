import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ProjectConfigEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { CONFIG_REPOSITORY } from "./domain/ports";
import { TypeOrmConfigRepository } from "./infrastructure/persistence/typeorm-config.repository";
import { ResetConfigSectionHandler, UpsertConfigSectionHandler } from "./application/commands/upsert-config-section";
import { GetProjectConfigHandler } from "./application/queries/get-project-config";
import { GetScenariosHandler } from "./application/queries/get-scenarios";
import { GetCoverageHandler } from "./application/queries/get-coverage";
import { ProjectConfigController } from "./presentation/config.controller";

export const CONFIG_COMMAND_HANDLERS = [UpsertConfigSectionHandler, ResetConfigSectionHandler];
export const CONFIG_QUERY_HANDLERS = [GetProjectConfigHandler, GetScenariosHandler, GetCoverageHandler];
export const CONFIG_ADAPTERS = [{ provide: CONFIG_REPOSITORY, useClass: TypeOrmConfigRepository }];

/**
 * `ProjectConfigModule`, not `ConfigModule`: that name is already the application's environment
 * configuration in `shared/config`, and two modules answering to one name is how an import ends up
 * pointing at the wrong one.
 *
 * It reaches into `environments` because the matrix depends on all three things at once — the
 * contract says what could be tested, the configuration with which values, and the environment
 * which of it may actually run tonight. That dependency is real and stays; what it does not
 * justify is the routes living on somebody else's controller.
 */
@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([ProjectConfigEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
    forwardRef(() => EnvironmentsModule),
  ],
  controllers: [ProjectConfigController],
  providers: [...CONFIG_ADAPTERS, ...CONFIG_COMMAND_HANDLERS, ...CONFIG_QUERY_HANDLERS],
  exports: [CONFIG_REPOSITORY],
})
export class ProjectConfigModule {}
