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
  applyCaptures,
  bindElement,
  evaluateChecks,
  holds,
  listAt,
  orderWorkflowSteps,
  withEnvironmentNamespace,
  type Operation,
  type ProjectConfig,
  type ActualResponse,
  type ResolvedOperation,
  type TestScenario,
  type WorkflowStep,
} from "@eq/runner-core";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { resolveVariables } from "@/modules/environments/domain/model";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import { assembleProjectConfig } from "@/modules/config/application/queries/get-project-config";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import type { RequestTemplateRow, WorkflowRow } from "@/modules/workflows/domain/model";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { caseStatusFor, verdictFor, type Run, type RunCase, type RunStep } from "../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../domain/ports";
import { CaseExecutor, type ExecutedCase, type ExecutedStep, type ExecutionTarget } from "./case-executor";
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
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
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
      this.eventBus.publish(
        new RunFinishedEvent(run.projectId, runId, "error", await this.runs.recomputeTotals(runId)),
      );
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
    const operations: Operation[] = stored.map(
      ({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation,
    );
    const resolved = resolveOperations(operations, config);

    const target: ExecutionTarget = {
      baseUrl: environment.baseUrl,
      writesAllowed: environment.writesAllowed,
      credentials: await this.environments.listCredentials(environment.id),
      // Resolved, not copied: `current` over `initial`, and a sensitive one decrypted here so that
      // nothing further down the run has to know the concept exists.
      variables: withEnvironmentNamespace(
        resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload)),
      ),
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
    if (run.plan.workflowId || run.plan.suiteId) {
      // Read with the project id, so a flow that belongs to another tenant is indistinguishable
      // from one that does not exist. `StartRunHandler` already refused these at 422; getting here
      // means the row was deleted between queueing and executing.
      const ids = run.plan.suiteId ? await this.suiteFlows(run) : [run.plan.workflowId as string];
      const flows: WorkflowRow[] = [];
      for (const id of ids) {
        const workflow = await this.workflows.findWorkflow(run.projectId, id);
        if (!workflow) throw new Error(`El flujo "${id}" ya no existe`);
        flows.push(workflow);
      }
      const templates = new Map(
        (await this.workflows.listTemplates(run.projectId)).map((template) => [template.id, template]),
      );
      await this.walkFlows(run, context, flows, templates, await this.datasetRows(run));
      return;
    }
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

      await this.runs.saveSteps(toRunSteps(runCase.id, executed.steps));

      const finishedAt = this.clock.now();
      const finished: RunCase = {
        ...runCase,
        status: caseStatusFor(executed),
        startedAt,
        finishedAt,
        durationMs: executed.durationMs,
      };
      await this.runs.saveCase(finished);
      // Published per case so a follower sees progress rather than a result at the end.
      await this.announce(run, finished);
    }

    await this.finish(run, cancelled);
  }

  /**
   * The list a step walks, or `null` when it does not walk one.
   *
   * A `forEach` whose path does not lead to an array is an empty walk and not an error. The step
   * it reads from has already answered and already been judged: if that answer is the wrong shape,
   * the case for *that* step is where it is reported, and failing this one too would be the same
   * finding counted twice.
   */
  private elementsFor(
    step: WorkflowStep,
    responses: Map<string, { actual: ActualResponse; durationMs: number }>,
  ): unknown[] | null {
    if (!step.forEach) return null;
    const source = responses.get(step.forEach.from);
    const list = source ? listAt(source.actual.body, step.forEach.path) : null;
    return (list ?? []).slice(0, step.forEach.max ?? 50);
  }

  /**
   * One step, its own checks, and the retries its author asked for.
   *
   * The checks run **inside** the retry loop, which is the point of having both: «the list
   * eventually contains the id I just created» is a claim about a target that is eventually
   * consistent, and a retry is the only way to state it. Judging the response and then deciding
   * whether to repeat is therefore one operation, not two.
   *
   * A retry that ends in a pass leaves a warning behind. It has to: the run's verdict is that the
   * endpoint works, and «it worked on the third try» is a different fact about the target that
   * would otherwise disappear into a green tick. It does not fail the case — the author asked for
   * the retries — and it is on the report where somebody can see the pattern across runs.
   */
  private async attempt(step: WorkflowStep, execute: () => Promise<ExecutedCase>): Promise<ExecutedCase> {
    const retry = step.retry;
    const attempts = Math.max(0, retry?.attempts ?? 0) + 1;
    let wait = retry?.delayMs ?? 0;
    let executed = await this.withChecks(step, await execute());

    for (let attempt = 2; attempt <= attempts && !executed.ok; attempt += 1) {
      // `onStatus` is what keeps a retry honest: a 500 may be worth repeating, a 422 never stops
      // being a 422. With no list, any failure is retried, which is the blunt version the author
      // opted into.
      const status = executed.steps.at(-1)?.actual?.status;
      if (retry?.onStatus?.length && (status === undefined || !retry.onStatus.includes(status))) break;
      if (wait > 0) await delay(wait);
      wait = Math.round(wait * (retry?.backoff ?? 1));
      executed = await this.withChecks(step, await execute());
      if (executed.ok) {
        const last = executed.steps.at(-1);
        last?.assertions.push({
          label: "Reintentado",
          pass: false,
          severity: "warning",
          detail: `Pasó en el intento ${attempt} de ${attempts}`,
        });
      }
    }
    return executed;
  }

  /** The author's own claims about the response, added to the ones derived from the contract. */
  private async withChecks(step: WorkflowStep, executed: ExecutedCase): Promise<ExecutedCase> {
    const last = executed.steps.at(-1);
    if (!step.checks?.length || !last?.actual) return executed;
    last.assertions.push(...evaluateChecks(step.checks, { response: last.actual, durationMs: last.durationMs }));
    last.ok = holds(last.assertions);
    return { ...executed, ok: executed.steps.every((item) => item.ok) };
  }

  /**
   * A user-authored graph instead of the generated matrix.
   *
   * Each step becomes an ordinary `RunCase`, so a flow is read, streamed and reported like any
   * other run. What is different is the edge: a step whose dependency did not pass is `skipped`
   * rather than attempted, because «create failed, therefore read failed» is one finding reported
   * twice.
   */
  /** The flows a suite names, in its order. The order is the content: a suite exists because those
   * flows have to run in that sequence. */
  private async suiteFlows(run: Run): Promise<string[]> {
    const suite = await this.workflows.findSuite(run.projectId, run.plan.suiteId as string);
    if (!suite) throw new Error(`La suite "${run.plan.suiteId}" ya no existe`);
    return suite.workflowIds;
  }

  /** The rows the flow is walked once per. `[null]` is «once, with no dataset», which keeps the
   * ordinary run and the data-driven one the same loop rather than two that can drift. */
  private async datasetRows(run: Run): Promise<(Record<string, string> | null)[]> {
    if (!run.plan.datasetId) return [null];
    const dataset = await this.workflows.findDataset(run.projectId, run.plan.datasetId);
    if (!dataset) throw new Error(`El conjunto de datos "${run.plan.datasetId}" ya no existe`);
    return dataset.rows;
  }

  /**
   * Every flow of the run, once per row of data, as one run with one verdict.
   *
   * The nesting is rows on the outside and flows on the inside, and that is a decision about
   * **what is shared with what**. A row is an independent walk: the variables are reset to the
   * environment's before it starts, so row 7 cannot pass because row 6 captured an id. The flows
   * *within* a row share them on purpose — a suite whose first flow logs in and whose next eight
   * spend the session is the reason suites exist, and isolating them would break exactly that.
   */
  private async walkFlows(
    run: Run,
    context: { config: ProjectConfig; resolved: ResolvedOperation[]; target: ExecutionTarget; authEnabled: boolean },
    flows: WorkflowRow[],
    templates: Map<string, RequestTemplateRow>,
    rows: (Record<string, string> | null)[],
  ): Promise<void> {
    let position = 0;
    const passes = rows.flatMap((row, rowIndex) =>
      flows.map((flow) => {
        // The suffix only appears when there is more than one row: `…:crear@0` on a run with no
        // dataset would be noise in every report that shows a scenario id.
        const items = this.prepareWorkflow(
          run,
          flow,
          templates,
          context.resolved,
          rows.length > 1 ? `@${rowIndex}` : "",
          position,
        );
        position += items.length;
        return { row, rowIndex, items };
      }),
    );

    await this.runs.saveCases(passes.flatMap((pass) => pass.items.map((item) => item.runCase)));
    await this.runs.updateStatus(run.id, "running", this.clock.now());
    // A lower bound rather than a count: a step that loops adds cases while the run is walking,
    // and the totals a follower shows are recomputed from the rows on every event anyway.
    this.eventBus.publish(new RunStartedEvent(run.projectId, run.id, position));

    const base = { ...context.target.variables };
    let cancelled = false;
    let walkedRow = -1;
    for (const pass of passes) {
      if (cancelled) break;
      if (pass.rowIndex !== walkedRow) {
        walkedRow = pass.rowIndex;
        // Rebuilt in place rather than reassigned: the executor holds this exact object.
        for (const key of Object.keys(context.target.variables)) delete context.target.variables[key];
        Object.assign(context.target.variables, base, datasetBindings(pass.row));
      }
      cancelled = await this.walkPrepared(run, context, pass.items);
    }

    await this.finish(run, cancelled);
  }

  private prepareWorkflow(
    run: Run,
    workflow: WorkflowRow,
    templates: Map<string, RequestTemplateRow>,
    resolved: ResolvedOperation[],
    suffix: string,
    offset: number,
  ) {
    const ordered = orderWorkflowSteps(workflow.definition, `El flujo "${workflow.name}"`);
    return ordered.map((step, position) => {
      const template = templates.get(step.requestTemplateId);
      if (!template)
        throw new Error(`El paso "${step.id}" referencia la prueba inexistente "${step.requestTemplateId}"`);
      const operation = resolved.find((candidate) => candidate.id === template.operationId);
      if (!operation) {
        throw new Error(`La prueba "${template.name}" referencia la operación inexistente "${template.operationId}"`);
      }
      return {
        step,
        template,
        operation,
        runCase: {
          id: randomUUID(),
          runId: run.id,
          operationId: operation.id,
          scenarioId: `workflow:${workflow.id}:${step.id}${suffix}`,
          method: operation.method,
          path: operation.path,
          status: "queued" as const,
          position: offset + position,
          durationMs: null,
          startedAt: null,
          finishedAt: null,
        } satisfies RunCase,
      };
    });
  }

  /** One walk of one graph. Returns whether the run was cancelled while it was walking. */
  private async walkPrepared(
    run: Run,
    context: { config: ProjectConfig; resolved: ResolvedOperation[]; target: ExecutionTarget; authEnabled: boolean },
    prepared: ReturnType<RunOrchestrator["prepareWorkflow"]>,
  ): Promise<boolean> {
    const passed = new Map<string, boolean>();
    // The last answer of each step, which is what a condition judges and a loop walks. Kept for
    // the duration of one run and never beyond it: two runs of the same flow must not be able to
    // read each other's responses, for the same reason their variables are a copy.
    const responses = new Map<string, { actual: ActualResponse; durationMs: number }>();
    // What a failed step lets through. `continue` is the step whose failure the rest does not
    // actually depend on — a cleanup that 404s because there was nothing to clean.
    const permissive = new Set(prepared.filter((item) => item.step.onError === "continue").map((item) => item.step.id));
    let cancelled = false;
    let stopped = false;
    for (const [index, item] of prepared.entries()) {
      if (await this.queue.isCancelled(run.id)) {
        cancelled = true;
        break;
      }
      if (index > 0 && run.plan.delayMs > 0) await delay(run.plan.delayMs);

      const startedAt = this.clock.now();
      if ((item.step.dependsOn ?? []).some((id) => passed.get(id) !== true && !permissive.has(id))) {
        const skipped: RunCase = {
          ...item.runCase,
          status: "skipped",
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
        };
        passed.set(item.step.id, false);
        await this.runs.saveCase(skipped);
        await this.announce(run, skipped);
        continue;
      }

      // A condition over what a dependency answered. The step is skipped, not failed: «no había
      // nada que borrar» is a flow behaving correctly, and a red case would say otherwise.
      const condition = item.step.runIf;
      if (condition) {
        const source = responses.get(condition.from);
        const [verdict] = source
          ? evaluateChecks([condition.check], { response: source.actual, durationMs: source.durationMs })
          : [{ label: "condición", pass: false, detail: `El paso ${condition.from} no respondió` }];
        if (!verdict.pass) {
          const skipped: RunCase = {
            ...item.runCase,
            status: "skipped",
            startedAt,
            finishedAt: startedAt,
            durationMs: 0,
          };
          // Skipped by a condition counts as «did not fail» for what depends on it: the flow did
          // what it was told, and marking its dependents skipped too would report a decision as a
          // problem.
          passed.set(item.step.id, true);
          await this.runs.saveCase(skipped);
          await this.announce(run, skipped);
          continue;
        }
      }

      // Not the same thing as a retry, and worth the second knob. A retry says «that failure was
      // not real»; this says «it was not time yet», which is the honest description of a target
      // that accepts a write and takes a moment to make it readable.
      if (item.step.waitMs) await delay(item.step.waitMs);

      const elements = this.elementsFor(item.step, responses);
      if (elements && elements.length === 0) {
        // A loop over nothing is not a failure and is not silence either: a case that says the
        // list was empty is what tells the next person the flow ran and had nothing to walk.
        const empty: RunCase = { ...item.runCase, status: "skipped", startedAt, finishedAt: startedAt, durationMs: 0 };
        passed.set(item.step.id, true);
        await this.runs.saveCase(empty);
        await this.announce(run, empty);
        continue;
      }

      // One case per element, each with its own request, response and verdict. «Los 40 productos
      // responden» is forty findings; one case hiding thirty-nine results is the report this
      // product replaces.
      const iterations = elements ?? [null];
      let allPassed = true;
      let status: RunCase["status"] = "passed";
      for (const [iteration, element] of iterations.entries()) {
        const runCase =
          elements === null
            ? item.runCase
            : {
                ...item.runCase,
                id: randomUUID(),
                scenarioId: `${item.runCase.scenarioId}#${iteration}`,
                position: item.runCase.position,
              };
        const boundAt = this.clock.now();
        if (elements !== null && item.step.forEach) {
          Object.assign(context.target.variables, bindElement(item.step.forEach.as, element));
        }

        await this.runs.saveCase({ ...runCase, status: "running", startedAt: boundAt });
        const executed = await this.attempt(item.step, () =>
          this.executor.run({
            operation: item.operation,
            scenario: scenarioFor(item.template),
            operations: context.resolved,
            config: context.config,
            target: context.target,
            samples: run.plan.samples,
          }),
        );

        // The capture is an assertion of its own, on the step that was supposed to yield the value.
        // Writing it into the variables without saying so would make the next case fail for a reason
        // recorded nowhere.
        //
        // After the retries and not inside them: a capture writes into the run's variables, and
        // doing that once per attempt would leave the value of a discarded attempt behind.
        const last = executed.steps.at(-1);
        if (last?.actual) responses.set(item.step.id, { actual: last.actual, durationMs: last.durationMs });
        if (last?.actual && item.step.captures?.length) {
          const capture = applyCaptures(item.step.captures, last.actual, context.target.variables, item.step.id);
          const ok = capture.missing.length === 0;
          last.assertions.push({
            label: "Variables capturadas",
            pass: ok,
            detail: ok ? capture.captured.join(", ") : `No se encontraron: ${capture.missing.join(", ")}`,
          });
          last.ok = last.ok && holds(last.assertions);
          executed.ok = executed.steps.every((step) => step.ok);
        }

        await this.runs.saveSteps(toRunSteps(runCase.id, executed.steps));
        status = caseStatusFor(executed);
        allPassed = allPassed && status === "passed";
        const finished: RunCase = {
          ...runCase,
          status,
          startedAt: boundAt,
          finishedAt: this.clock.now(),
          durationMs: executed.durationMs,
        };
        await this.runs.saveCase(finished);
        await this.announce(run, finished);
      }

      // A looped step passes when every element did. One product out of forty failing is the step
      // failing, and what depends on it has to know.
      passed.set(item.step.id, allPassed);
      if (!allPassed) status = "failed";

      // `stop` is for the step whose failure makes everything after it report something other than
      // what it is testing: with no session, every later 401 is the same fact restated. The rest
      // are marked skipped rather than left queued — a case with no verdict is not a result.
      if (!allPassed && item.step.onError === "stop") {
        stopped = true;
        break;
      }
    }

    if (stopped) {
      const done = new Set(passed.keys());
      for (const item of prepared) {
        if (done.has(item.step.id)) continue;
        const at = this.clock.now();
        const skipped: RunCase = { ...item.runCase, status: "skipped", startedAt: at, finishedAt: at, durationMs: 0 };
        await this.runs.saveCase(skipped);
        await this.announce(run, skipped);
      }
    }

    return cancelled;
  }

  /** Progress, per case, so a follower sees it happening instead of a result at the end. */
  private async announce(run: Run, runCase: RunCase): Promise<void> {
    this.eventBus.publish(
      new RunCaseFinishedEvent(run.projectId, run.id, runCase, await this.runs.recomputeTotals(run.id)),
    );
  }

  private async finish(run: Run, cancelled: boolean): Promise<void> {
    const totals = await this.runs.recomputeTotals(run.id);
    const status = cancelled ? "cancelled" : verdictFor(totals);
    await this.runs.updateStatus(run.id, status, this.clock.now());
    this.eventBus.publish(new RunFinishedEvent(run.projectId, run.id, status, totals));
  }
}

