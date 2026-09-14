import { Module, forwardRef, type OnApplicationBootstrap } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { SecurityRunEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { RolesModule } from "@/modules/roles/roles.module";
import { SECURITY_RUN_QUEUE, SECURITY_RUN_REPOSITORY } from "./domain/ports";
import { TypeOrmSecurityRunRepository } from "./infrastructure/persistence/typeorm-security-run.repository";
import { InMemorySecurityRunQueue } from "./infrastructure/in-memory-security-queue";
import { SecurityRunExecutor } from "./infrastructure/security-run-executor";
import { SecurityRunProgressStream } from "./infrastructure/security-run-progress.stream";
import {
  CancelSecurityRunHandler,
  DeleteSecurityRunHandler,
  SetSecurityRunVisibilityHandler,
  StartSecurityRunHandler,
} from "./application/commands/manage-security-run";
import {
  GetSecurityRunHandler,
  GetSharedSecurityRunHandler,
  ListSecurityRunsHandler,
} from "./application/queries/get-security-run";
import { GetSecurityReportHandler, GetSharedSecurityReportHandler } from "./application/queries/get-security-report";
import { AnalyzeSecurityRunHandler } from "./application/commands/analyze-security-run";
import { SECURITY_AI } from "./domain/ai";
import { AnthropicSecurityAi, FallbackSecurityAi } from "./infrastructure/security-ai";
import { ENV, type Env } from "@/shared/config/env";
import { SecurityRunsController } from "./presentation/security-runs.controller";

export const SECURITY_RUN_COMMAND_HANDLERS = [
  StartSecurityRunHandler,
  CancelSecurityRunHandler,
  DeleteSecurityRunHandler,
  SetSecurityRunVisibilityHandler,
  AnalyzeSecurityRunHandler,
];
export const SECURITY_RUN_QUERY_HANDLERS = [
  ListSecurityRunsHandler,
  GetSecurityRunHandler,
  GetSharedSecurityRunHandler,
  GetSecurityReportHandler,
  GetSharedSecurityReportHandler,
];
export const SECURITY_RUN_ADAPTERS = [
  { provide: SECURITY_RUN_REPOSITORY, useClass: TypeOrmSecurityRunRepository },
  { provide: SECURITY_RUN_QUEUE, useClass: InMemorySecurityRunQueue },
];
export const SECURITY_RUN_SERVICES = [SecurityRunProgressStream, SecurityRunExecutor];

/** The AI adapter is chosen at boot: the real one when a key is configured, the fallback otherwise.
 * Either way the port answers, so «analizar» always works — with or without prose from a model. */
export const SECURITY_AI_PROVIDER = {
  provide: SECURITY_AI,
  inject: [ENV],
  useFactory: (env: Env) =>
    env.SECURITY_AI_DRIVER === "anthropic" ? new AnthropicSecurityAi(env) : new FallbackSecurityAi(),
};

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([SecurityRunEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EnvironmentsModule),
    forwardRef(() => EndpointsModule),
    // SpecsModule exports SAFE_FETCH, the SSRF-guarded fetch every probe goes through.
    forwardRef(() => SpecsModule),
    forwardRef(() => RolesModule),
  ],
  controllers: [SecurityRunsController],
  providers: [
    ...SECURITY_RUN_ADAPTERS,
    ...SECURITY_RUN_SERVICES,
    SECURITY_AI_PROVIDER,
    ...SECURITY_RUN_COMMAND_HANDLERS,
    ...SECURITY_RUN_QUERY_HANDLERS,
  ],
})
export class SecurityRunsModule implements OnApplicationBootstrap {
  constructor(private readonly executor: SecurityRunExecutor) {}

  // The worker registers its handler once the app is up, the same way the contract orchestrator does.
  onApplicationBootstrap(): void {
    this.executor.listen();
  }
}
