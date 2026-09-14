import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { RoleEntity, RolePermissionEntity, RoleRuleEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { ProjectConfigModule } from "@/modules/config/config.module";
import { ROLE_REPOSITORY } from "./domain/ports";
import { TypeOrmRoleRepository } from "./infrastructure/persistence/typeorm-role.repository";
import { CreateRoleHandler, DeleteRoleHandler, UpdateRoleHandler } from "./application/commands/manage-roles";
import {
  ReplaceRoleRulesHandler,
  SetEndpointRoleAccessHandler,
  SetRolePermissionsHandler,
} from "./application/commands/permissions";
import {
  GetEndpointRoleAccessHandler,
  GetRolePermissionsHandler,
  ListRoleRulesHandler,
  ListRolesHandler,
} from "./application/queries/list-roles";
import { RolesController } from "./presentation/roles.controller";

export const ROLE_COMMAND_HANDLERS = [
  CreateRoleHandler,
  UpdateRoleHandler,
  DeleteRoleHandler,
  SetRolePermissionsHandler,
  SetEndpointRoleAccessHandler,
  ReplaceRoleRulesHandler,
];
export const ROLE_QUERY_HANDLERS = [
  ListRolesHandler,
  GetRolePermissionsHandler,
  GetEndpointRoleAccessHandler,
  ListRoleRulesHandler,
];
export const ROLE_ADAPTERS = [{ provide: ROLE_REPOSITORY, useClass: TypeOrmRoleRepository }];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([RoleEntity, RolePermissionEntity, RoleRuleEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EndpointsModule),
    forwardRef(() => EnvironmentsModule),
    forwardRef(() => ProjectConfigModule),
  ],
  controllers: [RolesController],
  providers: [...ROLE_ADAPTERS, ...ROLE_COMMAND_HANDLERS, ...ROLE_QUERY_HANDLERS],
  exports: [ROLE_REPOSITORY],
})
export class RolesModule {}
