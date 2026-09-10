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
exports.StartRunHandler = exports.StartRunCommand = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const clock_port_1 = require("../../../../shared/clock/clock.port");
const ports_1 = require("../../../projects/domain/ports");
const ports_2 = require("../../../environments/domain/ports");
const ports_3 = require("../../domain/ports");
class StartRunCommand {
    organizationId;
    projectId;
    input;
    triggeredBy;
    constructor(organizationId, projectId, input, triggeredBy) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.input = input;
        this.triggeredBy = triggeredBy;
    }
}
exports.StartRunCommand = StartRunCommand;
/**
 * Records the run and hands it to the queue. It does **not** execute anything.
 *
 * That is the whole point of the phase: the caller gets a 202 and an id immediately, and the
 * matrix proceeds in a worker. Closing the browser, losing the connection or a CI job that fires
 * and forgets all leave the run running — none of which was possible when the loop lived in a
 * React component.
 */
let StartRunHandler = class StartRunHandler {
    projects;
    environments;
    runs;
    queue;
    clock;
    constructor(projects, environments, runs, queue, clock) {
        this.projects = projects;
        this.environments = environments;
        this.runs = runs;
        this.queue = queue;
        this.clock = clock;
    }
    async execute(command) {
        const project = await this.projects.findById(command.projectId);
        if (!project || project.organizationId !== command.organizationId)
            throw new domain_error_1.NotFoundError("El proyecto no existe", "project-not-found");
        if (!project.activeSpecVersionId)
            throw new domain_error_1.ConflictError("El proyecto no tiene contrato importado", "no-active-spec");
        const environment = await this.environments.findById(command.input.environmentId);
        // Folded into the 404 as everywhere else: a 403 would confirm the id is real to somebody
        // outside the project.
        if (!environment || environment.projectId !== project.id)
            throw new domain_error_1.NotFoundError("El entorno no existe", "environment-not-found");
        const samples = clamp(command.input.samples ?? 1, 1, 50);
        const delayMs = clamp(command.input.delayMs ?? 0, 0, 30_000);
        if (!Number.isFinite(samples) || !Number.isFinite(delayMs))
            throw new domain_error_1.InvalidInputError("Plan de ejecución inválido");
        const plan = {
            // Reads first, deletes last, by default. Alphabetical order runs a DELETE before the GET
            // that would have shown the endpoint was already broken, and anything it destroys takes
            // the rest of the matrix with it.
            order: (command.input.order ?? "safe"),
            customOrder: command.input.customOrder ?? [],
            operationIds: command.input.operationIds ?? [],
            caseSelection: command.input.caseSelection ?? {},
            samples,
            delayMs,
        };
        const run = {
            id: (0, node_crypto_1.randomUUID)(),
            projectId: project.id,
            environmentId: environment.id,
            // The snapshot is pinned now. A run is only interpretable next to the contract it was
            // measured against, and activating a new version mid-run must not change what it asserted.
            specVersionId: project.activeSpecVersionId,
            status: "queued",
            plan,
            totals: { cases: 0, completed: 0, passed: 0, failed: 0, skipped: 0 },
            triggeredByKind: command.triggeredBy.kind,
            triggeredBy: command.triggeredBy.id,
            startedAt: this.clock.now(),
            finishedAt: null,
            error: null,
        };
        await this.runs.save(run);
        await this.queue.enqueue(run.id);
        return { runId: run.id };
    }
};
exports.StartRunHandler = StartRunHandler;
exports.StartRunHandler = StartRunHandler = __decorate([
    (0, cqrs_1.CommandHandler)(StartRunCommand),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.ENVIRONMENT_REPOSITORY)),
    __param(2, (0, common_1.Inject)(ports_3.RUN_REPOSITORY)),
    __param(3, (0, common_1.Inject)(ports_3.RUN_QUEUE)),
    __param(4, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object])
], StartRunHandler);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
//# sourceMappingURL=start-run.js.map