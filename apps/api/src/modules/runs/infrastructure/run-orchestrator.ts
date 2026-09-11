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
  readAuthorization,
  withEnvironmentNamespace,
  withinBudget,
  type Operation,
  type ProjectConfig,
  type ActualResponse,
  type ResolvedOperation,
  type TestScenario,
  type WorkflowStep,
} from "@eq/runner-core";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
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
import { caseStatusFor, failureFor, verdictFor, type Run, type RunCase, type RunStep } from "../domain/model";
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
    @Inject(ENV) private readonly env: Env,
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
      // Nothing has logged in yet. A flow step may publish one while walking.
      session: null,
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
      failure: null,
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
        failure: failureFor(executed),
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
    budget: { extra: number },
  ): { elements: unknown[]; dropped: number } | null {
    if (!step.forEach) return null;
    const source = responses.get(step.forEach.from);
    const list = source ? listAt(source.actual.body, step.forEach.path) : null;
    const walked = withinBudget(list ?? [], step.forEach.max ?? 50, budget.extra);
    if (walked.elements.length > 1) budget.extra -= walked.elements.length - 1;
    return walked;
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
    // `??`: a check failing on a response that was already a 500 is the 500's fault, and filing it
    // under «comprobación» would send it to whoever wrote the check.
    if (!last.ok) last.failure ??= "check";
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
    // Two counters, because they measure different things. `cursor` hands out `position`, which is
    // unique per run in the database — and a step that loops needs one slot per element, reserved
    // before anything runs because the elements do not exist yet. `cases` is how many rows were
    // actually written, which is what the budget and the progress total are about. The difference
    // between them is the gaps the unused reservations leave, and a gap costs nothing.
    let cursor = 0;
    let cases = 0;
    const passes = rows.flatMap((row, rowIndex) =>
      flows.map((flow) => {
        // The suffix only appears when there is more than one row: `…:crear@0` on a run with no
        // dataset would be noise in every report that shows a scenario id.
        const prepared = this.prepareWorkflow(
          run,
          flow,
          templates,
          context.resolved,
          rows.length > 1 ? `@${rowIndex}` : "",
          cursor,
        );
        cursor = prepared.next;
        cases += prepared.items.length;
        return { row, rowIndex, items: prepared.items };
      }),
    );

    await this.runs.saveCases(passes.flatMap((pass) => pass.items.map((item) => item.runCase)));
    await this.runs.updateStatus(run.id, "running", this.clock.now());
    // A lower bound rather than a count: a step that loops adds cases while the run is walking,
    // and the totals a follower shows are recomputed from the rows on every event anyway.
    this.eventBus.publish(new RunStartedEvent(run.projectId, run.id, cases));

    // What the loops may still add. The static half — flows times rows times steps — was refused
    // at the click if it did not fit; this is what is left of the ceiling for the half the target
    // decides.
    const budget = { extra: this.env.MAX_RUN_CASES - cases };
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
        // The session goes with them. A row that passes because the previous row logged in is a
        // row that would fail on its own, which is the failure a data-driven suite exists to find.
        context.target.session = null;
      }
      cancelled = await this.walkPrepared(run, context, pass.items, budget);
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
    let cursor = offset;
    const items = ordered.map((step) => {
      const position = cursor;
      // A looping step reserves a slot per element it may walk. They cannot be handed out while
      // walking — the ceiling is what the author wrote, the length is what the target answers, and
      // `position` has to be unique across the whole run either way.
      cursor += step.forEach ? (step.forEach.max ?? 50) : 1;
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
          failure: null,
          position,
          durationMs: null,
          startedAt: null,
          finishedAt: null,
        } satisfies RunCase,
      };
    });
    return { items, next: cursor };
  }

  /**
   * One walk of one graph, with as many steps in flight as the plan allows.
   *
   * Ready-driven rather than a loop over the topological order: what can start is decided by the
   * edges, so two steps with no path between them start together when the concurrency allows it
   * and the order they were listed in stops mattering. With `concurrency: 1` — the default — it
   * dispatches one at a time and behaves exactly as the loop it replaces.
   *
   * **What makes this safe is checked when the flow is saved, not here.** A run's variables are
   * one map: two steps that could run at the same time must not capture the same name, and the
   * step that obtains a session is a barrier. Enforcing it at write time is what stops somebody
   * raising a number on the run panel from turning a flow saved years ago into a race.
   *
   * Returns whether the run was cancelled while it was walking.
   */
  private async walkPrepared(
    run: Run,
    context: { config: ProjectConfig; resolved: ResolvedOperation[]; target: ExecutionTarget; authEnabled: boolean },
    prepared: ReturnType<RunOrchestrator["prepareWorkflow"]>["items"],
    budget: { extra: number },
  ): Promise<boolean> {
    const state: WalkState = {
      passed: new Map(),
      // The last answer of each step, which is what a condition judges and a loop walks. Kept for
      // the duration of one run and never beyond it: two runs of the same flow must not be able to
      // read each other's responses, for the same reason their variables are a copy.
      responses: new Map(),
      // What a failed step lets through. `continue` is the step whose failure the rest does not
      // actually depend on — a cleanup that 404s because there was nothing to clean.
      permissive: new Set(prepared.filter((item) => item.step.onError === "continue").map((item) => item.step.id)),
      budget,
      stopped: false,
    };

    const concurrency = Math.max(1, run.plan.concurrency ?? 1);
    const remaining = new Map(prepared.map((item) => [item.step.id, item]));
    const running = new Map<string, Promise<string>>();
    let cancelled = false;
    let dispatched = 0;

    while ((remaining.size || running.size) && !state.stopped) {
      // Between dispatches and never inside a step, for the same reason it always was: stopping
      // mid-flow leaves a created resource with no cleanup.
      if (await this.queue.isCancelled(run.id)) {
        cancelled = true;
        break;
      }

      for (const item of [...remaining.values()]) {
        if (running.size >= concurrency) break;
        if (!readyToRun(item.step, state.passed)) continue;
        remaining.delete(item.step.id);
        // The pause is between dispatches rather than between finishes: what it is for is the
        // target's rate limit, and that counts requests leaving, not answers arriving.
        if (dispatched > 0 && run.plan.delayMs > 0) await delay(run.plan.delayMs);
        dispatched += 1;
        running.set(
          item.step.id,
          this.runStep(run, context, item, state).then(() => item.step.id),
        );
      }

      // Nothing ready and nothing in flight. On an acyclic graph every step eventually resolves,
      // so this is a guard against a state that should not exist rather than an expected exit —
      // and hanging would be the worse way to discover it.
      if (!running.size) break;
      running.delete(await Promise.race(running.values()));
    }

    // Whatever was in flight when the walk stopped still has to finish writing its own rows: a
    // case left half-written is a row that says `running` forever.
    await Promise.all(running.values());

    if (state.stopped) {
      const done = new Set(state.passed.keys());
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

  /** One step: its dependencies, its condition, its wait, its elements and its retries. */
  private async runStep(
    run: Run,
    context: { config: ProjectConfig; resolved: ResolvedOperation[]; target: ExecutionTarget; authEnabled: boolean },
    item: ReturnType<RunOrchestrator["prepareWorkflow"]>["items"][number],
    state: WalkState,
  ): Promise<void> {
    const { passed, responses, permissive, budget } = state;
    const startedAt = this.clock.now();
    if (!dependenciesHeld(item.step, passed, permissive)) {
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
      return;
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
        return;
      }
    }

    // Not the same thing as a retry, and worth the second knob. A retry says «that failure was
    // not real»; this says «it was not time yet», which is the honest description of a target
    // that accepts a write and takes a moment to make it readable.
    if (item.step.waitMs) await delay(item.step.waitMs);

    const walked = this.elementsFor(item.step, responses, budget);
    const elements = walked?.elements ?? null;
    if (elements && elements.length === 0) {
      // A loop over nothing is not a failure and is not silence either: a case that says the
      // list was empty is what tells the next person the flow ran and had nothing to walk.
      const empty: RunCase = { ...item.runCase, status: "skipped", startedAt, finishedAt: startedAt, durationMs: 0 };
      passed.set(item.step.id, true);
      await this.runs.saveCase(empty);
      await this.announce(run, empty);
      return;
    }

    // One case per element, each with its own request, response and verdict. «Los 40 productos
    // responden» is forty findings; one case hiding thirty-nine results is the report this
    // product replaces.
    const iterations = elements ?? [null];
    let allPassed = true;
    let status: RunCase["status"] = "passed";
    for (const [iteration, element] of iterations.entries()) {
      // The first element **reuses the row that was already queued for the step**, and the rest
      // take the slots it reserved. Giving the first one a new id instead leaves the queued row
      // behind with no verdict and two rows fighting over one `position`, which the unique index
      // on `run_cases` refuses — the run dies with a constraint name and nothing else.
      const runCase =
        elements === null
          ? item.runCase
          : {
              ...item.runCase,
              ...(iteration === 0 ? {} : { id: randomUUID(), position: item.runCase.position + iteration }),
              scenarioId: `${item.runCase.scenarioId}#${iteration}`,
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

      // The session, published by the step that logged in. Reported as an assertion on that
      // step, because a login that answered 200 with a body nobody expected is a finding about
      // the target — and the eight steps after it failing with 401 is the same finding restated
      // eight times without ever naming it.
      if (last?.actual && item.step.authorizes) {
        const session = readAuthorization(item.step.authorizes, last.actual);
        if (session) context.target.session = session;
        last.assertions.push({
          label: "Sesión obtenida",
          pass: Boolean(session),
          detail: session
            ? `Los pasos siguientes presentarán ${session.header}`
            : `No se encontró la credencial en ${item.step.authorizes.from}.${item.step.authorizes.path}`,
        });
        last.ok = last.ok && holds(last.assertions);
        if (!last.ok) last.failure ??= "flow";
        executed.ok = executed.steps.every((step) => step.ok);
      }

      if (last?.actual && item.step.captures?.length) {
        const capture = applyCaptures(item.step.captures, last.actual, context.target.variables, item.step.id);
        const ok = capture.missing.length === 0;
        last.assertions.push({
          label: "Variables capturadas",
          pass: ok,
          detail: ok ? capture.captured.join(", ") : `No se encontraron: ${capture.missing.join(", ")}`,
        });
        last.ok = last.ok && holds(last.assertions);
        if (!last.ok) last.failure ??= "flow";
        executed.ok = executed.steps.every((step) => step.ok);
      }

      // Said on the first element, which is the case somebody opens to find out why a loop of
      // forty produced nine. A warning: the run hit the ceiling, which is not a finding about
      // the target.
      if (iteration === 0 && walked?.dropped) {
        last?.assertions.push({
          label: "Bucle recortado",
          pass: false,
          severity: "warning",
          detail: `Se recorrieron ${elements?.length ?? 0} de ${(elements?.length ?? 0) + walked.dropped} elementos: la corrida llegó al tope de ${this.env.MAX_RUN_CASES} casos`,
        });
        if (last) last.ok = last.ok && holds(last.assertions);
      }

      await this.runs.saveSteps(toRunSteps(runCase.id, executed.steps));
      status = caseStatusFor(executed);
      allPassed = allPassed && status === "passed";
      const finished: RunCase = {
        ...runCase,
        status,
        failure: failureFor(executed),
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
    // what it is testing: with no session, every later 401 is the same fact restated. The rest are
    // marked skipped rather than left queued — a case with no verdict is not a result.
    if (!allPassed && item.step.onError === "stop") state.stopped = true;
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

/** What a walk carries between its steps. One object rather than five arguments, because with
 * several in flight they are one shared thing and passing them apart invites copying one. */
type WalkState = {
  passed: Map<string, boolean>;
  responses: Map<string, { actual: ActualResponse; durationMs: number }>;
  permissive: Set<string>;
  budget: { extra: number };
  stopped: boolean;
};

/**
 * Whether a step may start.
 *
 * `all` is what a dependency means and is the default. `any` is the merge: the step that needs
 * only one of several routes to have arrived, and starts as soon as the first does — which is
 * also why it does not wait for the rest to disagree with it.
 */
function readyToRun(step: WorkflowStep, passed: Map<string, boolean>): boolean {
  const dependencies = step.dependsOn ?? [];
  if (!dependencies.length) return true;
  const resolved = dependencies.filter((id) => passed.has(id));
  return step.waits === "any" ? resolved.length > 0 : resolved.length === dependencies.length;
}

/** Whether what it depends on actually held. Same «all or any» reading as starting: a step that
 * only needed one route to arrive is not failed by the other one having failed. */
function dependenciesHeld(step: WorkflowStep, passed: Map<string, boolean>, permissive: Set<string>): boolean {
  const dependencies = step.dependsOn ?? [];
  if (!dependencies.length) return true;
  const held = dependencies.filter((id) => passed.get(id) === true || permissive.has(id));
  return step.waits === "any" ? held.length > 0 : held.length === dependencies.length;
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
