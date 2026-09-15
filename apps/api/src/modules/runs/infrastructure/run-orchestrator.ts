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
  applyCaptures,
  bindElement,
  dereference,
  evaluateChecks,
  holds,
  interpolateValue,
  listAt,
  loopBody,
  orderWorkflowSteps,
  readAuthorization,
  responseSchema,
  subflowProblems,
  subflowSteps,
  undeclaredPaths,
  unresolvedVariables,
  validateJson,
  withinBudget,
  type ActualResponse,
  type Assertion,
  type FailureKind,
  type ResolvedOperation,
  type StepLoop,
  type StepPoll,
  type StepRequest,
  type StepSubflow,
  type WorkflowStep,
} from "@eq/runner-core";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
import { SCRIPT_SANDBOX, redactOutcome, type ScriptSandboxPort } from "@/shared/scripts/script-sandbox";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { scenarioFor, type RequestTemplateRow, type WorkflowRow } from "@/modules/workflows/domain/model";
import { caseStatusFor, failureFor, verdictFor, type Run, type RunCase, type RunStep } from "../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../domain/ports";
import { CaseExecutor, computedSeed, type ExecutedCase, type ExecutedStep } from "./case-executor";
import { SAFE_FETCH, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { sendNotification } from "./notify-step";
import { ExecutionContextFactory, type ExecutionContext } from "./execution-context";
import { flattenPrepared, nestedScenarioId } from "./subflow-support";
import { mockStep } from "./mock-node";
import {
  RunCaseFinishedEvent,
  RunCaseRetryingEvent,
  RunCaseStartedEvent,
  RunFinishedEvent,
  RunPausedEvent,
  RunResumedEvent,
  RunStartedEvent,
} from "../application/events/run.events";

@Injectable()
export class RunOrchestrator {
  private readonly logger = new Logger(RunOrchestrator.name);

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
    @Inject(SCRIPT_SANDBOX) private readonly sandbox: ScriptSandboxPort,
    // Only the notify node calls out from here; every other request goes through the executor.
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    private readonly executor: CaseExecutor,
    private readonly contexts: ExecutionContextFactory,
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
      const context = await this.contexts.build(run);
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

  private async walk(run: Run, context: ExecutionContext): Promise<void> {
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
      const library = await this.subflowLibrary(run, flows);
      await this.walkFlows(run, context, flows, templates, await this.datasetRows(run), library);
      return;
    }
    const queue = buildQueue(context.resolved, context.config, {
      mode: run.plan.order,
      customOrder: run.plan.customOrder,
      ...(run.plan.operationIds.length ? { operationIds: run.plan.operationIds } : {}),
      ...(run.plan.labels?.length ? { labels: run.plan.labels } : {}),
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
    const pause: PauseState = { released: false };
    for (const [index, item] of queue.entries()) {
      const runCase = cases[index];
      if (await this.queue.isCancelled(run.id)) {
        cancelled = true;
        break;
      }

      // Between cases, never inside one: a pause in the middle of a create-read would leave the
      // created row without its cleanup step.
      if (index > 0 && run.plan.delayMs > 0) await delay(run.plan.delayMs);
      if (await this.hold(run, runCase, null, pause)) {
        cancelled = true;
        break;
      }

      const startedAt = this.clock.now();
      const started: RunCase = { ...runCase, status: "running", startedAt };
      await this.runs.saveCase(started);
      this.eventBus.publish(new RunCaseStartedEvent(run.projectId, run.id, started));

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
  private async attempt(
    run: Run,
    runCaseId: string,
    step: WorkflowStep,
    execute: () => Promise<ExecutedCase>,
  ): Promise<ExecutedCase> {
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
      // Said before the wait and not after it: the point is the silence, and announcing it once
      // it is over would be a message about something that already stopped being true.
      this.eventBus.publish(new RunCaseRetryingEvent(run.projectId, run.id, runCaseId, attempt, attempts, wait));
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

  /**
   * The project's flows by id, when a flow of the run has a subflow node — and the second time what
   * those nodes point at is checked. The first was the save; since then a child may have been
   * archived, deleted, or edited into a cycle, and walking one of those is a run that never ends or a
   * report about a flow nobody meant to keep. Refused here, the run is `error` and says which node.
   */
  private async subflowLibrary(run: Run, flows: WorkflowRow[]): Promise<Map<string, WorkflowRow>> {
    if (!flows.some((flow) => subflowSteps(flow.definition).length)) return new Map();
    const library = new Map((await this.workflows.listWorkflows(run.projectId)).map((flow) => [flow.id, flow]));
    for (const flow of flows) {
      const [problem] = subflowProblems(flow, (id) => library.get(id));
      if (problem) throw new Error(`El flujo "${flow.name}", nodo "${problem.stepId}": ${problem.detail}`);
    }
    return library;
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
    context: ExecutionContext,
    flows: WorkflowRow[],
    templates: Map<string, RequestTemplateRow>,
    rows: (Record<string, string> | null)[],
    /** The flows a subflow node may run, by id. Empty when no flow of the run has one. */
    library: Map<string, WorkflowRow> = new Map(),
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
          library,
        );
        cursor = prepared.next;
        cases += flattenPrepared(prepared.items).length;
        return { row, rowIndex, items: prepared.items };
      }),
    );

    await this.runs.saveCases(passes.flatMap((pass) => flattenPrepared(pass.items).map((item) => item.runCase)));
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
    // One for the whole run: «continuar» means the rest of it, not the rest of this row.
    const pause: PauseState = { released: false };
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
      cancelled = await this.walkPrepared(run, context, pass.items, budget, pause);
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
    library: Map<string, WorkflowRow> = new Map(),
  ): { items: PreparedItem[]; next: number } {
    const ordered = orderWorkflowSteps(workflow.definition, `El flujo "${workflow.name}"`);
    // A step inside a loop runs once per element, so it takes a slot per iteration the loop may walk
    // — for the same reason a `forEach` step does.
    const repeats = new Map<string, number>();
    for (const step of ordered) {
      if (step.kind !== "loop" || !step.loop) continue;
      for (const id of loopBody(ordered, step.id)) repeats.set(id, step.loop.max ?? 50);
    }
    let cursor = offset;
    const items = ordered.map((step): PreparedItem => {
      const position = cursor;
      // A looping step reserves a slot per element it may walk. They cannot be handed out while
      // walking — the ceiling is what the author wrote, the length is what the target answers, and
      // `position` has to be unique across the whole run either way.
      cursor += step.forEach ? (step.forEach.max ?? 50) : (repeats.get(step.id) ?? 1);
      const base = {
        id: randomUUID(),
        runId: run.id,
        scenarioId: `workflow:${workflow.id}:${step.id}${suffix}`,
        status: "queued" as const,
        failure: null,
        position,
        durationMs: null,
        startedAt: null,
        finishedAt: null,
      };
      // A subflow node takes its own slot and, right after it, every slot its child flow reserves —
      // prepared by this same function, so the child's loops and its own subflows reserve theirs. The
      // child's cases are renamed under this node; `subflowLibrary` already refused cycles, so the
      // recursion ends.
      if (step.kind === "subflow" && step.subflow) {
        const child = library.get(step.subflow.workflowId);
        if (!child) throw new Error(`El sub-flujo "${step.id}" ejecuta un flujo que ya no existe`);
        const nested = this.prepareWorkflow(run, child, templates, resolved, suffix, cursor, library);
        cursor = nested.next;
        const rename = (entry: PreparedItem): PreparedItem => ({
          ...entry,
          runCase: {
            ...entry.runCase,
            scenarioId: nestedScenarioId(workflow.id, step.id, child.id, entry.runCase.scenarioId),
          },
          ...(entry.children ? { children: entry.children.map(rename) } : {}),
        });
        return {
          step,
          template: null,
          operation: null,
          runCase: { ...base, operationId: "", method: "FLOW", path: `ejecuta «${child.name}»` },
          children: nested.items.map(rename),
        };
      }
      // A control node (branch/wait/merge/validate) sends no request, so it has no template and no
      // operation: it is a control row that records what the flow did. Its «method» and «path»
      // name it in the report — `IF`, `WAIT`, `MERGE`, `CHECK` — the way a request names its verb.
      const controlRow = controlCaseFields(step);
      if (controlRow) {
        return { step, template: null, operation: null, runCase: { ...base, ...controlRow } satisfies RunCase };
      }
      // A fetch sends a call written on the node: no saved request, no operation. Its case names the
      // method and URL the author typed, `{{variables}}` still in them.
      if (step.kind === "fetch") {
        return {
          step,
          template: null,
          operation: null,
          runCase: {
            ...base,
            operationId: "",
            method: step.fetch?.method ?? "GET",
            path: step.fetch?.url ?? "",
          } satisfies RunCase,
        };
      }
      // A GraphQL node names its operation, or the URL when the operation is anonymous.
      if (step.kind === "graphql") {
        return {
          step,
          template: null,
          operation: null,
          runCase: {
            ...base,
            operationId: "",
            method: "GQL",
            path: step.graphql?.operationName || step.graphql?.url || "",
          } satisfies RunCase,
        };
      }
      const template = templates.get(step.requestTemplateId!);
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
          ...base,
          operationId: operation.id,
          method: operation.method,
          path: operation.path,
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
    context: ExecutionContext,
    prepared: ReturnType<RunOrchestrator["prepareWorkflow"]>["items"],
    budget: { extra: number },
    pause: PauseState,
    /** Where each step's verdict is written. Given by a subflow node, which judges its child by it. */
    verdicts: Map<string, boolean> = new Map(),
  ): Promise<boolean> {
    const state: WalkState = {
      passed: verdicts,
      // The last answer of each step, which is what a condition judges and a loop walks. Kept for
      // the duration of one run and never beyond it: two runs of the same flow must not be able to
      // read each other's responses, for the same reason their variables are a copy.
      responses: new Map(),
      // Which way each branch went, set the moment its node decides and read by the nodes on its
      // two sides. Same run-scoped life as the responses it judges.
      branches: new Map(),
      // What a failed step lets through. `continue` is the step whose failure the rest does not
      // actually depend on — a cleanup that 404s because there was nothing to clean.
      permissive: new Set(prepared.filter((item) => item.step.onError === "continue").map((item) => item.step.id)),
      // Every step of this walk by id, for the node that sends another step's request again.
      items: new Map(prepared.map((item) => [item.step.id, item])),
      bodies: loopBodies(prepared),
      budget,
      stopped: false,
      pause,
      walkedSubflows: new Set(),
    };

    const concurrency = Math.max(1, run.plan.concurrency ?? 1);
    // A loop's body is walked by its loop, once per element — never on its own.
    const inBody = new Set([...state.bodies.values()].flat().map((item) => item.step.id));
    const remaining = new Map(prepared.filter((item) => !inBody.has(item.step.id)).map((item) => [item.step.id, item]));
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
        // Only before a step that is going to do something: stopping to announce a node that will
        // be skipped — its dependency failed, or its branch went the other way — is a click spent
        // on nothing.
        if (willExecute(item.step, state) && (await this.hold(run, item.runCase, item.step.id, pause))) {
          cancelled = true;
          break;
        }
        dispatched += 1;
        running.set(
          item.step.id,
          this.runStep(run, context, item, state)
            .then(() => this.closeLoopBody(run, item, state))
            .then(() => this.closeSubflow(run, item, state))
            .then(() => item.step.id),
        );
      }
      if (cancelled) break;

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
        await this.closeSubflow(run, item, state);
      }
    }

    return cancelled;
  }

  /** One step: its dependencies, its condition, its wait, its elements and its retries. */
  private async runStep(
    run: Run,
    context: ExecutionContext,
    item: PreparedItem,
    state: WalkState,
  ): Promise<void> {
    const { passed, responses, permissive, budget, branches } = state;
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

    // A node on one side of a branch runs only when that branch went its way. The other side is
    // not a failure — the flow chose — so it is skipped and still counts as «did not fail» for a
    // step that later merges the two paths back together.
    if (item.step.branch) {
      const wanted = item.step.branch.take === "then";
      if (branches.get(item.step.branch.of) !== wanted) {
        const at = this.clock.now();
        const skipped: RunCase = { ...item.runCase, status: "skipped", startedAt, finishedAt: at, durationMs: 0 };
        passed.set(item.step.id, true);
        await this.runs.saveCase(skipped);
        await this.announce(run, skipped);
        return;
      }
    }

    // A branch node sends no request: it reads its condition over what a dependency answered and
    // records which way the flow goes. It does not fail — it decides — so the case is «passed» and
    // its verdict is what the two sides read.
    if ((item.step.kind ?? "request") === "branch") {
      const condition = item.step.condition;
      const source = condition ? responses.get(condition.from) : undefined;
      const [verdict] = condition
        ? source
          ? evaluateChecks([condition.check], { response: source.actual, durationMs: source.durationMs })
          : [{ label: "condición", pass: false, detail: `El paso ${condition.from} no respondió` }]
        : [{ label: "condición", pass: false, detail: "sin condición" }];
      branches.set(item.step.id, verdict.pass);
      const at = this.clock.now();
      const decided: RunCase = { ...item.runCase, status: "passed", startedAt, finishedAt: at, durationMs: 0 };
      passed.set(item.step.id, true);
      await this.runs.saveCase(decided);
      await this.announce(run, decided);
      return;
    }

    // A wait node sends no request: it pauses and lets the flow through. Not a retry —«it was not
    // time yet», not «that failure was not real»— which is why it is its own shape on the canvas.
    if ((item.step.kind ?? "request") === "wait") {
      if (item.step.waitMs) await delay(item.step.waitMs);
      const at = this.clock.now();
      const done: RunCase = { ...item.runCase, status: "passed", startedAt, finishedAt: at, durationMs: item.step.waitMs ?? 0 };
      passed.set(item.step.id, true);
      await this.runs.saveCase(done);
      await this.announce(run, done);
      return;
    }

    // A merge node is a join: whether it may start is already decided by `waits` (all/any) in
    // `readyToRun`, and whether its dependencies held by `dependenciesHeld` above. Reaching here
    // means the join is satisfied, so it passes and the flow continues past it.
    if ((item.step.kind ?? "request") === "merge") {
      const at = this.clock.now();
      const joined: RunCase = { ...item.runCase, status: "passed", startedAt, finishedAt: at, durationMs: 0 };
      passed.set(item.step.id, true);
      await this.runs.saveCase(joined);
      await this.announce(run, joined);
      return;
    }

    // A validate node sends no request either: it reads what a dependency answered and judges it
    // with the author's checks and, optionally, a script in the isolated sandbox. It *can* fail —
    // that is the point — and a failure skips what depends on it, the same as a red request would.
    if ((item.step.kind ?? "request") === "validate") {
      const from = item.step.validate?.from;
      const source = from ? responses.get(from) : undefined;
      const assertions = source && item.step.checks?.length
        ? evaluateChecks(item.step.checks, { response: source.actual, durationMs: source.durationMs })
        : [];
      let verdict = source ? holds(assertions) : false;
      const script = item.step.validate?.script?.trim();
      if (verdict && script && source) {
        const outcome = await this.sandbox.run({
          phase: "post",
          code: script,
          environment: { name: null, values: { ...context.target.variables } },
          variables: {},
          request: { method: "", url: "", headers: {}, body: null },
          response: {
            status: source.actual.status,
            headers: source.actual.headers,
            body: source.actual.raw,
            durationMs: source.durationMs,
          },
        });
        // The script passes when it ran to the end and every `pm.test` it declared held. A script
        // that threw, or that declared no test at all, does not vouch for the response.
        verdict = !outcome.error && outcome.tests.length > 0 && outcome.tests.every((t) => t.passed);
      }
      const at = this.clock.now();
      const judged: RunCase = {
        ...item.runCase,
        status: verdict ? "passed" : "failed",
        failure: verdict ? null : "check",
        startedAt,
        finishedAt: at,
        durationMs: 0,
      };
      passed.set(item.step.id, verdict);
      await this.runs.saveCase(judged);
      await this.announce(run, judged);
      if (!verdict && stopsOnFailure(run, item.step)) state.stopped = true;
      return;
    }

    // A set node sends no request: it writes variables for the steps after it, from templates over
    // what the run already knows. Run-scoped like a capture — the stored environment is untouched.
    // A template that names a variable nobody defined fails the node instead of writing the token.
    if (item.step.kind === "set") {
      const assignments = item.step.set?.assignments ?? [];
      const seed = computedSeed();
      const values = assignments.map((assignment) => ({
        variable: assignment.variable,
        value: interpolateValue(assignment.value, context.target.variables, seed),
      }));
      const missing = unresolvedVariables(values.map((entry) => entry.value));
      const ok = missing.length === 0;
      if (ok) for (const entry of values) context.target.variables[entry.variable] = entry.value;
      await this.finishControl(run, item, state, startedAt, {
        ok,
        failure: ok ? null : "config",
        // Names only: a value may carry a secret the template pulled from the environment.
        assertions: [
          ok
            ? { label: "Variables asignadas", pass: true, detail: values.map((entry) => entry.variable).join(", ") }
            : { label: "Variables del entorno", pass: false, detail: `Faltan variables: ${missing.join(", ")}` },
        ],
        sent: {
          method: "SET",
          url: "",
          headers: {},
          body: Object.fromEntries(assignments.map((assignment) => [assignment.variable, assignment.value])),
        },
      });
      return;
    }

    // A script node runs in the same isolated sandbox as the endpoint scripts. It may read a
    // dependency's response, and what it writes goes into the run's variables only. It fails when it
    // throws or when one of its `pm.test` fails; its console and tests are kept, redacted, so the
    // report shows what it did.
    if (item.step.kind === "script") {
      const from = item.step.script?.from;
      const source = from ? responses.get(from) : undefined;
      const outcome = await this.sandbox.run({
        phase: "post",
        code: item.step.script?.code ?? "",
        environment: { name: null, values: { ...context.target.variables } },
        variables: {},
        request: { method: "", url: "", headers: {}, body: null },
        response: source
          ? {
              status: source.actual.status,
              headers: source.actual.headers,
              body: source.actual.raw,
              durationMs: source.durationMs,
            }
          : null,
      });
      const ok = !outcome.error && outcome.tests.every((test) => test.passed);
      const written = [...Object.keys(outcome.environmentSet), ...Object.keys(outcome.variables)];
      if (!outcome.error) {
        Object.assign(context.target.variables, outcome.environmentSet, outcome.variables);
        for (const name of outcome.environmentUnset) delete context.target.variables[name];
      }
      const shown = redactOutcome(outcome, [
        ...(context.target.secrets ?? []),
        ...(context.target.session ? [context.target.session.value] : []),
      ]);
      const assertions: Assertion[] = [
        ...(shown.error ? [{ label: "Script", pass: false, detail: shown.error }] : []),
        ...shown.tests.map((test) => ({
          label: `pm.test: ${test.name}`,
          pass: test.passed,
          detail: test.message ?? (test.passed ? "Pasó" : "Falló"),
        })),
        ...(written.length ? [{ label: "Variables escritas", pass: true, detail: [...new Set(written)].join(", ") }] : []),
        ...shown.logs.slice(0, 50).map((log) => ({ label: `console.${log.level}`, pass: true, detail: log.text })),
      ];
      await this.finishControl(run, item, state, startedAt, {
        ok,
        failure: ok ? null : outcome.error ? "flow" : "check",
        assertions,
        sent: { method: "SCRIPT", url: from ? `lee ${from}` : "", headers: {}, body: item.step.script?.code ?? "" },
      });
      return;
    }

    // A schema node validates the body a dependency got against a JSON Schema: the contract's for
    // that operation and the status that came back, or the one written on the node. A missing
    // schema is a failure, not a pass — a check that could not run vouches for nothing.
    if (item.step.kind === "schema" && item.step.schema) {
      const config = item.step.schema;
      const source = responses.get(config.from);
      const assertions: Assertion[] = [];
      let schema: unknown;
      if (!source) {
        assertions.push({ label: "Esquema", pass: false, detail: `El paso ${config.from} no respondió` });
      } else if (config.source === "contract") {
        const operation = state.items.get(config.from)?.operation;
        schema =
          context.target.spec && operation
            ? responseSchema(context.target.spec, operation.path, operation.method, source.actual.status, source.actual.contentType)
            : undefined;
        if (schema === undefined) {
          assertions.push({
            label: "Esquema del contrato",
            pass: false,
            detail: context.target.spec
              ? `El contrato no declara un esquema para ${operation?.method ?? ""} ${operation?.path ?? config.from} → ${source.actual.status}`
              : `No hay contrato que consultar: ${context.target.specError ?? "no se pudo leer"}`,
          });
        }
      } else {
        try {
          const parsed = JSON.parse(config.json ?? "") as Record<string, unknown>;
          // Local `$ref`s (`#/definitions/…`) point inside the node's own schema.
          schema = dereference(parsed, parsed);
        } catch {
          assertions.push({ label: "Esquema", pass: false, detail: "El esquema propio no es JSON válido" });
        }
      }
      if (source && schema !== undefined) {
        const errors = validateJson(source.actual.body, schema);
        assertions.push(
          errors.length
            ? {
                label: "Esquema",
                pass: false,
                detail: [...errors.slice(0, 20), ...(errors.length > 20 ? [`… y ${errors.length - 20} más`] : [])].join("\n"),
              }
            : { label: "Esquema", pass: true, detail: "La respuesta cumple el esquema" },
        );
        if (config.strict) {
          const extra = undeclaredPaths(source.actual.body, schema);
          assertions.push({
            label: "Campos no declarados",
            pass: extra.length === 0,
            detail: extra.length ? extra.slice(0, 20).join(", ") : "Ninguno",
          });
        }
      }
      const ok = assertions.length > 0 && assertions.every((assertion) => assertion.pass);
      await this.finishControl(run, item, state, startedAt, {
        ok,
        failure: ok ? null : schema === undefined ? "config" : "check",
        assertions,
        sent: {
          method: "SCHEMA",
          url: `valida ${config.from}`,
          headers: {},
          body: config.source === "custom" ? (config.json ?? "") : "contrato",
        },
      });
      return;
    }

    // A notify node posts a message to the chat/webhook URL an environment variable holds. The URL is
    // a secret: see `notify-step.ts` for what is stored instead and when a failed delivery fails.
    if (item.step.kind === "notify" && item.step.notify) {
      const outcome = await sendNotification(this.http, {
        notify: item.step.notify,
        target: context.target,
        // `workflow:<id>:<step>…` — the id is a uuid, so it has no colon of its own.
        origin: { runId: run.id, workflowId: item.runCase.scenarioId.split(":")[1] ?? "", stepId: item.step.id },
      });
      await this.finishControl(run, item, state, startedAt, outcome);
      return;
    }

    // A poll node repeats the request of the step it reads until the answer passes the node's own
    // checks — the job that answers `pending` until it is `done`.
    if (item.step.kind === "poll" && item.step.poll) {
      await this.poll(run, context, item, state, startedAt, item.step.poll);
      return;
    }

    // A loop node walks its body once per element of a list a previous step returned.
    if (item.step.kind === "loop" && item.step.loop) {
      await this.loop(run, context, item, state, startedAt, item.step.loop);
      return;
    }

    // A subflow node walks another flow of the project, inline, as one step of this one.
    if (item.step.kind === "subflow" && item.step.subflow) {
      await this.subflow(run, context, item, state, startedAt, item.step.subflow);
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

    // A mock node answers with the response written on it and sends nothing (see `mock-node.ts`).
    // Here and not with the other control nodes: after the condition and the wait, so it is scheduled
    // exactly like the request it stands in for. Its answer is stored like a real one.
    if (item.step.kind === "mock" && item.step.mock) {
      if (item.step.mock.delayMs) {
        const started: RunCase = { ...item.runCase, status: "running", startedAt };
        await this.runs.saveCase(started);
        this.eventBus.publish(new RunCaseStartedEvent(run.projectId, run.id, started));
        await delay(item.step.mock.delayMs);
      }
      const { executed, actual } = mockStep(item.step, item.step.mock, item.runCase, context.target.variables, {
        seed: computedSeed(),
        secrets: [...(context.target.secrets ?? []), ...(context.target.session ? [context.target.session.value] : [])],
      });
      if (actual) responses.set(item.step.id, { actual, durationMs: executed.durationMs });
      await this.finishControl(run, item, state, startedAt, {
        ok: executed.ok,
        failure: executed.failure,
        assertions: executed.assertions,
        sent: executed.sent,
        steps: [executed],
        durationMs: executed.durationMs,
      });
      return;
    }

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

      const started: RunCase = { ...runCase, status: "running", startedAt: boundAt };
      await this.runs.saveCase(started);
      this.eventBus.publish(new RunCaseStartedEvent(run.projectId, run.id, started));
      const executed = await this.attempt(run, runCase.id, item.step, () => this.send(run, context, item));

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
    if (!allPassed && stopsOnFailure(run, item.step)) state.stopped = true;
  }

  /**
   * Waits for a person before a case, when the run was launched to.
   *
   * Returns whether the run was cancelled while it waited. The wait is a poll of the queue rather
   * than a promise somebody resolves, because the «siguiente» may land on another instance than the
   * one walking the run — the same reason cancelling is a flag. A wait nobody comes back to ends in a
   * cancellation: with the in-memory queue a paused run is also every run queued behind it.
   */
  private async hold(run: Run, runCase: RunCase, stepId: string | null, pause: PauseState): Promise<boolean> {
    const mode = run.plan.pauseMode ?? "none";
    if (mode === "none" || pause.released) return false;
    if (mode === "breakpoints" && (!stepId || !run.plan.breakpoints?.includes(stepId))) return false;

    const at = { caseId: runCase.id, stepId };
    // A release left over from an earlier wait — a double click on «siguiente» — must not let this
    // one through before anybody saw it.
    await this.queue.takeResume(run.id);
    await this.queue.pause(run.id, at);
    this.eventBus.publish(new RunPausedEvent(run.projectId, run.id, at));
    const deadline = Date.now() + PAUSE_LIMIT_MS;
    try {
      while (Date.now() < deadline) {
        if (await this.queue.isCancelled(run.id)) return true;
        const how = await this.queue.takeResume(run.id);
        if (how) {
          if (how === "continue") pause.released = true;
          this.eventBus.publish(new RunResumedEvent(run.projectId, run.id, how));
          return false;
        }
        await delay(PAUSE_POLL_MS);
      }
      this.logger.warn(`Corrida ${run.id}: nadie la reanudó en ${PAUSE_LIMIT_MS / 60_000} min; se cancela`);
      return true;
    } finally {
      await this.queue.pause(run.id, null);
    }
  }

  /**
   * The request a step sends: the call written on a fetch node, or its saved request. Anything else
   * reaching here is a request or a login node — control nodes are handled before — which
   * prepareWorkflow only builds with a template and an operation, hence the non-null assertions.
   */
  private send(run: Run, context: ExecutionContext, item: PreparedItem): Promise<ExecutedCase> {
    if (item.step.kind === "graphql" && item.step.graphql) {
      return this.executor.graphql({ call: item.step.graphql, target: context.target });
    }
    return item.step.kind === "fetch" && item.step.fetch
      ? this.executor.fetch({ call: item.step.fetch, target: context.target })
      : this.executor.run({
          operation: item.operation!,
          scenario: scenarioFor(item.template!),
          operations: context.resolved,
          config: context.config,
          target: context.target,
          samples: run.plan.samples,
        });
  }

  /**
   * A poll node: judge the answer `from` already got with the node's checks and, while it does not
   * pass, send `from`'s request again.
   *
   * The first read costs nothing, so a job already finished sends no request. What it records is one
   * case holding the last attempt — the answer that decided — rather than a row per «todavía no»,
   * and later nodes read that answer from this node. Cancellation is looked at between sends, the
   * same rule as between cases.
   */
  private async poll(
    run: Run,
    context: ExecutionContext,
    item: PreparedItem,
    state: WalkState,
    startedAt: Date,
    poll: StepPoll,
  ): Promise<void> {
    const source = state.items.get(poll.from);
    const first = state.responses.get(poll.from);
    const sent = { method: "RETRY", url: `repite ${poll.from}`, headers: {}, body: null };
    if (!source || !first) {
      await this.finishControl(run, item, state, startedAt, {
        ok: false,
        failure: "config",
        assertions: [{ label: "Reintento", pass: false, detail: `El paso ${poll.from} no respondió` }],
        sent,
      });
      return;
    }

    const judged = evaluateChecks(item.step.checks ?? [], { response: first.actual, durationMs: first.durationMs });
    if (holds(judged)) {
      state.responses.set(item.step.id, first);
      const capture = this.captureInto(item.step, first.actual, context);
      const assertions: Assertion[] = [
        ...judged,
        { label: "Reintento", pass: true, detail: `La respuesta de ${poll.from} ya cumplía: sin reenvíos` },
        ...(capture ? [capture] : []),
      ];
      const ok = holds(assertions);
      await this.finishControl(run, item, state, startedAt, { ok, failure: ok ? null : "flow", assertions, sent });
      return;
    }

    const started: RunCase = { ...item.runCase, status: "running", startedAt };
    await this.runs.saveCase(started);
    this.eventBus.publish(new RunCaseStartedEvent(run.projectId, run.id, started));

    let executed: ExecutedCase | null = null;
    let sends = 0;
    while (sends < poll.attempts) {
      if (await this.queue.isCancelled(run.id)) break;
      sends += 1;
      // Numbered like a retry — the first read is attempt one — so a follower shows «2 de 6».
      this.eventBus.publish(
        new RunCaseRetryingEvent(run.projectId, run.id, item.runCase.id, sends + 1, poll.attempts + 1, poll.delayMs),
      );
      if (poll.delayMs > 0) await delay(poll.delayMs);
      executed = await this.withChecks(item.step, await this.send(run, context, source));
      const answer = executed.steps.at(-1);
      if (answer?.actual) state.responses.set(item.step.id, { actual: answer.actual, durationMs: answer.durationMs });
      if (executed.ok) break;
    }

    const last = executed?.steps.at(-1);
    if (!executed || !last) {
      await this.finishControl(run, item, state, startedAt, {
        ok: false,
        failure: "flow",
        assertions: [...judged, { label: "Reintento", pass: false, detail: "La corrida se canceló antes de repetir" }],
        sent,
      });
      return;
    }
    last.assertions.push({
      label: "Reintento",
      pass: executed.ok,
      detail: executed.ok
        ? `Cumplió en el reenvío ${sends} de ${poll.attempts}`
        : `No cumplió tras ${sends} ${sends === 1 ? "reenvío" : "reenvíos"}`,
    });
    if (executed.ok && last.actual) {
      const capture = this.captureInto(item.step, last.actual, context);
      if (capture) last.assertions.push(capture);
      if (capture && !capture.pass) last.failure ??= "flow";
    }
    last.ok = holds(last.assertions);
    if (!last.ok) last.failure ??= "check";
    const ok = executed.steps.every((step) => step.ok);
    await this.finishControl(run, item, state, startedAt, {
      ok,
      failure: ok ? null : (failureFor(executed) ?? "check"),
      assertions: [],
      sent,
      steps: executed.steps,
      durationMs: this.clock.now().getTime() - startedAt.getTime(),
    });
  }

  /**
   * A loop node: its body, once per element of the list at `path` in `from`'s response.
   *
   * Each iteration walks the body in order with its own view of the walk — which step passed, which
   * way a branch went, what answered — seeded from the outer one, so a body step can still read a
   * step that ran before the loop. The variables are the run's: what an iteration captures is there
   * for the rest of it and, after the loop, the last iteration's is what the «fin» side sees. Every
   * body step gets a case per iteration, in the slots `prepareWorkflow` reserved.
   *
   * Iterations run one after the other, and a pause set on a body node does not stop inside it.
   */
  private async loop(
    run: Run,
    context: ExecutionContext,
    item: PreparedItem,
    state: WalkState,
    startedAt: Date,
    loop: StepLoop,
  ): Promise<void> {
    const body = state.bodies.get(item.step.id) ?? [];
    const sent = { method: "LOOP", url: `recorre ${loop.from}.${loop.path}`, headers: {}, body: null };
    const source = state.responses.get(loop.from);
    const list = source ? listAt(source.actual.body, loop.path) : null;
    if (!list) {
      // Unlike a `forEach` over nothing, which is an empty walk: this node's whole claim is «here
      // is a list», and an answer without one is the finding.
      await this.finishControl(run, item, state, startedAt, {
        ok: false,
        failure: "flow",
        assertions: [{ label: "Bucle", pass: false, detail: `No hay una lista en ${loop.from} → ${loop.path}` }],
        sent,
      });
      return;
    }

    const wanted = list.slice(0, loop.max ?? 50);
    // The run's ceiling holds whole iterations: half a body walked is a report about nothing.
    const allowed =
      wanted.length <= 1 || body.length === 0
        ? wanted.length
        : Math.min(wanted.length, 1 + Math.floor(Math.max(0, state.budget.extra) / body.length));
    if (allowed > 1) state.budget.extra -= (allowed - 1) * body.length;

    const started: RunCase = { ...item.runCase, status: "running", startedAt };
    await this.runs.saveCase(started);
    this.eventBus.publish(new RunCaseStartedEvent(run.projectId, run.id, started));

    const failed: number[] = [];
    const outcome = new Map(body.map((entry) => [entry.step.id, true]));
    let walked = 0;
    for (const [index, element] of wanted.slice(0, allowed).entries()) {
      if (await this.queue.isCancelled(run.id)) break;
      walked += 1;
      Object.assign(context.target.variables, bindElement(loop.as, element));
      const iteration: WalkState = {
        ...state,
        passed: new Map([...state.passed, [item.step.id, true]]),
        responses: new Map(state.responses),
        branches: new Map(state.branches),
        stopped: false,
      };
      for (const entry of body) {
        // The first iteration reuses the row queued for the step, the rest take its reserved slots.
        const runCase: RunCase = {
          ...entry.runCase,
          ...(index === 0 ? {} : { id: randomUUID(), position: entry.runCase.position + index }),
          scenarioId: `${entry.runCase.scenarioId}#${index}`,
        };
        if (iteration.stopped) {
          const at = this.clock.now();
          const skipped: RunCase = { ...runCase, status: "skipped", startedAt: at, finishedAt: at, durationMs: 0 };
          await this.runs.saveCase(skipped);
          await this.announce(run, skipped);
          continue;
        }
        await this.runStep(run, context, { ...entry, runCase }, iteration);
      }
      let held = true;
      for (const entry of body) {
        if (iteration.passed.get(entry.step.id) === true) continue;
        outcome.set(entry.step.id, false);
        held = false;
      }
      if (!held) failed.push(index + 1);
      if (iteration.stopped) {
        state.stopped = true;
        break;
      }
    }

    if (walked > 0) for (const [id, held] of outcome) state.passed.set(id, held);
    const ok = failed.length === 0;
    const assertions: Assertion[] = [
      {
        label: "Bucle",
        pass: ok,
        detail:
          list.length === 0
            ? "La lista está vacía: el cuerpo no se ejecutó"
            : ok
              ? `Recorrió ${walked} de ${list.length} elementos`
              : `Fallaron ${failed.length} de ${walked} vueltas (${failed.join(", ")})`,
      },
      ...(allowed < wanted.length
        ? [
            {
              label: "Bucle recortado",
              pass: false,
              severity: "warning" as const,
              detail: `Se recorrieron ${allowed} de ${wanted.length} elementos: la corrida llegó al tope de ${this.env.MAX_RUN_CASES} casos`,
            },
          ]
        : []),
    ];
    await this.finishControl(run, item, state, startedAt, {
      ok,
      failure: ok ? null : "flow",
      assertions,
      sent,
      durationMs: this.clock.now().getTime() - startedAt.getTime(),
    });
  }

  /** A loop's body steps it never walked — the loop was skipped, found no list or an empty one —
   * still get a verdict: a case left `queued` is not a result. */
  private async closeLoopBody(run: Run, item: PreparedItem, state: WalkState): Promise<void> {
    if (item.step.kind !== "loop") return;
    for (const entry of state.bodies.get(item.step.id) ?? []) {
      if (state.passed.has(entry.step.id)) continue;
      const at = this.clock.now();
      const skipped: RunCase = { ...entry.runCase, status: "skipped", startedAt: at, finishedAt: at, durationMs: 0 };
      state.passed.set(entry.step.id, true);
      await this.runs.saveCase(skipped);
      await this.announce(run, skipped);
    }
  }

  /**
   * A subflow node: the child flow's steps, walked as a graph of their own, then what they hand back.
   *
   * The child gets a **copy** of the run's variables with its `inputs` on top, resolved over the
   * parent's when the node starts — a template naming a variable nobody defined fails the node, the
   * way a set node does, and nothing is walked. It walks with its own view of which step passed and
   * what answered, so its ids cannot collide with the parent's, but with the run's budget, pause and
   * cancellation. Afterwards only the names in `outputs` are written back, also as
   * `<node>.<name>`, and a session the child obtained replaces the parent's: a shared login is the
   * most ordinary subflow there is.
   *
   * The node passes when every child step did and every output was there. A child step that stops
   * its flow stops the child; whether the parent stops too is this node's own «si falla».
   *
   * Limits: the child walks inside the parent's concurrency slot with the run's concurrency of its
   * own, so a parallel run can have more steps in flight than the number says; the child's steps are
   * not counted by the size check made when the run is launched, only by the walk's budget.
   */
  private async subflow(
    run: Run,
    context: ExecutionContext,
    item: PreparedItem,
    state: WalkState,
    startedAt: Date,
    config: StepSubflow,
  ): Promise<void> {
    const children = item.children ?? [];
    const declared = config.inputs ?? [];
    // Templates and not values: an input may carry a secret the template pulled from the environment.
    const sent = {
      method: "FLOW",
      url: item.runCase.path,
      headers: {},
      body: Object.fromEntries(declared.map((input) => [input.variable, input.value])),
    };
    const seed = computedSeed();
    const inputs = declared.map((input) => ({
      variable: input.variable,
      value: interpolateValue(input.value, context.target.variables, seed),
    }));
    const missing = unresolvedVariables(inputs.map((entry) => entry.value));
    if (missing.length) {
      await this.finishControl(run, item, state, startedAt, {
        ok: false,
        failure: "config",
        assertions: [{ label: "Entradas del sub-flujo", pass: false, detail: `Faltan variables: ${missing.join(", ")}` }],
        sent,
      });
      return;
    }

    state.walkedSubflows.add(item.step.id);
    const started: RunCase = { ...item.runCase, status: "running", startedAt };
    await this.runs.saveCase(started);
    this.eventBus.publish(new RunCaseStartedEvent(run.projectId, run.id, started));

    const variables = { ...context.target.variables, ...Object.fromEntries(inputs.map((entry) => [entry.variable, entry.value])) };
    const target = { ...context.target, variables };
    const verdicts = new Map<string, boolean>();
    const cancelled = await this.walkPrepared(run, { ...context, target }, children, state.budget, state.pause, verdicts);

    const session = target.session !== context.target.session ? target.session : null;
    if (session) context.target.session = session;
    const outputs = config.outputs ?? [];
    const returned = outputs.filter((name) => variables[name] !== undefined);
    const lacking = outputs.filter((name) => variables[name] === undefined);
    for (const name of returned) {
      context.target.variables[name] = variables[name];
      context.target.variables[`${item.step.id}.${name}`] = variables[name];
    }

    const failed = children.filter((entry) => verdicts.get(entry.step.id) !== true).map((entry) => entry.step.id);
    const walked = !cancelled && failed.length === 0;
    const ok = walked && lacking.length === 0;
    const assertions: Assertion[] = [
      {
        label: "Sub-flujo",
        pass: walked,
        detail: cancelled
          ? "La corrida se canceló dentro del sub-flujo"
          : failed.length
            ? `No pasaron ${failed.length} de ${children.length} pasos: ${failed.join(", ")}`
            : `Pasaron sus ${children.length} ${children.length === 1 ? "paso" : "pasos"}`,
      },
      // Names only, for the same reason as `sent`.
      ...(inputs.length ? [{ label: "Entradas", pass: true, detail: inputs.map((entry) => entry.variable).join(", ") }] : []),
      ...(outputs.length
        ? [
            {
              label: "Variables devueltas",
              pass: lacking.length === 0,
              detail: lacking.length ? `No se encontraron: ${lacking.join(", ")}` : returned.join(", "),
            },
          ]
        : []),
      ...(session
        ? [{ label: "Sesión obtenida", pass: true, detail: `Los pasos siguientes presentarán ${session.header}` }]
        : []),
    ];
    await this.finishControl(run, item, state, startedAt, {
      ok,
      failure: ok ? null : "flow",
      assertions,
      sent,
      durationMs: this.clock.now().getTime() - startedAt.getTime(),
    });
  }

  /** A subflow node whose child never walked — the node was skipped, stopped before it, or its
   * inputs did not resolve — still leaves a verdict on every child case: `queued` is not a result. */
  private async closeSubflow(run: Run, item: PreparedItem, state: WalkState): Promise<void> {
    if (item.step.kind !== "subflow" || state.walkedSubflows.has(item.step.id)) return;
    for (const entry of flattenPrepared(item.children ?? [])) {
      const at = this.clock.now();
      const skipped: RunCase = { ...entry.runCase, status: "skipped", startedAt: at, finishedAt: at, durationMs: 0 };
      await this.runs.saveCase(skipped);
      await this.announce(run, skipped);
    }
  }

  /** A node's captures over one answer, as the assertion a request leaves for them. */
  private captureInto(step: WorkflowStep, actual: ActualResponse, context: ExecutionContext): Assertion | null {
    if (!step.captures?.length) return null;
    const capture = applyCaptures(step.captures, actual, context.target.variables, step.id);
    const ok = capture.missing.length === 0;
    return {
      label: "Variables capturadas",
      pass: ok,
      detail: ok ? capture.captured.join(", ") : `No se encontraron: ${capture.missing.join(", ")}`,
    };
  }

  /**
   * Closes a control node that did something worth reading — a set, a script, a poll — with a step
   * row, so the case detail shows what it wrote, logged and asserted, the way a request shows its
   * response. A poll hands over the real request it sent last instead of the made-up one.
   */
  private async finishControl(
    run: Run,
    item: PreparedItem,
    state: WalkState,
    startedAt: Date,
    result: {
      ok: boolean;
      failure: FailureKind | null;
      assertions: Assertion[];
      sent: ExecutedStep["sent"];
      steps?: ExecutedStep[];
      durationMs?: number;
    },
  ): Promise<void> {
    const request: StepRequest = {
      index: 0,
      purpose: "act",
      label: item.runCase.method,
      operationId: "",
      method: item.runCase.method,
      operationPath: item.runCase.path,
      requestPath: "",
      expectedStatus: 0,
      expectedShape: "",
      auth: "none",
      samples: 1,
    };
    await this.runs.saveSteps(
      toRunSteps(
        item.runCase.id,
        result.steps ?? [
          {
            request,
            ok: result.ok,
            failure: result.failure,
            assertions: result.assertions,
            actual: null,
            latency: { samples: [], budgetMs: null },
            durationMs: 0,
            sent: result.sent,
          },
        ],
      ),
    );
    const done: RunCase = {
      ...item.runCase,
      status: result.ok ? "passed" : "failed",
      failure: result.failure,
      startedAt,
      finishedAt: this.clock.now(),
      durationMs: result.durationMs ?? 0,
    };
    state.passed.set(item.step.id, result.ok);
    await this.runs.saveCase(done);
    await this.announce(run, done);
    if (!result.ok && stopsOnFailure(run, item.step)) state.stopped = true;
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

/** Whether a person already said «continuar» on this run, so it stops waiting. */
type PauseState = { released: boolean };

/** How long a run may wait for a person, and how often it looks. */
const PAUSE_LIMIT_MS = 30 * 60_000;
const PAUSE_POLL_MS = 150;

/** `stop` on the step, or the run's «detener al primer fallo» — except on a step whose author said
 * `continue`, which is a statement that its failure does not matter. */
function stopsOnFailure(run: Run, step: WorkflowStep): boolean {
  return step.onError === "stop" || (run.plan.stopOnFailure === true && step.onError !== "continue");
}

/** Whether a ready step is going to execute rather than be skipped — the same two tests `runStep`
 * applies first: its dependencies held, and it is on the side its branch took. */
function willExecute(step: WorkflowStep, state: WalkState): boolean {
  if (!dependenciesHeld(step, state.passed, state.permissive)) return false;
  if (step.branch && state.branches.get(step.branch.of) !== (step.branch.take === "then")) return false;
  return true;
}

/** One step of a walk, as `prepareWorkflow` builds it: a control node or a fetch has neither
 * template nor operation. */
type PreparedItem = {
  step: WorkflowStep;
  template: RequestTemplateRow | null;
  operation: ResolvedOperation | null;
  runCase: RunCase;
  /** On a subflow node: its child flow's prepared steps, already renamed under the node. */
  children?: PreparedItem[];
};

/** Each loop node's body, as the prepared items in walking order. */
function loopBodies(prepared: PreparedItem[]): Map<string, PreparedItem[]> {
  const steps = prepared.map((item) => item.step);
  return new Map(
    prepared
      .filter((item) => item.step.kind === "loop")
      .map((item) => {
        const body = new Set(loopBody(steps, item.step.id));
        return [item.step.id, prepared.filter((entry) => body.has(entry.step.id))] as const;
      }),
  );
}

/** What a walk carries between its steps. One object rather than five arguments, because with
 * several in flight they are one shared thing and passing them apart invites copying one. */
type WalkState = {
  passed: Map<string, boolean>;
  responses: Map<string, { actual: ActualResponse; durationMs: number }>;
  /** Each branch node's verdict, so the nodes on its «sí» and «no» sides know whether they run. */
  branches: Map<string, boolean>;
  permissive: Set<string>;
  items: Map<string, PreparedItem>;
  /** Each loop node's body, as prepared items in walking order. */
  bodies: Map<string, PreparedItem[]>;
  budget: { extra: number };
  stopped: boolean;
  /** The run's pause, so a subflow's child walk stops where the parent's would. */
  pause: PauseState;
  /** The subflow nodes of this walk whose child actually walked; the rest get their children skipped. */
  walkedSubflows: Set<string>;
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

/**
 * The `operationId`/`method`/`path` a control node writes into its case, or `null` for a node that
 * makes a request.
 *
 * A control node produces a row that records what the flow did rather than an HTTP call, so it
 * carries no operation. The verb is a label the report reads like any other — `IF`, `WAIT`,
 * `MERGE`, `CHECK` — and the path says, in words, what the node was about.
 */
function controlCaseFields(step: WorkflowStep): { operationId: string; method: string; path: string } | null {
  switch (step.kind) {
    case "branch":
      return { operationId: "", method: "IF", path: `si ${step.condition?.from ?? ""}` };
    case "wait":
      return { operationId: "", method: "WAIT", path: `${step.waitMs ?? 0} ms` };
    case "merge":
      return { operationId: "", method: "MERGE", path: `une ${(step.dependsOn ?? []).length}` };
    case "validate":
      return { operationId: "", method: "CHECK", path: `valida ${step.validate?.from ?? ""}` };
    case "set":
      return {
        operationId: "",
        method: "SET",
        path: (step.set?.assignments ?? []).map((assignment) => assignment.variable).join(", "),
      };
    case "script":
      return { operationId: "", method: "SCRIPT", path: step.script?.from ? `lee ${step.script.from}` : "script" };
    case "poll":
      return { operationId: "", method: "RETRY", path: `repite ${step.poll?.from ?? ""}` };
    case "loop":
      return { operationId: "", method: "LOOP", path: `recorre ${step.loop?.from ?? ""}.${step.loop?.path ?? ""}` };
    case "schema":
      return { operationId: "", method: "SCHEMA", path: `valida ${step.schema?.from ?? ""}` };
    case "notify":
      // The variable's name, never the URL it holds.
      return { operationId: "", method: "NOTIFY", path: `${step.notify?.channel ?? ""} → ${step.notify?.urlVariable ?? ""}` };
    case "subflow":
      return { operationId: "", method: "FLOW", path: `ejecuta ${step.subflow?.workflowId ?? ""}` };
    case "mock":
      return { operationId: "", method: "MOCK", path: String(step.mock?.status ?? "") };
    default:
      return null;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
