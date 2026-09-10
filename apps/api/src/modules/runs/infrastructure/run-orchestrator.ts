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
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { EventBus } from "@nestjs/cqrs";
import {
  buildQueue,
  dereference,
  resolveOperations,
  type Operation,
  type ProjectConfig,
  type ResolvedOperation,
} from "@eq/runner-core";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import { assembleProjectConfig } from "@/modules/config/application/queries/get-project-config";
import { verdictFor, type Run, type RunCase, type RunStep } from "../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../domain/ports";
import { CaseExecutor, type ExecutionTarget } from "./case-executor";
import { RunCaseFinishedEvent, RunFinishedEvent, RunStartedEvent } from "../application/events/run.events";

@Injectable()
export class RunOrchestrator {
  private readonly logger = new Logger(RunOrchestrator.name);

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    private readonly executor: CaseExecutor,
    private readonly eventBus: EventBus,
  ) {}

  /** Wired at boot by the module. Kept separate from the constructor so the handler is
   * registered once, not once per injection. */
  listen(): void {
    this.queue.process((runId) => this.execute(runId));
  }

  async execute(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run) return;

    try {
      const context = await this.prepare(run);
      await this.walk(run, context);
    } catch (error) {
      // A run that cannot be set up — no environment, an unreadable contract — is `error` and not
      // `failed`: nothing was measured, and reporting it as a failing matrix would be a finding
      // about an API nobody tested.
      const message = error instanceof Error ? error.message : "La corrida no pudo ejecutarse";
      this.logger.error(`Corrida ${runId}: ${message}`);
      await this.runs.updateStatus(runId, "error", this.clock.now(), message);
      this.eventBus.publish(new RunFinishedEvent(run.projectId, runId, "error", await this.runs.recomputeTotals(runId)));
    }
  }

  private async prepare(run: Run) {
    const project = await this.projects.findById(run.projectId);
    if (!project) throw new Error("El proyecto ya no existe");

    const environment = run.environmentId ? await this.environments.findById(run.environmentId) : null;
    if (!environment) throw new Error("La corrida necesita un entorno con URL base");

    const stored = await this.specs.listOperations(run.specVersionId);
    if (stored.length === 0) throw new Error("La versión del contrato no tiene operaciones");

    const config = await assembleProjectConfig(this.config, project.id);
    const operations: Operation[] = stored.map(({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation);
    const resolved = resolveOperations(operations, config);

    const target: ExecutionTarget = {
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
  private async loadSpec(specUrl: string): Promise<{ spec: Record<string, unknown> | null; specError: string | null }> {
    try {
      const response = await this.http.get(specUrl);
      if (response.status >= 400) return { spec: null, specError: `El contrato en vivo respondió ${response.status}` };
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      // Dereferenced once for the whole run: resolving `$ref` per case over a 3 000-line document
      // is the same work done 311 times.
      return { spec: dereference(parsed, parsed) as Record<string, unknown>, specError: null };
    } catch (error) {
      return { spec: null, specError: error instanceof Error ? error.message : "No se pudo leer el contrato en vivo" };
    }
  }

  private async walk(
    run: Run,
    context: { config: ProjectConfig; resolved: ResolvedOperation[]; target: ExecutionTarget; authEnabled: boolean },
  ): Promise<void> {
    const queue = buildQueue(context.resolved, context.config, {
      mode: run.plan.order,
      customOrder: run.plan.customOrder,
      ...(run.plan.operationIds.length ? { operationIds: run.plan.operationIds } : {}),
      caseSelection: run.plan.caseSelection,
      authEnabled: context.authEnabled,
    });

    const cases: RunCase[] = queue.map((item, position) => ({
      id: randomUUID(),
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
    this.eventBus.publish(new RunStartedEvent(run.projectId, run.id, cases.length));

    let cancelled = false;
    for (const [index, item] of queue.entries()) {
      const runCase = cases[index];
      if (await this.queue.isCancelled(run.id)) {
        cancelled = true;
        break;
      }

      // Between cases, never inside one: a pause in the middle of a create-read would leave the
      // created row without its cleanup step.
      if (index > 0 && run.plan.delayMs > 0) await delay(run.plan.delayMs);

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

      const steps: RunStep[] = executed.steps.map((step) => ({
        id: randomUUID(),
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
      const finished: RunCase = { ...runCase, status, startedAt, finishedAt, durationMs: executed.durationMs };
      await this.runs.saveCase(finished);

      // Published per case so a follower sees progress rather than a result at the end.
      this.eventBus.publish(new RunCaseFinishedEvent(run.projectId, run.id, finished, await this.runs.recomputeTotals(run.id)));
    }

    const totals = await this.runs.recomputeTotals(run.id);
    const status = cancelled ? "cancelled" : verdictFor(totals);
    await this.runs.updateStatus(run.id, status, this.clock.now());
    this.eventBus.publish(new RunFinishedEvent(run.projectId, run.id, status, totals));
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
