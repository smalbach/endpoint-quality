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
exports.GetScenariosHandler = exports.GetScenariosQuery = void 0;
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const runner_core_1 = require("@eq/runner-core");
const domain_error_1 = require("../../../../shared/errors/domain-error");
const ports_1 = require("../../../projects/domain/ports");
const ports_2 = require("../../../specs/domain/ports");
const ports_3 = require("../../../environments/domain/ports");
const ports_4 = require("../../domain/ports");
const get_project_config_1 = require("./get-project-config");
class GetScenariosQuery {
    organizationId;
    projectId;
    environmentId;
    order;
    constructor(organizationId, projectId, 
    /** Which environment the matrix is built for. It decides whether the authorization cases are
     * included and which operations are allowed to run at all. */
    environmentId, order = "safe") {
        this.organizationId = organizationId;
        this.projectId = projectId;
        this.environmentId = environmentId;
        this.order = order;
    }
}
exports.GetScenariosQuery = GetScenariosQuery;
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * The matrix a project would run, assembled from rows.
 *
 * This is where the decoupling becomes visible: the operations come from an imported contract,
 * the fixtures and budgets from a project's configuration, the authorization switch from an
 * environment — and `@eq/runner-core`, which knows about none of them, turns the three into
 * cases. The coupled dashboard produced the same list from five modules of literals.
 *
 * A query and not a command: it changes nothing, and the front end calls it on every filter
 * change to preview what a run would do.
 */
let GetScenariosHandler = class GetScenariosHandler {
    projects;
    specs;
    environments;
    config;
    constructor(projects, specs, environments, config) {
        this.projects = projects;
        this.specs = specs;
        this.environments = environments;
        this.config = config;
    }
    async execute(query) {
        const project = await this.projects.findById(query.projectId);
        if (!project || project.organizationId !== query.organizationId)
            throw new domain_error_1.NotFoundError("El proyecto no existe", "project-not-found");
        if (!project.activeSpecVersionId)
            throw new domain_error_1.ConflictError("El proyecto todavía no tiene contrato importado", "no-active-spec");
        const version = await this.specs.findVersionById(project.activeSpecVersionId);
        if (!version)
            throw new domain_error_1.NotFoundError("La versión activa no existe", "spec-version-not-found");
        const environment = query.environmentId ? await this.environments.findById(query.environmentId) : null;
        if (query.environmentId && (!environment || environment.projectId !== project.id)) {
            throw new domain_error_1.NotFoundError("El entorno no existe", "environment-not-found");
        }
        const projectConfig = await (0, get_project_config_1.assembleProjectConfig)(this.config, project.id);
        const stored = await this.specs.listOperations(version.id);
        // The row key is dropped here: the engine keys everything by `operationId`, which is the
        // contract's own name and survives a re-import. Handing it `rowId` would tie every piece of
        // configuration to one snapshot.
        const operations = stored.map(({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation);
        const resolved = (0, runner_core_1.resolveOperations)(operations, projectConfig);
        // Without an environment the matrix shows what the contract declares, authorization cases
        // included. That is the honest answer to "what could be tested", as opposed to "what will
        // run tonight" — which is the question an environment answers.
        const authEnabled = environment ? environment.authEnforced : true;
        const writesAllowed = environment ? environment.writesAllowed : true;
        const operationViews = resolved.map((operation) => ({
            id: operation.id,
            method: operation.method,
            path: operation.path,
            tag: operation.tag,
            summary: operation.summary,
            implemented: operation.implemented,
            responseShape: operation.responseShape,
            scenarios: (0, runner_core_1.scenariosFor)(operation, projectConfig).map((scenario) => this.describe(operation, scenario, projectConfig, authEnabled, writesAllowed)),
        }));
        const queue = (0, runner_core_1.buildQueue)(resolved, projectConfig, { mode: query.order, authEnabled }).map((item) => ({
            operationId: item.operation.id,
            scenarioId: item.scenario.id,
        }));
        const cases = operationViews.reduce((sum, operation) => sum + operation.scenarios.length, 0);
        const runnable = operationViews.reduce((sum, operation) => sum + operation.scenarios.filter((scenario) => scenario.runnable).length, 0);
        return {
            specVersionId: version.id,
            contractVersion: version.contractVersion,
            environment: environment
                ? { id: environment.id, name: environment.name, baseUrl: environment.baseUrl, writesAllowed: environment.writesAllowed, authEnforced: environment.authEnforced }
                : null,
            operations: operationViews,
            queue,
            totals: { operations: operationViews.length, cases, runnable, blocked: cases - runnable },
        };
    }
    describe(operation, scenario, config, authEnabled, writesAllowed) {
        const requestPath = (0, runner_core_1.requestPathFor)(operation, config, scenario.parameters);
        const runnableHere = (0, runner_core_1.runnableScenarios)(operation, config, authEnabled).some((candidate) => candidate.id === scenario.id);
        // Two different reasons a case will not run tonight, kept apart because the fix is
        // different: one needs a backend started with authorization, the other needs somebody to
        // decide this target may be written to.
        const blockedReason = !runnableHere
            ? "El entorno no aplica autorización: los casos 401 y 403 fallarían por un motivo ajeno al endpoint"
            : !writesAllowed && !IDEMPOTENT.has(operation.method)
                ? "El entorno no permite escrituras"
                : undefined;
        return {
            ...scenario,
            requestPath,
            budget: (0, runner_core_1.budgetFor)(config, operation.method, operation.path, requestPath),
            runnable: blockedReason === undefined,
            ...(blockedReason ? { blockedReason } : {}),
        };
    }
};
exports.GetScenariosHandler = GetScenariosHandler;
exports.GetScenariosHandler = GetScenariosHandler = __decorate([
    (0, cqrs_1.QueryHandler)(GetScenariosQuery),
    __param(0, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __param(2, (0, common_1.Inject)(ports_3.ENVIRONMENT_REPOSITORY)),
    __param(3, (0, common_1.Inject)(ports_4.CONFIG_REPOSITORY)),
    __metadata("design:paramtypes", [Object, Object, Object, Object])
], GetScenariosHandler);
//# sourceMappingURL=get-scenarios.js.map