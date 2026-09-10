import { Module, forwardRef, type OnApplicationBootstrap } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { RunCaseEntity, RunEntity, RunStepEntity } from "@/shared/database/entities";
import { ENV, type Env } from "@/shared/config/env";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { RUN_QUEUE, RUN_REPOSITORY } from "./domain/ports";
import { PROGRESS_RELAY } from "./domain/progress";
import { TypeOrmRunRepository } from "./infrastructure/persistence/typeorm-run.repository";
import { InMemoryRunQueue } from "./infrastructure/queue/in-memory-queue";
import { RedisRunQueue } from "./infrastructure/queue/redis-queue";
import { InProcessRelay } from "./infrastructure/progress/in-process-relay";
import { RedisProgressRelay } from "./infrastructure/progress/redis-relay";
import { CaseExecutor } from "./infrastructure/case-executor";
import { RunOrchestrator } from "./infrastructure/run-orchestrator";
import {
  RunCaseProjector,
  RunFinishedProjector,
  RunProgressStream,
  RunStartedProjector,
} from "./infrastructure/run-progress.stream";
import { RetentionScheduler } from "./infrastructure/retention.scheduler";
import { StartRunHandler } from "./application/commands/start-run";
import { CancelRunHandler } from "./application/commands/cancel-run";
import { PruneRunsHandler } from "./application/commands/prune-runs";
import { GetRunCaseHandler, GetRunHandler, GetRunReportHandler, ListRunsHandler } from "./application/queries/get-run";
import { RunsController } from "./presentation/runs.controller";

export const RUN_COMMAND_HANDLERS = [StartRunHandler, CancelRunHandler, PruneRunsHandler];
export const RUN_QUERY_HANDLERS = [ListRunsHandler, GetRunHandler, GetRunCaseHandler, GetRunReportHandler];
export const RUN_PROJECTORS = [RunStartedProjector, RunCaseProjector, RunFinishedProjector];

/**
 * The queue adapter is chosen at boot from `QUEUE_DRIVER`.
 *
 * `memory` is the default and needs nothing installed, which is what keeps a local install to
 * "a Postgres and `pnpm dev`". `redis` is what a hosted instance wants: a run survives a restart
 * and several can proceed at once. Nothing above this line knows which one it got.
 */
export const RUN_QUEUE_PROVIDER = {
  provide: RUN_QUEUE,
  inject: [ENV],
  useFactory: (env: Env) =>
    env.QUEUE_DRIVER === "redis"
      ? new RedisRunQueue(env.REDIS_URL ?? "redis://localhost:6379")
      : new InMemoryRunQueue(),
};

/**
 * Live progress crosses instances only when there is more than one, which is exactly what
 * `QUEUE_DRIVER=redis` says. The same switch, because the two facts are the same fact: a run is
 * executed by whichever instance took the job, and watched from whichever one the browser
 * reached.
 */
export const PROGRESS_RELAY_PROVIDER = {
  provide: PROGRESS_RELAY,
  inject: [ENV],
  useFactory: (env: Env) =>
    env.QUEUE_DRIVER === "redis"
      ? new RedisProgressRelay(env.REDIS_URL ?? "redis://localhost:6379")
      : new InProcessRelay(),
};

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([RunEntity, RunCaseEntity, RunStepEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => SpecsModule),
    forwardRef(() => EnvironmentsModule),
  ],
  controllers: [RunsController],
  providers: [
    { provide: RUN_REPOSITORY, useClass: TypeOrmRunRepository },
    RUN_QUEUE_PROVIDER,
    PROGRESS_RELAY_PROVIDER,
    CaseExecutor,
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
