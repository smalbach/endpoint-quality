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
var RunOrchestrator_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunOrchestrator = void 0;
/**
 * The loop that walks a matrix, moved off the browser.
 *
 * In the coupled dashboard this was an `async` loop inside a React component: closing the tab
 * aborted the run halfway through, and a run launched from CI was not a thing that could exist.
 * Here the browser is an observer. A run started from the UI and one started from a pipeline are
 * the same row being walked by the same worker.
 *
 * Four decisions that are load-bearing:
 *
 * - **The live document is fetched once, at the start.** Re-reading it per case would mean the
 *   last case asserting against a contract the first one never saw — which is the exact drift
 *   this product exists to detect, so it cannot also be how it operates.
 * - **Cancellation is checked between cases, never inside one.** Stopping mid-flow would leave a
 *   created resource with no cleanup step, and the next run would open with a 409 that reports
 *   the interruption rather than the endpoint.
 * - **Totals are recomputed from the rows**, not incremented in memory, so a worker that restarts
 *   does not lose the count.
 * - **Every case is persisted as it finishes**, not batched at the end. A run that dies after 200
 *   cases has 200 results, and the UI following along has something to show.
 */
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const cqrs_1 = require("@nestjs/cqrs");
const runner_core_1 = require("@eq/runner-core");
const clock_port_1 = require("../../../shared/clock/clock.port");
const safe_fetch_1 = require("../../../shared/http/safe-fetch");
const ports_1 = require("../../projects/domain/ports");
const ports_2 = require("../../specs/domain/ports");
const ports_3 = require("../../environments/domain/ports");
const ports_4 = require("../../config/domain/ports");
const get_project_config_1 = require("../../config/application/queries/get-project-config");
const model_1 = require("../domain/model");
const ports_5 = require("../domain/ports");
const case_executor_1 = require("./case-executor");
const run_events_1 = require("../application/events/run.events");
let RunOrchestrator = RunOrchestrator_1 = class RunOrchestrator {
    runs;
    queue;
    projects;
    specs;
    environments;
    config;
    clock;
    http;
    executor;
    eventBus;
    logger = new common_1.Logger(RunOrchestrator_1.name);
    constructor(runs, queue, projects, specs, environments, config, clock, http, executor, eventBus) {
        this.runs = runs;
        this.queue = queue;
        this.projects = projects;
        this.specs = specs;
        this.environments = environments;
        this.config = config;
        this.clock = clock;
        this.http = http;
        this.executor = executor;
        this.eventBus = eventBus;
    }
    /** Wired at boot by the module. Kept separate from the constructor so the handler is
     * registered once, not once per injection. */
    listen() {
        this.queue.process((runId) => this.execute(runId));
    }
    async execute(runId) {
        const run = await this.runs.findById(runId);
        if (!run)
            return;
        try {
            const context = await this.prepare(run);
            await this.walk(run, context);
        }
        catch (error) {
            // A run that cannot be set up — no environment, an unreadable contract — is `error` and not
            // `failed`: nothing was measured, and reporting it as a failing matrix would be a finding
            // about an API nobody tested.
            const message = error instanceof Error ? error.message : "La corrida no pudo ejecutarse";
            this.logger.error(`Corrida ${runId}: ${message}`);
            await this.runs.updateStatus(runId, "error", this.clock.now(), message);
            this.eventBus.publish(new run_events_1.RunFinishedEvent(run.projectId, runId, "error", await this.runs.recomputeTotals(runId)));
        }
    }
    async prepare(run) {
        const project = await this.projects.findById(run.projectId);
        if (!project)
            throw new Error("El proyecto ya no existe");
        const environment = run.environmentId ? await this.environments.findById(run.environmentId) : null;
        if (!environment)
            throw new Error("La corrida necesita un entorno con URL base");
        const stored = await this.specs.listOperations(run.specVersionId);
        if (stored.length === 0)
            throw new Error("La versión del contrato no tiene operaciones");
        const config = await (0, get_project_config_1.assembleProjectConfig)(this.config, project.id);
        const operations = stored.map(({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation);
        const resolved = (0, runner_core_1.resolveOperations)(operations, config);
        const target = {
            baseUrl: environment.baseUrl,
            writesAllowed: environment.writesAllowed,
            credentials: await this.environments.listCredentials(environment.id),
            ...(await this.loadSpec(environment.specUrl ?? `${environment.baseUrl}/openapi.json`)),
        };
        return { config, resolved, target, authEnabled: environment.authEnforced };
    }
    /**
     * The document the schema assertion reads, fetched once.
     *
     * A failure here is **not** fatal: the run continues and every case falls back to the envelope
     * check, saying so in its detail. A target that does not publish its contract is worth testing
     * with what is available rather than not at all — and the operator is told which assertion
     * they are not getting.
     */
    async loadSpec(specUrl) {
        try {
            const response = await this.http.get(specUrl);
            if (response.status >= 400)
                return { spec: null, specError: `El contrato en vivo respondió ${response.status}` };
            const parsed = JSON.parse(response.body);
            // Dereferenced once for the whole run: resolving `$ref` per case over a 3 000-line document
            // is the same work done 311 times.
            return { spec: (0, runner_core_1.dereference)(parsed, parsed), specError: null };
        }
        catch (error) {
            return { spec: null, specError: error instanceof Error ? error.message : "No se pudo leer el contrato en vivo" };
        }
    }
    async walk(run, context) {
        const queue = (0, runner_core_1.buildQueue)(context.resolved, context.config, {
            mode: run.plan.order,
            customOrder: run.plan.customOrder,
            ...(run.plan.operationIds.length ? { operationIds: run.plan.operationIds } : {}),
            caseSelection: run.plan.caseSelection,
            authEnabled: context.authEnabled,
        });
        const cases = queue.map((item, position) => ({
            id: (0, node_crypto_1.randomUUID)(),
            runId: run.id,
            operationId: item.operation.id,
            scenarioId: item.scenario.id,
            method: item.operation.method,
            path: item.operation.path,
            status: "queued",
            position,
            durationMs: null,
            startedAt: null,
            finishedAt: null,
        }));
        await this.runs.saveCases(cases);
        await this.runs.updateStatus(run.id, "running", this.clock.now());
        this.eventBus.publish(new run_events_1.RunStartedEvent(run.projectId, run.id, cases.length));
        let cancelled = false;
        for (const [index, item] of queue.entries()) {
            const runCase = cases[index];
            if (await this.queue.isCancelled(run.id)) {
                cancelled = true;
                break;
            }
            // Between cases, never inside one: a pause in the middle of a create-read would leave the
            // created row without its cleanup step.
            if (index > 0 && run.plan.delayMs > 0)
                await delay(run.plan.delayMs);
            const startedAt = this.clock.now();
            await this.runs.saveCase({ ...runCase, status: "running", startedAt });
            const executed = await this.executor.run({
                operation: item.operation,
                scenario: item.scenario,
                operations: context.resolved,
                config: context.config,
                target: context.target,
                samples: run.plan.samples,
            });
            const steps = executed.steps.map((step) => ({
                id: (0, node_crypto_1.randomUUID)(),
                runCaseId: runCase.id,
                index: step.request.index,
                purpose: step.request.purpose,
                label: step.request.label,
                request: step.sent,
                expected: { status: step.request.expectedStatus, shape: step.request.expectedShape, operationPath: step.request.operationPath },
                actual: step.actual,
                assertions: step.assertions,
                latency: step.latency,
                ok: step.ok,
                durationMs: step.durationMs,
            }));
            await this.runs.saveSteps(steps);
            const finishedAt = this.clock.now();
            // A case with no steps ran nothing — the environment refused every request in it — and is
            // `skipped`, not `failed`. Reporting it as a finding would train people to ignore red.
            const status = executed.steps.length === 0 ? "skipped" : executed.ok ? "passed" : "failed";
            const finished = { ...runCase, status, startedAt, finishedAt, durationMs: executed.durationMs };
            await this.runs.saveCase(finished);
            // Published per case so a follower sees progress rather than a result at the end.
            this.eventBus.publish(new run_events_1.RunCaseFinishedEvent(run.projectId, run.id, finished, await this.runs.recomputeTotals(run.id)));
        }
        const totals = await this.runs.recomputeTotals(run.id);
        const status = cancelled ? "cancelled" : (0, model_1.verdictFor)(totals);
        await this.runs.updateStatus(run.id, status, this.clock.now());
        this.eventBus.publish(new run_events_1.RunFinishedEvent(run.projectId, run.id, status, totals));
    }
};
exports.RunOrchestrator = RunOrchestrator;
exports.RunOrchestrator = RunOrchestrator = RunOrchestrator_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(ports_5.RUN_REPOSITORY)),
    __param(1, (0, common_1.Inject)(ports_5.RUN_QUEUE)),
    __param(2, (0, common_1.Inject)(ports_1.PROJECT_REPOSITORY)),
    __param(3, (0, common_1.Inject)(ports_2.SPEC_REPOSITORY)),
    __param(4, (0, common_1.Inject)(ports_3.ENVIRONMENT_REPOSITORY)),
    __param(5, (0, common_1.Inject)(ports_4.CONFIG_REPOSITORY)),
    __param(6, (0, common_1.Inject)(clock_port_1.CLOCK)),
    __param(7, (0, common_1.Inject)(safe_fetch_1.SAFE_FETCH)),
    __metadata("design:paramtypes", [Object, Object, Object, Object, Object, Object, Object, Object, case_executor_1.CaseExecutor,
        cqrs_1.EventBus])
], RunOrchestrator);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
//# sourceMappingURL=run-orchestrator.js.map