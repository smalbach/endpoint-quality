"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const cqrs_1 = require("@nestjs/cqrs");
const throttler_1 = require("@nestjs/throttler");
const config_module_1 = require("./shared/config/config.module");
const database_module_1 = require("./shared/database/database.module");
const clock_port_1 = require("./shared/clock/clock.port");
const problem_details_filter_1 = require("./shared/errors/problem-details.filter");
const auth_module_1 = require("./modules/auth/auth.module");
const iam_module_1 = require("./modules/iam/iam.module");
const projects_module_1 = require("./modules/projects/projects.module");
const specs_module_1 = require("./modules/specs/specs.module");
const environments_module_1 = require("./modules/environments/environments.module");
const runs_module_1 = require("./modules/runs/runs.module");
const auth_guard_1 = require("./modules/auth/infrastructure/guards/auth.guard");
const health_controller_1 = require("./shared/health.controller");
/**
 * `AuthGuard` is registered globally and routes opt *out* with `@Public()`.
 *
 * The opposite arrangement — guard per controller — means a new controller is unprotected until
 * somebody remembers, and the failure is silent. This way a forgotten decorator closes a door
 * instead of leaving one open.
 */
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_module_1.ConfigModule,
            database_module_1.DatabaseModule,
            cqrs_1.CqrsModule.forRoot(),
            throttler_1.ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
            auth_module_1.AuthModule,
            iam_module_1.IamModule,
            projects_module_1.ProjectsModule,
            specs_module_1.SpecsModule,
            environments_module_1.EnvironmentsModule,
            runs_module_1.RunsModule,
        ],
        controllers: [health_controller_1.HealthController],
        providers: [
            { provide: clock_port_1.CLOCK, useClass: clock_port_1.SystemClock },
            { provide: core_1.APP_FILTER, useClass: problem_details_filter_1.ProblemDetailsFilter },
            { provide: core_1.APP_GUARD, useClass: throttler_1.ThrottlerGuard },
            { provide: core_1.APP_GUARD, useClass: auth_guard_1.AuthGuard },
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map