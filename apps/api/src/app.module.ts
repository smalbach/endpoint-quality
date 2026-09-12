import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { CqrsModule } from "@nestjs/cqrs";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { ConfigModule } from "./shared/config/config.module";
import { SharedModule } from "./shared/shared.module";
import { DatabaseModule } from "./shared/database/database.module";
import { ProblemDetailsFilter } from "./shared/errors/problem-details.filter";
import { AuthModule } from "./modules/auth/auth.module";
import { IamModule } from "./modules/iam/iam.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { SpecsModule } from "./modules/specs/specs.module";
import { EnvironmentsModule } from "./modules/environments/environments.module";
import { ProjectConfigModule } from "./modules/config/config.module";
import { WorkflowsModule } from "./modules/workflows/workflows.module";
import { RunsModule } from "./modules/runs/runs.module";
import { EndpointsModule } from "./modules/endpoints/endpoints.module";
import { AuthGuard } from "./modules/auth/infrastructure/guards/auth.guard";
import { HealthController } from "./shared/health.controller";

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
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
    AuthModule,
    IamModule,
    ProjectsModule,
    SpecsModule,
    EnvironmentsModule,
    ProjectConfigModule,
    WorkflowsModule,
    RunsModule,
    EndpointsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
