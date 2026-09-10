import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { SpecOperationEntity, SpecSourceEntity, SpecVersionEntity } from "@/shared/database/entities";
import { SAFE_FETCH } from "@/shared/http/safe-fetch";
import { ConfiguredSafeFetch } from "@/shared/http/safe-fetch.provider";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SPEC_REPOSITORY } from "./domain/ports";
import { TypeOrmSpecRepository } from "./infrastructure/persistence/typeorm-spec.repository";
import { ImportSpecVersionHandler } from "./application/commands/import-spec-version";
import { ActivateSpecVersionHandler } from "./application/commands/activate-spec-version";
import { CheckSpecDriftHandler } from "./application/commands/check-spec-drift";
import { GetOperationsHandler, ListSpecVersionsHandler } from "./application/queries/get-operations";

export const SPEC_COMMAND_HANDLERS = [ImportSpecVersionHandler, ActivateSpecVersionHandler, CheckSpecDriftHandler];
export const SPEC_QUERY_HANDLERS = [GetOperationsHandler, ListSpecVersionsHandler];
export const SPEC_ADAPTERS = [
  { provide: SPEC_REPOSITORY, useClass: TypeOrmSpecRepository },
  // The one place the SSRF policy is read. A second call site building its own policy object
  // would be a second chance to leave `allowPrivateTargets` on.
  { provide: SAFE_FETCH, useClass: ConfiguredSafeFetch },
];

@Module({
  imports: [CqrsModule, TypeOrmModule.forFeature([SpecVersionEntity, SpecOperationEntity, SpecSourceEntity]), forwardRef(() => ProjectsModule)],
  providers: [...SPEC_ADAPTERS, ...SPEC_COMMAND_HANDLERS, ...SPEC_QUERY_HANDLERS],
  exports: [SPEC_REPOSITORY, SAFE_FETCH],
})
export class SpecsModule {}
