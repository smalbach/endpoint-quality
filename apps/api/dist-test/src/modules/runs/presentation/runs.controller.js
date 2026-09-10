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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunsController = void 0;
/**
 * Starting a run, following it, and reading it back.
 *
 * `POST /runs` answers **202 with an id** and nothing else: the matrix proceeds in a worker, so
 * the browser can close, the connection can drop, and a CI job can fire and forget. That is the
 * whole difference from the coupled dashboard, where the loop lived in a React component and the
 * run died with the tab.
 *
 * Launching a run is `editor`, and the environment decides whether it may write — the run itself
 * is not where that authority lives.
 */
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const throttler_1 = require("@nestjs/throttler");
const rxjs_1 = require("rxjs");
const auth_guard_1 = require("../../auth/infrastructure/guards/auth.guard");
const start_run_1 = require("../application/commands/start-run");
const cancel_run_1 = require("../application/commands/cancel-run");
const get_run_1 = require("../application/queries/get-run");
const run_progress_stream_1 = require("../infrastructure/run-progress.stream");
const runs_dto_1 = require("./dto/runs.dto");
let RunsController = class RunsController {
    commandBus;
    queryBus;
    progress;
    constructor(commandBus, queryBus, progress) {
        this.commandBus = commandBus;
        this.queryBus = queryBus;
        this.progress = progress;
    }
    async list(organizationId, projectId, limit) {
        return this.queryBus.execute(new get_run_1.ListRunsQuery(organizationId, projectId, Number(limit) || 25));
    }
    async start(organizationId, projectId, body, principal) {
        const triggeredBy = principal.kind === "user" ? { kind: "user", id: principal.userId } : { kind: "api-token", id: principal.tokenId };
        return this.commandBus.execute(new start_run_1.StartRunCommand(organizationId, projectId, body, triggeredBy));
    }
    async get(organizationId, projectId, runId) {
        return this.queryBus.execute(new get_run_1.GetRunQuery(organizationId, projectId, runId));
    }
    async getCase(organizationId, projectId, runId, caseId) {
        return this.queryBus.execute(new get_run_1.GetRunCaseQuery(organizationId, projectId, runId, caseId));
    }
    async cancel(organizationId, projectId, runId) {
        await this.commandBus.execute(new cancel_run_1.CancelRunCommand(organizationId, projectId, runId));
    }
    /**
     * Live progress.
     *
     * It opens with the run's **current state** rather than with the next event, so a client that
     * connects late — or reconnects — sees where things stand instead of waiting for the next case
     * to finish. The stream completes on its own when the run does, which is what tells the browser
     * to stop holding the connection.
     *
     * A client behind a proxy that buffers SSE can poll `GET /runs/:id` instead; the payload is the
     * same shape, which is deliberate.
     */
    stream(organizationId, projectId, runId) {
        // `from` and not `startWith`: the query returns a promise, and putting it straight into the
        // stream sends the *promise* — which serialises as `{}` and reaches the client as a snapshot
        // with zero totals while the case rows say otherwise. It has to be resolved first.
        const snapshot = (0, rxjs_1.from)(this.queryBus.execute(new get_run_1.GetRunQuery(organizationId, projectId, runId))).pipe((0, rxjs_1.map)((run) => ({ type: "snapshot", payload: { totals: run.totals } })));
        return (0, rxjs_1.concat)(snapshot, this.progress.forRun(runId)).pipe((0, rxjs_1.map)((event) => ({ type: event.type, data: event.payload })), 
        // `true` is emitted with the terminal event and then the stream ends, so the last thing a
        // follower receives is the finished run and not a silent disconnection.
        (0, rxjs_1.takeWhile)((event) => event.type !== "finished", true));
    }
};
exports.RunsController = RunsController;
__decorate([
    (0, common_1.Get)(),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Query)("limit")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], RunsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(202),
    (0, auth_guard_1.RequireRole)("editor"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, runs_dto_1.StartRunDto, Object]),
    __metadata("design:returntype", Promise)
], RunsController.prototype, "start", null);
__decorate([
    (0, common_1.Get)(":runId"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("runId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], RunsController.prototype, "get", null);
__decorate([
    (0, common_1.Get)(":runId/cases/:caseId"),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("runId")),
    __param(3, (0, common_1.Param)("caseId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], RunsController.prototype, "getCase", null);
__decorate([
    (0, common_1.Post)(":runId/cancel"),
    (0, common_1.HttpCode)(204),
    (0, auth_guard_1.RequireRole)("editor"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("runId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], RunsController.prototype, "cancel", null);
__decorate([
    (0, common_1.Sse)(":runId/stream")
    // A long-lived connection is not a request rate, and counting it as one creates a trap: when
    // the stream is refused the client falls back to polling, the polling spends the same budget,
    // and the stream can never reconnect. One follower holds one connection; the real limit on
    // this route is the number of open sockets, which is a different control.
    ,
    (0, throttler_1.SkipThrottle)(),
    (0, auth_guard_1.RequireRole)("viewer"),
    __param(0, (0, common_1.Param)("organizationId")),
    __param(1, (0, common_1.Param)("projectId")),
    __param(2, (0, common_1.Param)("runId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", rxjs_1.Observable)
], RunsController.prototype, "stream", null);
exports.RunsController = RunsController = __decorate([
    (0, common_1.Controller)("orgs/:organizationId/projects/:projectId/runs"),
    (0, common_1.UseGuards)(auth_guard_1.OrgRoleGuard),
    __metadata("design:paramtypes", [cqrs_1.CommandBus,
        cqrs_1.QueryBus,
        run_progress_stream_1.RunProgressStream])
], RunsController);
//# sourceMappingURL=runs.controller.js.map