"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunsModule = exports.RUN_QUEUE_PROVIDER = exports.RUN_PROJECTORS = exports.RUN_QUERY_HANDLERS = exports.RUN_COMMAND_HANDLERS = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const typeorm_1 = require("@nestjs/typeorm");
const entities_1 = require("../../shared/database/entities");
const env_1 = require("../../shared/config/env");
const auth_module_1 = require("../auth/auth.module");
const iam_module_1 = require("../iam/iam.module");
const projects_module_1 = require("../projects/projects.module");
const specs_module_1 = require("../specs/specs.module");
const environments_module_1 = require("../environments/environments.module");
const ports_1 = require("./domain/ports");
const typeorm_run_repository_1 = require("./infrastructure/persistence/typeorm-run.repository");
const in_memory_queue_1 = require("./infrastructure/queue/in-memory-queue");
const redis_queue_1 = require("./infrastructure/queue/redis-queue");
const case_executor_1 = require("./infrastructure/case-executor");
const run_orchestrator_1 = require("./infrastructure/run-orchestrator");
const run_progress_stream_1 = require("./infrastructure/run-progress.stream");
const start_run_1 = require("./application/commands/start-run");
const cancel_run_1 = require("./application/commands/cancel-run");
const get_run_1 = require("./application/queries/get-run");
const runs_controller_1 = require("./presentation/runs.controller");
exports.RUN_COMMAND_HANDLERS = [start_run_1.StartRunHandler, cancel_run_1.CancelRunHandler];
exports.RUN_QUERY_HANDLERS = [get_run_1.ListRunsHandler, get_run_1.GetRunHandler, get_run_1.GetRunCaseHandler];
exports.RUN_PROJECTORS = [run_progress_stream_1.RunStartedProjector, run_progress_stream_1.RunCaseProjector, run_progress_stream_1.RunFinishedProjector];
/**
 * The queue adapter is chosen at boot from `QUEUE_DRIVER`.
 *
 * `memory` is the default and needs nothing installed, which is what keeps a local install to
 * "a Postgres and `pnpm dev`". `redis` is what a hosted instance wants: a run survives a restart
 * and several can proceed at once. Nothing above this line knows which one it got.
 */
exports.RUN_QUEUE_PROVIDER = {
    provide: ports_1.RUN_QUEUE,
    inject: [env_1.ENV],
    useFactory: (env) => (env.QUEUE_DRIVER === "redis" ? new redis_queue_1.RedisRunQueue(env.REDIS_URL ?? "redis://localhost:6379") : new in_memory_queue_1.InMemoryRunQueue()),
};
let RunsModule = class RunsModule {
    orchestrator;
    constructor(orchestrator) {
        this.orchestrator = orchestrator;
    }
    /**
     * The worker starts listening once the whole application is up.
     *
     * `OnApplicationBootstrap` and not `OnModuleInit`: the orchestrator reaches into four other
     * modules, and starting to consume before they are wired would mean the first run of a restart
     * fails on a dependency that was about to exist.
     */
    onApplicationBootstrap() {
        this.orchestrator.listen();
    }
};
exports.RunsModule = RunsModule;
exports.RunsModule = RunsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            cqrs_1.CqrsModule,
            auth_module_1.AuthModule,
            iam_module_1.IamModule,
            typeorm_1.TypeOrmModule.forFeature([entities_1.RunEntity, entities_1.RunCaseEntity, entities_1.RunStepEntity]),
            (0, common_1.forwardRef)(() => projects_module_1.ProjectsModule),
            (0, common_1.forwardRef)(() => specs_module_1.SpecsModule),
            (0, common_1.forwardRef)(() => environments_module_1.EnvironmentsModule),
        ],
        controllers: [runs_controller_1.RunsController],
        providers: [
            { provide: ports_1.RUN_REPOSITORY, useClass: typeorm_run_repository_1.TypeOrmRunRepository },
            exports.RUN_QUEUE_PROVIDER,
            case_executor_1.CaseExecutor,
            run_orchestrator_1.RunOrchestrator,
            run_progress_stream_1.RunProgressStream,
            ...exports.RUN_PROJECTORS,
            ...exports.RUN_COMMAND_HANDLERS,
            ...exports.RUN_QUERY_HANDLERS,
        ],
        exports: [ports_1.RUN_REPOSITORY, ports_1.RUN_QUEUE],
    }),
    __metadata("design:paramtypes", [run_orchestrator_1.RunOrchestrator])
], RunsModule);
//# sourceMappingURL=runs.module.js.map