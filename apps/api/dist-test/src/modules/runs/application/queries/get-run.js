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
exports.GetRunCaseHandler = exports.GetRunHandler = exports.ListRunsHandler = exports.GetRunCaseQuery = exports.GetRunQuery = exports.ListRunsQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../projects/domain/ports");
const update_project_1 = require("../../../projects/application/commands/update-project");
const ports_2 = require("../../domain/ports");
class ListRunsQuery {
    organizationId;
    projectId;
    limit;
    constructor(organizationId, projectId, limit = 25) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.limit = limit;
    }
}
exports.ListRunsQuery = ListRunsQuery;
class GetRunQuery {
    organizationId;
    projectId;
    runId;
    constructor(organizationId, projectId, runId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.runId = runId;
    }
}
exports.GetRunQuery = GetRunQuery;
class GetRunCaseQuery {
    organizationId;
    projectId;
    runId;
    caseId;
    constructor(organizationId, projectId, runId, caseId) {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.runId = runId;
        this.caseId = caseId;
    }
}
exports.GetRunCaseQuery = GetRunCaseQuery;
let ListRunsHandler = class ListRunsHandler {
    projects;
    runs;
    constructor(projects, runs) {
        this.projects = projects;
        this.runs = runs;
    }
    async execute(query) {
        const project = await (0, update_project_1.ownedProject)(this.projects, query.organizationId, query.projectId);
        return this.runs.listForProject(project.id, Math.min(100, Math.max(1, query.limit)));
    }
};
exports.ListRunsHandler = ListRunsHandler;
exports.ListRunsHandler = ListRunsHandler = __decorate([
    (0, cqrs_1.QueryHandler)(ListRunsQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.RUN_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], ListRunsHandler);
/**
 * A run with its case list, but **without the steps**.
 *
 * The steps hold full response bodies — a 311-case run is close to a thousand of them — and the
 * run view is what the progress screen polls. Shipping every body to render a list of green and
 * red rows would make the page slower the more there is to show.
 */
let GetRunHandler = class GetRunHandler {
    projects;
    runs;
    constructor(projects, runs) {
        this.projects = projects;
        this.runs = runs;
    }
    async execute(query) {
        const project = await (0, update_project_1.ownedProject)(this.projects, query.organizationId, query.projectId);
        const run = await this.runs.findById(query.runId);
        if (!run || run.projectId !== project.id)
            throw new domain_error_1.NotFoundError("La corrida no existe", "run-not-found");
        return { ...run, cases: await this.runs.listCases(run.id) };
    }
};
exports.GetRunHandler = GetRunHandler;
exports.GetRunHandler = GetRunHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetRunQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.RUN_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], GetRunHandler);
/** One case with everything it did: the request as sent, the response as received, and every
 * assertion. This is the evidence view, and it is fetched one case at a time. */
let GetRunCaseHandler = class GetRunCaseHandler {
    projects;
    runs;
    constructor(projects, runs) {
        this.projects = projects;
        this.runs = runs;
    }
    async execute(query) {
        const project = await (0, update_project_1.ownedProject)(this.projects, query.organizationId, query.projectId);
        const run = await this.runs.findById(query.runId);
        if (!run || run.projectId !== project.id)
            throw new domain_error_1.NotFoundError("La corrida no existe", "run-not-found");
        const runCase = await this.runs.findCase(query.caseId);
        if (!runCase || runCase.runId !== run.id)
            throw new domain_error_1.NotFoundError("El caso no existe", "run-case-not-found");
        return { ...runCase, steps: await this.runs.listSteps(runCase.id) };
    }
};
exports.GetRunCaseHandler = GetRunCaseHandler;
exports.GetRunCaseHandler = GetRunCaseHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetRunCaseQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.RUN_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object])
], GetRunCaseHandler);
//# sourceMappingURL=get-run.js.map