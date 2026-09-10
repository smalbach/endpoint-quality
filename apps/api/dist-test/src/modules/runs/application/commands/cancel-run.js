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
exports.CancelRunHandler = exports.CancelRunCommand = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const model_1 = require("../../domain/model");
const ports_2 = require("../../domain/ports");
class CancelRunCommand {
    organizationId;
    projectId;
    runId;
    constructor(organizationId, projectId, runId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.runId = runId;
    }
}
exports.CancelRunCommand = CancelRunCommand;
/**
 * Asks the worker to stop at the next case boundary.
 *
 * Not mid-case, deliberately: a `create-read` interrupted between the POST and the DELETE leaves
 * a row behind, and the next run of that case opens with a 409 that reports the cancellation
 * rather than the endpoint. Finishing the case in flight costs seconds and keeps the fixtures
 * clean.
 */
let CancelRunHandler = class CancelRunHandler {
    projects;
    runs;
    queue;
    constructor(projects, runs, queue) {
        this.projects = projects;
        this.runs = runs;
        this.queue = queue;
    }
    async execute(command) {
        await (0, update_project_1.ownedProject)(this.projects, command.organizationId, command.projectId);
        const run = await this.runs.findById(command.runId);
        if (!run || run.projectId !== command.projectId)
            throw new domain_error_1.NotFoundError("La corrida no existe", "run-not-found");
        if ((0, model_1.isFinished)(run.status))
            throw new domain_error_1.ConflictError("La corrida ya terminó", "run-finished");
        await this.queue.cancel(run.id);
    }
};
exports.CancelRunHandler = CancelRunHandler;
exports.CancelRunHandler = CancelRunHandler = __decorate([
    (0, cqrs_1.CommandHandler)(CancelRunCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.RUN_REPOSITORY)),
    __param(2, (0, common_1.Inject)(ports_2.RUN_QUEUE)),
    __metadata("design:paramtypes", [Object, Object, Object])
], CancelRunHandler);
//# sourceMappingURL=cancel-run.js.map