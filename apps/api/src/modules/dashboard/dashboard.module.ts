import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";

import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { RunsModule } from "@/modules/runs/runs.module";
import { SecurityRunsModule } from "@/modules/security-runs/security-runs.module";
import { PerformanceModule } from "@/modules/performance/performance.module";
import { WorkflowsModule } from "@/modules/workflows/workflows.module";
import { CodeScanModule } from "@/modules/code-scan/code-scan.module";
import { GetDashboardHandler } from "./application/queries/get-dashboard";
import { GetHistoryHandler } from "./application/queries/get-history";
import { DashboardController } from "./presentation/dashboard.controller";

export const DASHBOARD_QUERY_HANDLERS = [GetDashboardHandler, GetHistoryHandler];

/**
 * A read-only module that reaches into the others' repositories to aggregate them.
 *
 * It imports the feature modules for their exported repository tokens; everything here is a query.
 * The alternative — each feature module contributing to a shared summary — would couple them to a
 * dashboard none of them should know exists.
 */
@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    forwardRef(() => ProjectsModule),
    forwardRef(() => EndpointsModule),
    forwardRef(() => RunsModule),
    forwardRef(() => SecurityRunsModule),
    forwardRef(() => PerformanceModule),
    forwardRef(() => WorkflowsModule),
    forwardRef(() => CodeScanModule),
  ],
  controllers: [DashboardController],
  providers: [...DASHBOARD_QUERY_HANDLERS],
})
export class DashboardModule {}
