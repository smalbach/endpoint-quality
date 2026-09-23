import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { CqrsModule } from "@nestjs/cqrs";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { ConfigModule } from "./shared/config/config.module";
import { SharedModule } from "./shared/shared.module";
import { DatabaseModule } from "./shared/database/database.module";
import { ProblemDetailsFilter } from "./shared/errors/problem-details.filter";
import { OperationLogInterceptor } from "./shared/logging/operation.interceptor";
import { AuthModule } from "./modules/auth/auth.module";
import { IamModule } from "./modules/iam/iam.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { SpecsModule } from "./modules/specs/specs.module";
import { EnvironmentsModule } from "./modules/environments/environments.module";
import { ProjectConfigModule } from "./modules/config/config.module";
import { WorkflowsModule } from "./modules/workflows/workflows.module";
import { RunsModule } from "./modules/runs/runs.module";
import { EndpointsModule } from "./modules/endpoints/endpoints.module";
import { MocksModule } from "./modules/mocks/mocks.module";
import { DocsModule } from "./modules/docs/docs.module";
import { MonitorsModule } from "./modules/monitors/monitors.module";
import { ChannelsModule } from "./modules/channels/channels.module";
import { CapturesModule } from "./modules/captures/captures.module";
import { RolesModule } from "./modules/roles/roles.module";
import { SecurityRunsModule } from "./modules/security-runs/security-runs.module";
import { PerformanceModule } from "./modules/performance/performance.module";
import { CollectionsModule } from "./modules/collections/collections.module";
import { CodeScanModule } from "./modules/code-scan/code-scan.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { AuthGuard } from "./modules/auth/infrastructure/guards/auth.guard";
import { HealthController } from "./shared/health.controller";
import { BackendController } from "./shared/backend.controller";
import { RATE_LIMIT_STORE, type RateLimitStorePort } from "./shared/rate-limit/rate-limit-store";
import { throttlerOptions } from "./shared/rate-limit/shared-throttler-storage";

/**
 * `AuthGuard` is registered globally and routes opt *out* with `@Public()`.
 *
 * The opposite arrangement — guard per controller — means a new controller is unprotected until
 * somebody remembers, and the failure is silent. This way a forgotten decorator closes a door
 * instead of leaving one open.
 */
@Module({
  imports: [
    ConfigModule,
    SharedModule,
    DatabaseModule,
    CqrsModule.forRoot(),
    // Los contadores, donde los cuenten todas las réplicas (ver `shared-throttler-storage.ts`).
    ThrottlerModule.forRootAsync({
      inject: [RATE_LIMIT_STORE],
      useFactory: (store: RateLimitStorePort) => throttlerOptions(store),
    }),
    AuthModule,
    IamModule,
    ProjectsModule,
    SpecsModule,
    EnvironmentsModule,
    ProjectConfigModule,
    WorkflowsModule,
    RunsModule,
    EndpointsModule,
    MocksModule,
    DocsModule,
    MonitorsModule,
    ChannelsModule,
    CapturesModule,
    RolesModule,
    SecurityRunsModule,
    PerformanceModule,
    CollectionsModule,
    CodeScanModule,
    DashboardModule,
  ],
  controllers: [HealthController, BackendController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    // Una línea por operación atendida, con su coste. Antes de los guardias en la lista y por
    // tanto por fuera de ellos: una petición que un guardia niega también es una operación que
    // ocurrió, y es de las que más se preguntan.
    { provide: APP_INTERCEPTOR, useClass: OperationLogInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
