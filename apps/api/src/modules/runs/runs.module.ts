import { Module, forwardRef, type OnApplicationBootstrap } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FlowHookEntity, RunCaseEntity, RunEntity, RunStepEntity } from "@/shared/database/entities";
import { ENV, type Env } from "@/shared/config/env";
import { INSTANCE_BUS, type InstanceBusPort } from "@/shared/bus/instance-bus";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { ProjectConfigModule } from "@/modules/config/config.module";
import { WorkflowsModule } from "@/modules/workflows/workflows.module";
import { ChannelsModule } from "@/modules/channels/channels.module";
import { REQUEST_PREVIEWER, RUN_QUEUE, RUN_REPOSITORY } from "./domain/ports";
import { TypeOrmRunRepository } from "./infrastructure/persistence/typeorm-run.repository";
import { TypeOrmFlowHookRepository } from "./infrastructure/persistence/typeorm-flow-hook.repository";
import { FLOW_HOOK_REPOSITORY } from "./domain/flow-hooks";
import { FlowHookWaiter } from "./infrastructure/flow-hook-waiter";
import { InMemoryRunQueue } from "./infrastructure/queue/in-memory-queue";
import { RedisRunQueue } from "./infrastructure/queue/redis-queue";
import { CaseExecutor } from "./infrastructure/case-executor";
import { ExecutionContextFactory } from "./infrastructure/execution-context";
import { RequestPreviewer } from "./infrastructure/request-previewer";
import { RunOrchestrator } from "./infrastructure/run-orchestrator";
import { SCRIPT_SANDBOX } from "@/shared/scripts/script-sandbox";
import { ProcessScriptSandbox } from "@/shared/scripts/process-script-sandbox";
import {
  RunCaseProjector,
  RunCaseRetryingProjector,
  RunCaseStartedProjector,
  RunFinishedProjector,
  RunHookWaitingProjector,
  RunPausedProjector,
  RunProgressStream,
  RunResumedProjector,
  RunStartedProjector,
} from "./infrastructure/run-progress.stream";
import { RetentionScheduler } from "./infrastructure/retention.scheduler";
import { StartRunHandler } from "./application/commands/start-run";
import { PreviewRequestHandler } from "./application/commands/preview-request";
import { CancelRunHandler } from "./application/commands/cancel-run";
import { ResumeRunHandler } from "./application/commands/resume-run";
import { PruneRunsHandler } from "./application/commands/prune-runs";
import { DeliverFlowHookHandler } from "./application/commands/deliver-flow-hook";
import { GetRunCaseHandler, GetRunHandler, GetRunReportHandler, ListRunsHandler } from "./application/queries/get-run";
import { RunsController } from "./presentation/runs.controller";
import { RequestPreviewController } from "./presentation/request-preview.controller";
import { FlowHooksController } from "./presentation/flow-hooks.controller";

export const RUN_COMMAND_HANDLERS = [
  StartRunHandler,
  CancelRunHandler,
  ResumeRunHandler,
  PruneRunsHandler,
  PreviewRequestHandler,
  DeliverFlowHookHandler,
];
export const RUN_QUERY_HANDLERS = [ListRunsHandler, GetRunHandler, GetRunCaseHandler, GetRunReportHandler];
export const RUN_PROJECTORS = [
  RunStartedProjector,
  RunCaseStartedProjector,
  RunCaseProjector,
  RunCaseRetryingProjector,
  RunPausedProjector,
  RunResumedProjector,
  RunHookWaitingProjector,
  RunFinishedProjector,
];

/**
 * The queue adapter is chosen at boot from `QUEUE_DRIVER`.
 *
 * `memory` is the default and needs nothing installed, which is what keeps a local install to
 * "a Postgres and `pnpm dev`". `redis` is what a hosted instance wants: a run survives a restart
 * and several can proceed at once. Nothing above this line knows which one it got.
 */
export const RUN_QUEUE_PROVIDER = {
  provide: RUN_QUEUE,
  inject: [ENV, INSTANCE_BUS],
  useFactory: (env: Env, bus: InstanceBusPort) =>
    env.QUEUE_DRIVER === "redis"
      ? new RedisRunQueue(env.REDIS_URL ?? "redis://localhost:6379")
      : new InMemoryRunQueue(bus),
};

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([RunEntity, RunCaseEntity, RunStepEntity, FlowHookEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
    forwardRef(() => EnvironmentsModule),
    forwardRef(() => ProjectConfigModule),
    forwardRef(() => WorkflowsModule),
    forwardRef(() => ChannelsModule),
  ],
  controllers: [RunsController, RequestPreviewController, FlowHooksController],
  providers: [
    { provide: RUN_REPOSITORY, useClass: TypeOrmRunRepository },
    { provide: FLOW_HOOK_REPOSITORY, useClass: TypeOrmFlowHookRepository },
    FlowHookWaiter,
    RUN_QUEUE_PROVIDER,
    CaseExecutor,
    ExecutionContextFactory,
    { provide: REQUEST_PREVIEWER, useClass: RequestPreviewer },
    // A `validate` node runs its script in a process of its own, the same isolated sandbox the
    // endpoint scripts use. Provided here so the orchestrator can reach it.
    { provide: SCRIPT_SANDBOX, useClass: ProcessScriptSandbox },
    RunOrchestrator,
    RunProgressStream,
    RetentionScheduler,
    ...RUN_PROJECTORS,
    ...RUN_COMMAND_HANDLERS,
    ...RUN_QUERY_HANDLERS,
  ],
  exports: [RUN_REPOSITORY, RUN_QUEUE],
})
export class RunsModule implements OnApplicationBootstrap {
  constructor(private readonly orchestrator: RunOrchestrator) {}

  /**
   * The worker starts listening once the whole application is up.
   *
   * `OnApplicationBootstrap` and not `OnModuleInit`: the orchestrator reaches into four other
   * modules, and starting to consume before they are wired would mean the first run of a restart
   * fails on a dependency that was about to exist.
   */
  onApplicationBootstrap(): void {
    this.orchestrator.listen();
  }
}
