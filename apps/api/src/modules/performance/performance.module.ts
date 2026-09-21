import { Module, forwardRef, type OnApplicationBootstrap } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { PerformancePlanEntity, PerformanceRunEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EnvironmentsModule } from "@/modules/environments/environments.module";
import { SpecsModule } from "@/modules/specs/specs.module";
import { PERFORMANCE_PLAN_REPOSITORY, PERFORMANCE_RUN_QUEUE, PERFORMANCE_RUN_REPOSITORY } from "./domain/ports";
import {
  TypeOrmPerformancePlanRepository,
  TypeOrmPerformanceRunRepository,
} from "./infrastructure/persistence/typeorm-performance.repository";
import { InMemoryPerformanceRunQueue } from "./infrastructure/in-memory-performance-queue";
import { PerformanceExecutor } from "./infrastructure/performance-executor";
import { PerformanceProgressStream } from "./infrastructure/performance-progress.stream";
import {
  CreatePlanHandler,
  DeletePlanHandler,
  RestorePlanHandler,
  SetPlanArchivedHandler,
  UpdatePlanHandler,
} from "./application/commands/manage-plan";
import { CancelRunHandler, DeleteRunHandler, StartRunHandler } from "./application/commands/manage-run";
import {
  CompareRunsHandler,
  GetPlanHandler,
  GetRunHandler,
  ListPlansHandler,
  ListRunsHandler,
} from "./application/queries/read-performance";
import { PerformanceController } from "./presentation/performance.controller";

export const PERFORMANCE_COMMAND_HANDLERS = [
  CreatePlanHandler,
  UpdatePlanHandler,
  DeletePlanHandler,
  SetPlanArchivedHandler,
  RestorePlanHandler,
  StartRunHandler,
  CancelRunHandler,
  DeleteRunHandler,
];
export const PERFORMANCE_QUERY_HANDLERS = [
  ListPlansHandler,
  GetPlanHandler,
  ListRunsHandler,
  GetRunHandler,
  CompareRunsHandler,
];
export const PERFORMANCE_ADAPTERS = [
  { provide: PERFORMANCE_PLAN_REPOSITORY, useClass: TypeOrmPerformancePlanRepository },
  { provide: PERFORMANCE_RUN_REPOSITORY, useClass: TypeOrmPerformanceRunRepository },
  { provide: PERFORMANCE_RUN_QUEUE, useClass: InMemoryPerformanceRunQueue },
];
export const PERFORMANCE_SERVICES = [PerformanceProgressStream, PerformanceExecutor];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([PerformancePlanEntity, PerformanceRunEntity]),
    forwardRef(() => ProjectsModule),
    forwardRef(() => EnvironmentsModule),
    // SpecsModule exports SAFE_FETCH, the SSRF-guarded fetch every virtual user's request goes through.
    forwardRef(() => SpecsModule),
  ],
  controllers: [PerformanceController],
  providers: [
    ...PERFORMANCE_ADAPTERS,
    ...PERFORMANCE_SERVICES,
    ...PERFORMANCE_COMMAND_HANDLERS,
    ...PERFORMANCE_QUERY_HANDLERS,
  ],
  exports: [PERFORMANCE_RUN_REPOSITORY, PERFORMANCE_PLAN_REPOSITORY],
})
export class PerformanceModule implements OnApplicationBootstrap {
  constructor(private readonly executor: PerformanceExecutor) {}

  onApplicationBootstrap(): void {
    this.executor.listen();
  }
}