/** A saved request, as the engine wants it. The row keeps `null` for absent; the engine wants the
 * key gone, which is what `exactOptionalPropertyTypes` is there to keep honest. */
/**
 * One row of a dataset, as variables.
 *
 * Published twice, under `dataset.sku` and under `sku`, for the same reason the environment's are:
 * the prefixed name says where the value came from, and in a flow of nine steps that is the
 * difference between reading a template and guessing at it. The bare name is what a flow written
 * before the dataset existed already spends.
 */
function datasetBindings(row: Record<string, string> | null): Record<string, string> {
  if (!row) return {};
  return Object.fromEntries(
    Object.entries(row).flatMap(([name, value]) => [
      [name, value],
      [`dataset.${name}`, value],
    ]),
  );
}

function scenarioFor(template: RequestTemplateRow): TestScenario {
  return {
    id: template.id,
    name: template.name,
    description: template.description ?? "Paso de un flujo reutilizable",
    expectedStatus: template.expectedStatus,
    ...(Object.keys(template.parameters ?? {}).length ? { parameters: template.parameters } : {}),
    ...(template.body ? { body: template.body } : {}),
    flow: "request",
    auth: template.auth,
  };
}

/** The one mapping from what the executor produced to what the repository stores. It was written
 * twice, once per walk, which is one copy too many for a shape with nine fields. */
function toRunSteps(runCaseId: string, steps: ExecutedStep[]): RunStep[] {
  return steps.map((step) => ({
    id: randomUUID(),
    runCaseId,
    index: step.request.index,
    purpose: step.request.purpose,
    label: step.request.label,
    request: step.sent,
    expected: {
      status: step.request.expectedStatus,
      shape: step.request.expectedShape,
      operationPath: step.request.operationPath,
    },
    actual: step.actual,
    assertions: step.assertions,
    latency: step.latency,
    ok: step.ok,
    durationMs: step.durationMs,
  }));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
