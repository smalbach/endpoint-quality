/**
 * The run orchestrator, walked with every collaborator replaced by a scripted fake.
 *
 * The http suites drive it against a real target, which is what proves the wiring. What they can
 * hardly reach are the edges: a cancel that lands between two steps of a loop, a suite deleted
 * between queueing and executing, a poll whose first read already passes, a subflow whose child
 * logs in. Here the executor answers from a script, the queue cancels on the call a test chooses,
 * and the webhook waiter hands back whatever outcome the test wants — so each of those is one
 * assertion about what the orchestrator writes.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";

import {
  DEFAULT_CONFIG,
  resolveOperation,
  type ActualResponse,
  type StepFetch,
  type StepRequest,
  type WorkflowStep,
} from "@eq/runner-core";

import { RunOrchestrator } from "@/modules/runs/infrastructure/run-orchestrator";
import type { ExecutedCase, ExecutedStep, ExecutionTarget } from "@/modules/runs/infrastructure/case-executor";
import type { ExecutionContext } from "@/modules/runs/infrastructure/execution-context";
import type { ResumeMode, Run, RunPause, RunPlan } from "@/modules/runs/domain/model";
import type { RunQueuePort } from "@/modules/runs/domain/ports";
import type { ScriptOutcome } from "@/shared/scripts/script-sandbox";
import type { Env } from "@/shared/config/env";
import type { FlowHookOutcome, OpenFlowHook } from "@/modules/runs/infrastructure/flow-hook-waiter";
import {
  RunCaseRetryingEvent,
  RunFinishedEvent,
  RunHookWaitingEvent,
} from "@/modules/runs/application/events/run.events";
import { SECRET_MASK } from "@/modules/runs/domain/mask-secrets";
import { InMemoryRunRepository, InMemoryWorkflowRepository } from "@test/support/in-memory-repositories";

const PROJECT = "project-1";

// The orchestrator logs a run it could not set up; several tests do that on purpose.
Logger.overrideLogger(false);

/** An answer the fake executor gives for a URL: a status and a body, or `null` for «nothing answered». */
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | null;

class ScriptedQueue implements RunQueuePort {
  checks = 0;
  /** `isCancelled` answers true from this call on (1-based). */
  cancelFrom: number | null = null;
  readonly resumes: ResumeMode[] = [];
  paused: RunPause | null = null;
  async enqueue(): Promise<void> {}
  process(): void {}
  async cancel(): Promise<void> {
    this.cancelFrom = 1;
  }
  async isCancelled(): Promise<boolean> {
    this.checks += 1;
    return this.cancelFrom !== null && this.checks >= this.cancelFrom;
  }
  async pause(_runId: string, at: RunPause | null): Promise<void> {
    this.paused = at;
  }
  async pausedAt(): Promise<RunPause | null> {
    return this.paused;
  }
  async resume(_runId: string, how: ResumeMode): Promise<void> {
    this.resumes.push(how);
  }
  async takeResume(): Promise<ResumeMode | null> {
    return this.resumes.shift() ?? null;
  }
}

function actualOf(reply: NonNullable<Reply>): ActualResponse {
  const raw = reply.body === undefined ? "" : JSON.stringify(reply.body);
  return {
    status: reply.status,
    statusText: "",
    contentType: "application/json",
    headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    body: reply.body ?? null,
    raw,
  };
}

/** The executor, answering fetch nodes from a per-URL script. The last answer of a URL repeats. */
class ScriptedExecutor {
  readonly replies = new Map<string, Reply[]>();
  readonly calls: { url: string; session: string | null; variables: Record<string, string> }[] = [];

  on(url: string, ...replies: Reply[]) {
    this.replies.set(url, replies);
  }

  private answer(url: string): Reply {
    const queue = this.replies.get(url) ?? [{ status: 200, body: {} }];
    return queue.length > 1 ? queue.shift()! : queue[0];
  }

  async fetch(input: { call: StepFetch; target: ExecutionTarget }): Promise<ExecutedCase> {
    const { call, target } = input;
    this.calls.push({ url: call.url, session: target.session?.value ?? null, variables: { ...target.variables } });
    const reply = this.answer(call.url);
    const expected = call.expectedStatus ?? 200;
    const request = {
      index: 0,
      purpose: "act",
      label: `${call.method} ${call.url}`,
      operationId: "",
      method: call.method,
      operationPath: call.url,
      requestPath: call.url,
      expectedStatus: expected,
      expectedShape: "",
      auth: "none",
      samples: 1,
    } as StepRequest;
    // Deliberately unmasked: what reaches the repository has to be masked by the orchestrator.
    const sent = {
      method: call.method,
      url: call.url,
      headers: target.session && call.useSession ? { [target.session.header]: target.session.value } : {},
      body: null,
    };
    const step: ExecutedStep = reply
      ? {
          request,
          ok: reply.status === expected,
          failure: reply.status === expected ? null : "status",
          assertions: [{ label: "Estado HTTP", pass: reply.status === expected, detail: `recibido ${reply.status}` }],
          actual: actualOf(reply),
          latency: { samples: [3], budgetMs: null },
          durationMs: 3,
          sent,
        }
      : {
          request,
          ok: false,
          failure: "network",
          assertions: [{ label: "Conexión", pass: false, detail: "nadie contestó" }],
          actual: null,
          latency: { samples: [], budgetMs: null },
          durationMs: 0,
          sent,
        };
    return { ok: step.ok, steps: [step], durationMs: step.durationMs };
  }

  async graphql(): Promise<ExecutedCase> {
    throw new Error("no graphql in these tests");
  }

  /** A saved request: answers like a fetch to the operation's path. */
  async run(input: { operation: { method: string; path: string }; target: ExecutionTarget }): Promise<ExecutedCase> {
    return this.fetch({
      call: { method: input.operation.method as StepFetch["method"], url: input.operation.path },
      target: input.target,
    });
  }
}

class ScriptedSandbox {
  readonly outcomes: Partial<ScriptOutcome>[] = [];
  async run(): Promise<ScriptOutcome> {
    const given = this.outcomes.shift() ?? {};
    return {
      error: null,
      logs: [],
      tests: [],
      environmentSet: {},
      environmentUnset: [],
      variables: {},
      headers: null,
      visualization: null,
      durationMs: 1,
      ...given,
    };
  }
}

class ScriptedHooks {
  outcome: FlowHookOutcome = { kind: "timeout" };
  async open(_runId: string, _runCase: unknown, stepId: string): Promise<OpenFlowHook> {
    return {
      id: `hook-${stepId}`,
      method: "POST",
      timeoutMs: 4_000,
      expiresAt: Date.now() + 4_000,
      url: "http://api.test/hooks/secret-token",
      redactedUrl: "http://api.test/hooks/••••",
    };
  }
  async wait(): Promise<FlowHookOutcome> {
    return this.outcome;
  }
}

type Harness = {
  orchestrator: RunOrchestrator;
  runs: InMemoryRunRepository;
  workflows: InMemoryWorkflowRepository;
  queue: ScriptedQueue;
  executor: ScriptedExecutor;
  sandbox: ScriptedSandbox;
  hooks: ScriptedHooks;
  events: unknown[];
  target: ExecutionTarget;
};

function harness(options: { maxCases?: number; variables?: Record<string, string>; secrets?: string[] } = {}): Harness {
  const runs = new InMemoryRunRepository();
  const workflows = new InMemoryWorkflowRepository();
  const queue = new ScriptedQueue();
  const executor = new ScriptedExecutor();
  const sandbox = new ScriptedSandbox();
  const hooks = new ScriptedHooks();
  const events: unknown[] = [];
  const target: ExecutionTarget = {
    baseUrl: "http://api.test",
    writesAllowed: true,
    spec: null,
    specError: "sin contrato",
    credentials: [],
    variables: { ...(options.variables ?? {}) },
    session: null,
    cookies: [],
    ...(options.secrets ? { secrets: options.secrets } : {}),
  };
  // Two plain reads, resolved with the default configuration: enough for the generated matrix to
  // have a case per operation, and for a saved request to find its operation.
  const resolved = [
    resolveOperation(
      { id: "getThing", method: "GET", path: "/things/1", summary: "", tag: "", statuses: [200], parameters: [] },
      DEFAULT_CONFIG,
    ),
    resolveOperation(
      { id: "listThings", method: "GET", path: "/things", summary: "", tag: "", statuses: [200], parameters: [] },
      DEFAULT_CONFIG,
    ),
  ];
  const context: ExecutionContext = { config: DEFAULT_CONFIG, resolved, target, authEnabled: false };
  const orchestrator = new RunOrchestrator(
    runs,
    queue,
    workflows,
    { now: () => new Date() },
    { MAX_RUN_CASES: options.maxCases ?? 500 } as Env,
    sandbox,
    {} as never,
    executor as never,
    { build: async () => context } as never,
    { publish: (event: unknown) => events.push(event) } as never,
    {} as never,
    hooks as never,
  );
  return { orchestrator, runs, workflows, queue, executor, sandbox, hooks, events, target };
}

async function saveFlow(h: Harness, steps: WorkflowStep[], name = "Flujo", id = randomUUID()): Promise<string> {
  const now = new Date();
  await h.workflows.saveWorkflow({
    id,
    projectId: PROJECT,
    name,
    description: null,
    status: "ready" as never,
    definition: { steps },
    createdAt: now,
    updatedAt: now,
    updatedBy: "tester",
  });
  return id;
}

async function execute(h: Harness, plan: Partial<RunPlan>): Promise<Run> {
  const id = randomUUID();
  await h.runs.save({
    id,
    projectId: PROJECT,
    environmentId: "env-1",
    specVersionId: null,
    status: "queued",
    plan: { order: "default" as never, customOrder: [], operationIds: [], caseSelection: {}, samples: 1, delayMs: 0, ...plan },
    totals: { cases: 0, completed: 0, passed: 0, failed: 0, skipped: 0 },
    triggeredByKind: "user",
    triggeredBy: "tester",
    startedAt: new Date(),
    finishedAt: null,
    error: null,
  });
  await h.orchestrator.execute(id);
  return (await h.runs.findById(id))!;
}

async function caseOf(h: Harness, run: Run, suffix: string) {
  const found = (await h.runs.listCases(run.id)).filter((item) => item.scenarioId.endsWith(`:${suffix}`));
  assert.equal(found.length, 1, `un caso que termina en «:${suffix}»`);
  return found[0];
}

async function assertionsOf(h: Harness, run: Run, suffix: string) {
  const runCase = await caseOf(h, run, suffix);
  return (await h.runs.listSteps(runCase.id)).flatMap((step) => step.assertions);
}

const detailOf = async (h: Harness, run: Run, suffix: string, label: string) =>
  (await assertionsOf(h, run, suffix)).find((assertion) => assertion.label === label)?.detail;

const fetchStep = (id: string, url: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  kind: "fetch",
  fetch: { method: "GET", url },
  ...extra,
});

describe("preparar una corrida que ya no se puede ejecutar", () => {
  test("una corrida que desapareció de la base no escribe nada", async () => {
    const h = harness();
    await h.orchestrator.execute("no-existe");
    assert.equal(h.runs.runs.size, 0);
    assert.equal(h.events.length, 0);
  });

  test("una suite borrada entre encolar y ejecutar deja la corrida en error y lo dice", async () => {
    const h = harness();
    const run = await execute(h, { suiteId: "suite-borrada" });
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /La suite "suite-borrada" ya no existe/);
    const finished = h.events.find((event) => event instanceof RunFinishedEvent) as RunFinishedEvent;
    assert.equal(finished.status, "error");
  });

  test("un conjunto de datos borrado deja la corrida en error", async () => {
    const h = harness();
    const flow = await saveFlow(h, [fetchStep("uno", "/uno")]);
    const run = await execute(h, { workflowId: flow, datasetId: "datos-borrados" });
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /El conjunto de datos "datos-borrados" ya no existe/);
  });

  test("un paso que apunta a una prueba borrada, o a una operación que el contrato ya no tiene", async () => {
    const h = harness();
    const noTemplate = await saveFlow(h, [{ id: "pide", requestTemplateId: "plantilla-borrada" }]);
    const first = await execute(h, { workflowId: noTemplate });
    assert.equal(first.status, "error");
    assert.match(first.error ?? "", /referencia la prueba inexistente "plantilla-borrada"/);

    const now = new Date();
    await h.workflows.saveTemplate({
      id: "plantilla",
      projectId: PROJECT,
      name: "Consultar",
      operationId: "getGone",
      description: null,
      expectedStatus: 200,
      parameters: {},
      headers: {},
      body: { type: "none" },
      auth: "primary",
      createdAt: now,
      updatedAt: now,
      updatedBy: "tester",
    } as never);
    const noOperation = await saveFlow(h, [{ id: "pide", requestTemplateId: "plantilla" }]);
    const second = await execute(h, { workflowId: noOperation });
    assert.equal(second.status, "error");
    assert.match(second.error ?? "", /La prueba "Consultar" referencia la operación inexistente "getGone"/);
  });
});

describe("la matriz generada", () => {
  test("con pausa entre casos recorre todas las operaciones, una detrás de otra", async () => {
    const h = harness();
    const run = await execute(h, { order: "safe" as never, delayMs: 3 });
    assert.equal(run.status, "passed");
    const cases = await h.runs.listCases(run.id);
    assert.ok(cases.length >= 2, JSON.stringify(cases.map((item) => item.scenarioId)));
    assert.ok(cases.every((item) => item.status === "passed"));
    assert.deepEqual(
      [...new Set(h.executor.calls.map((call) => call.url))].sort(),
      ["/things", "/things/1"],
    );
  });

  test("cancelada mientras espera a una persona, no ejecuta nada y deja la pausa limpia", async () => {
    const h = harness();
    // 1: the boundary before the first case; 2: inside the wait.
    h.queue.cancelFrom = 2;
    const run = await execute(h, { order: "safe" as never, pauseMode: "step" });
    assert.equal(run.status, "cancelled");
    assert.equal(h.executor.calls.length, 0);
    assert.ok((await h.runs.listCases(run.id)).every((item) => item.status === "queued"));
    assert.equal(h.queue.paused, null);
  });
});

describe("el recorrido de un flujo", () => {
  test("un nodo GraphQL se nombra por su operación o por su URL, y una unión sin entradas pasa", async () => {
    const h = harness();
    const flow = await saveFlow(h, [
      { id: "con-nombre", kind: "graphql", graphql: { url: "/gql", query: "{ a }", operationName: "Cosas" } },
      { id: "sin-nombre", kind: "graphql", graphql: { url: "/gql", query: "{ a }" } },
      { id: "une", kind: "merge" },
    ] as WorkflowStep[]);
    // The prepared rows are written before anything runs; the graphql fake throwing makes the run
    // `error`, which is fine — what is asserted is how the queued rows were named.
    const run = await execute(h, { workflowId: flow });
    const cases = await h.runs.listCases(run.id);
    const named = cases.find((item) => item.scenarioId.endsWith(":con-nombre"));
    const anonymous = cases.find((item) => item.scenarioId.endsWith(":sin-nombre"));
    const merge = cases.find((item) => item.scenarioId.endsWith(":une"));
    assert.equal(named?.method, "GQL");
    assert.equal(named?.path, "Cosas");
    assert.equal(anonymous?.path, "/gql");
    assert.equal(merge?.method, "MERGE");
    assert.equal(merge?.path, "une 0");
  });

  test("la pausa entre despachos espera y la concurrencia ausente es uno", async () => {
    const h = harness();
    const flow = await saveFlow(h, [fetchStep("a", "/a"), fetchStep("b", "/b", { dependsOn: ["a"] })]);
    const run = await execute(h, { workflowId: flow, delayMs: 5 });
    assert.equal(run.status, "passed");
    assert.deepEqual(
      h.executor.calls.map((call) => call.url),
      ["/a", "/b"],
    );
  });

  test("cancelar en mitad de una fila de datos deja las filas siguientes sin tocar", async () => {
    const h = harness();
    const flow = await saveFlow(h, [fetchStep("a", "/a"), fetchStep("b", "/b", { dependsOn: ["a"] })]);
    const now = new Date();
    await h.workflows.saveDataset({
      id: "datos",
      projectId: PROJECT,
      workflowId: flow,
      name: "Dos filas",
      rows: [{ sku: "uno" }, { sku: "dos" }],
      createdAt: now,
      updatedAt: now,
      updatedBy: "tester",
    });
    // The first check lets «a» go; the second, before «b», says cancelled.
    h.queue.cancelFrom = 2;
    const run = await execute(h, { workflowId: flow, datasetId: "datos" });
    assert.equal(run.status, "cancelled");
    const cases = await h.runs.listCases(run.id);
    assert.equal(cases.find((item) => item.scenarioId.endsWith(":a@0"))?.status, "passed");
    assert.equal(cases.find((item) => item.scenarioId.endsWith(":b@0"))?.status, "queued");
    // Row two never started: its variables were never bound and nothing of it was sent.
    assert.equal(cases.filter((item) => item.scenarioId.endsWith("@1")).every((item) => item.status === "queued"), true);
    assert.deepEqual(
      h.executor.calls.map((call) => call.variables["dataset.sku"]),
      ["uno"],
    );
  });

  test("la sesión que abre un paso se tapa en todo lo que se guarda después", async () => {
    const h = harness({ secrets: undefined });
    const flow = await saveFlow(h, [
      fetchStep("entra", "/login", { authorizes: { from: "body", path: "token" } }),
      {
        id: "yo",
        kind: "fetch",
        fetch: { method: "GET", url: "/me", useSession: true },
        dependsOn: ["entra"],
      },
    ]);
    h.executor.on("/login", { status: 200, body: { token: "tok-muy-secreto-123" } });
    const run = await execute(h, { workflowId: flow });
    assert.equal(run.status, "passed");
    assert.equal(h.executor.calls[1].session, "Bearer tok-muy-secreto-123");
    const me = await caseOf(h, run, "yo");
    const [stored] = await h.runs.listSteps(me.id);
    assert.equal(stored.request?.headers.Authorization, SECRET_MASK);
    assert.doesNotMatch(JSON.stringify(stored), /tok-muy-secreto-123/);
  });

  test("un fallo de un nodo de control con «detener» salta todo lo que quedaba", async () => {
    const h = harness();
    const flow = await saveFlow(h, [
      { id: "asigna", kind: "set", set: { assignments: [{ variable: "x", value: "{{nadie}}" }] }, onError: "stop" },
      fetchStep("suelto", "/suelto"),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal(run.status, "failed");
    assert.equal((await caseOf(h, run, "asigna")).status, "failed");
    assert.equal((await caseOf(h, run, "suelto")).status, "skipped");
    assert.equal(h.executor.calls.length, 0);
  });
});

describe("un paso de petición guardada", () => {
  test("se envía con su operación, y una unión detrás pasa de largo", async () => {
    const h = harness();
    const now = new Date();
    await h.workflows.saveTemplate({
      id: "consulta",
      projectId: PROJECT,
      name: "Consultar",
      operationId: "getThing",
      description: null,
      expectedStatus: 200,
      parameters: {},
      headers: {},
      body: { type: "none" },
      auth: "primary",
      createdAt: now,
      updatedAt: now,
      updatedBy: "tester",
    } as never);
    const flow = await saveFlow(h, [
      { id: "pide", requestTemplateId: "consulta" },
      { id: "une", kind: "merge", dependsOn: ["pide"] },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal(run.status, "passed");
    const pide = await caseOf(h, run, "pide");
    assert.equal(pide.method, "GET");
    assert.equal(pide.path, "/things/1");
    assert.equal(pide.operationId, "getThing");
    assert.equal((await caseOf(h, run, "une")).path, "une 1");
    assert.deepEqual(
      h.executor.calls.map((call) => call.url),
      ["/things/1"],
    );
  });
});

describe("el nodo script", () => {
  test("sus pm.test sin mensaje se leen «Pasó» y «Falló», y lo que borra desaparece de las variables", async () => {
    const h = harness({ variables: { borrame: "sí", queda: "sí" } });
    h.sandbox.outcomes.push({
      tests: [
        { name: "bien", passed: true },
        { name: "mal", passed: false },
      ] as never,
      environmentUnset: ["borrame"],
      visualization: { template: "<p/>", data: null } as never,
      logs: [{ level: "log", text: "hola" }] as never,
    });
    const flow = await saveFlow(h, [
      { id: "guion", kind: "script", script: { code: "pm.test('x', () => {})" } },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const guion = await caseOf(h, run, "guion");
    assert.equal(guion.status, "failed");
    assert.equal(guion.failure, "check");
    assert.equal(await detailOf(h, run, "guion", "pm.test: bien"), "Pasó");
    assert.equal(await detailOf(h, run, "guion", "pm.test: mal"), "Falló");
    assert.match((await detailOf(h, run, "guion", "pm.visualizer")) ?? "", /solo se dibuja/);
    assert.equal(await detailOf(h, run, "guion", "console.log"), "hola");
    // The script did not throw, so its unset took effect even though a test failed.
    assert.equal(h.target.variables.borrame, undefined);
    assert.equal(h.target.variables.queda, "sí");
  });
});

describe("forEach sobre la respuesta de otro paso", () => {
  test("sin respuesta de la que leer, el paso se salta en vez de fallar", async () => {
    const h = harness();
    h.executor.on("/lista", null);
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista", { onError: "continue" }),
      fetchStep("cada", "/cada/{{item}}", { dependsOn: ["lista"], forEach: { from: "lista", path: "items", as: "item" } }),
    ]);
    const run = await execute(h, { workflowId: flow });
    assert.equal((await caseOf(h, run, "lista")).status, "failed");
    assert.equal((await caseOf(h, run, "cada")).status, "skipped");
    assert.equal(h.executor.calls.filter((call) => call.url.startsWith("/cada")).length, 0);
  });

  test("una captura que no encuentra nada falla el elemento como «flujo», y el tope recorta y lo avisa", async () => {
    const h = harness({ maxCases: 3 });
    h.executor.on("/lista", { status: 200, body: { items: [1, 2, 3, 4] } });
    h.executor.on("/cada/{{item}}", { status: 200, body: { nada: true } });
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista"),
      fetchStep("cada", "/cada/{{item}}", {
        dependsOn: ["lista"],
        forEach: { from: "lista", path: "items", as: "item", max: 4 },
        captures: [{ variable: "id", from: "body", path: "id" }],
      }),
    ]);
    const run = await execute(h, { workflowId: flow });
    const cases = (await h.runs.listCases(run.id)).filter((item) => /:cada#\d$/.test(item.scenarioId));
    // Two cases were counted up front, so the ceiling of three leaves room for one extra element.
    assert.equal(cases.length, 2);
    assert.ok(cases.every((item) => item.status === "failed" && item.failure === "flow"));
    const first = await h.runs.listSteps(cases.find((item) => item.scenarioId.endsWith("#0"))!.id);
    const labels = first[0].assertions.map((assertion) => `${assertion.label}: ${assertion.detail}`);
    assert.ok(labels.includes("Variables capturadas: No se encontraron: id"), labels.join(" | "));
    assert.ok(labels.some((label) => /^Bucle recortado: Se recorrieron 2 de 4 elementos/.test(label)), labels.join(" | "));
    assert.equal(run.status, "failed");
  });
});

describe("el nodo de reintento (retry)", () => {
  test("un destino que no va antes del paso vigilado es un error de configuración que enruta", async () => {
    const h = harness();
    h.executor.on("/falla", { status: 500 });
    const flow = await saveFlow(h, [
      fetchStep("otro", "/otro"),
      fetchStep("falla", "/falla"),
      { id: "reintenta", kind: "retry", dependsOn: ["falla"], rerun: { from: "falla", target: "otro", attempts: 2, delayMs: 0 } },
      fetchStep("agotado", "/agotado", { dependsOn: ["reintenta"] }),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "reintenta");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "config");
    assert.match((await detailOf(h, run, "reintenta", "Reintento")) ?? "", /«otro» no va antes de «falla»/);
    // `routes: true`: the «si se agota» side runs.
    assert.equal((await caseOf(h, run, "agotado")).status, "passed");
  });

  test("un solo reintento que vuelve a fallar se cuenta en singular, tras esperar su pausa", async () => {
    const h = harness();
    h.executor.on("/falla", { status: 500 });
    const flow = await saveFlow(h, [
      fetchStep("falla", "/falla"),
      { id: "reintenta", kind: "retry", dependsOn: ["falla"], rerun: { from: "falla", target: "falla", attempts: 1, delayMs: 2 } },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal(
      await detailOf(h, run, "reintenta", "Reintento"),
      "«falla» siguió fallando tras 1 reintento: el flujo sigue por «si se agota»",
    );
    assert.equal(h.executor.calls.length, 2);
    const retrying = h.events.filter((event) => event instanceof RunCaseRetryingEvent) as RunCaseRetryingEvent[];
    assert.deepEqual(
      retrying.map((event) => [event.attempt, event.attempts, event.waitMs]),
      [[2, 2, 2]],
    );
  });

  test("cancelada antes del primer reintento, lo dice y no repite nada", async () => {
    const h = harness();
    h.executor.on("/falla", { status: 500 });
    const flow = await saveFlow(h, [
      fetchStep("falla", "/falla"),
      { id: "reintenta", kind: "retry", dependsOn: ["falla"], rerun: { from: "falla", target: "falla", attempts: 3, delayMs: 0 } },
    ] as WorkflowStep[]);
    // 1: before «falla»; 2: before «reintenta»; 3: inside the node, before its first walk.
    h.queue.cancelFrom = 3;
    const run = await execute(h, { workflowId: flow });
    assert.equal(await detailOf(h, run, "reintenta", "Reintento"), "La corrida se canceló antes de repetir");
    assert.equal(h.executor.calls.length, 1);
    assert.equal(run.status, "cancelled");
  });
});

describe("el nodo poll", () => {
  test("sin respuesta del paso que repite, falla por configuración sin enviar nada", async () => {
    const h = harness();
    h.executor.on("/trabajo", null);
    const flow = await saveFlow(h, [
      fetchStep("trabajo", "/trabajo", { onError: "continue" }),
      { id: "espera", kind: "poll", dependsOn: ["trabajo"], poll: { from: "trabajo", attempts: 3, delayMs: 0 } },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "config");
    assert.equal(await detailOf(h, run, "espera", "Reintento"), "El paso trabajo no respondió");
    assert.equal(h.executor.calls.length, 1);
  });

  test("sin comprobaciones, la primera respuesta ya cumple y lo que captura falla el nodo", async () => {
    const h = harness();
    h.executor.on("/trabajo", { status: 200, body: { estado: "hecho" } });
    const flow = await saveFlow(h, [
      fetchStep("trabajo", "/trabajo"),
      {
        id: "espera",
        kind: "poll",
        dependsOn: ["trabajo"],
        poll: { from: "trabajo", attempts: 3, delayMs: 0 },
        captures: [{ variable: "resultado", from: "body", path: "resultado" }],
      },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "flow");
    assert.equal(await detailOf(h, run, "espera", "Reintento"), "La respuesta de trabajo ya cumplía: sin reenvíos");
    assert.equal(await detailOf(h, run, "espera", "Variables capturadas"), "No se encontraron: resultado");
    assert.equal(h.executor.calls.length, 1);
  });

  test("un solo reenvío que no cumple se dice en singular, tras la pausa", async () => {
    const h = harness();
    h.executor.on("/trabajo", { status: 200, body: { estado: "pendiente" } });
    const flow = await saveFlow(h, [
      fetchStep("trabajo", "/trabajo"),
      {
        id: "espera",
        kind: "poll",
        dependsOn: ["trabajo"],
        poll: { from: "trabajo", attempts: 1, delayMs: 2 },
        checks: [{ source: "body", path: "estado", operator: "equals", value: "hecho" }],
      },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "check");
    assert.equal(await detailOf(h, run, "espera", "Reintento"), "No cumplió tras 1 reenvío");
    assert.equal(h.executor.calls.length, 2);
  });

  test("cumple en un reenvío y su captura entra en las variables", async () => {
    const h = harness();
    h.executor.on("/trabajo", { status: 200, body: { estado: "pendiente" } }, { status: 200, body: { estado: "hecho", resultado: "r-1" } });
    const flow = await saveFlow(h, [
      fetchStep("trabajo", "/trabajo"),
      {
        id: "espera",
        kind: "poll",
        dependsOn: ["trabajo"],
        poll: { from: "trabajo", attempts: 3, delayMs: 0 },
        checks: [{ source: "body", path: "estado", operator: "equals", value: "hecho" }],
        captures: [{ variable: "resultado", from: "body", path: "resultado" }],
      },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal((await caseOf(h, run, "espera")).status, "passed");
    assert.equal(await detailOf(h, run, "espera", "Reintento"), "Cumplió en el reenvío 1 de 3");
    assert.equal(h.target.variables.resultado, "r-1");
  });

  test("un reenvío cuya captura no encuentra nada falla el nodo como «flujo»", async () => {
    const h = harness();
    h.executor.on("/trabajo", { status: 200, body: { estado: "pendiente" } }, { status: 200, body: { estado: "hecho" } });
    const flow = await saveFlow(h, [
      fetchStep("trabajo", "/trabajo"),
      {
        id: "espera",
        kind: "poll",
        dependsOn: ["trabajo"],
        poll: { from: "trabajo", attempts: 3, delayMs: 0 },
        checks: [{ source: "body", path: "estado", operator: "equals", value: "hecho" }],
        captures: [{ variable: "resultado", from: "body", path: "resultado" }],
      },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "flow");
  });

  test("cancelada antes del primer reenvío, dice que se canceló", async () => {
    const h = harness();
    h.executor.on("/trabajo", { status: 200, body: { estado: "pendiente" } });
    const flow = await saveFlow(h, [
      fetchStep("trabajo", "/trabajo"),
      {
        id: "espera",
        kind: "poll",
        dependsOn: ["trabajo"],
        poll: { from: "trabajo", attempts: 3, delayMs: 0 },
        checks: [{ source: "body", path: "estado", operator: "equals", value: "hecho" }],
      },
    ] as WorkflowStep[]);
    h.queue.cancelFrom = 3;
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.status, "failed");
    assert.equal(await detailOf(h, run, "espera", "Reintento"), "La corrida se canceló antes de repetir");
    assert.equal(run.status, "cancelled");
  });
});

describe("el nodo loop", () => {
  const body = (extra: Partial<WorkflowStep> = {}): WorkflowStep =>
    fetchStep("visita", "/visita/{{p}}", { dependsOn: ["recorre"], inLoop: "recorre", ...extra });

  test("sin respuesta con lista, el nodo falla y su cuerpo se salta", async () => {
    const h = harness();
    h.executor.on("/lista", null);
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista", { onError: "continue" }),
      { id: "recorre", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "items", as: "p" } },
      body(),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal((await caseOf(h, run, "recorre")).status, "failed");
    assert.equal(await detailOf(h, run, "recorre", "Bucle"), "No hay una lista en lista → items");
    assert.equal((await caseOf(h, run, "visita")).status, "skipped");
  });

  test("una lista vacía no ejecuta el cuerpo y lo dice", async () => {
    const h = harness();
    h.executor.on("/lista", { status: 200, body: { items: [] } });
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista"),
      { id: "recorre", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "items", as: "p" } },
      body(),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal((await caseOf(h, run, "recorre")).status, "passed");
    assert.equal(await detailOf(h, run, "recorre", "Bucle"), "La lista está vacía: el cuerpo no se ejecutó");
    assert.equal((await caseOf(h, run, "visita")).status, "skipped");
  });

  test("el tope de la corrida recorta vueltas enteras y un cuerpo que falla lista qué vueltas fallaron", async () => {
    // lista + recorre + visita = 3 counted up front; 5 leaves room for two more iterations of one step.
    const h = harness({ maxCases: 5 });
    h.executor.on("/lista", { status: 200, body: { items: ["a", "b", "c", "d", "e"] } });
    h.executor.on("/visita/{{p}}", { status: 200 }, { status: 500 }, { status: 200 });
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista"),
      { id: "recorre", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "items", as: "p", max: 4 } },
      body(),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "recorre");
    assert.equal(node.status, "failed");
    assert.equal(await detailOf(h, run, "recorre", "Bucle"), "Fallaron 1 de 3 vueltas (2)");
    assert.equal(
      await detailOf(h, run, "recorre", "Bucle recortado"),
      "Se recorrieron 3 de 4 elementos: la corrida llegó al tope de 5 casos",
    );
    assert.deepEqual(
      h.executor.calls.filter((call) => call.url.startsWith("/visita")).map((call) => call.variables.p),
      ["a", "b", "c"],
    );
  });

  test("un paso del cuerpo que detiene el flujo salta el resto de esa vuelta y ya no hay más vueltas", async () => {
    const h = harness();
    h.executor.on("/lista", { status: 200, body: { items: [1, 2, 3] } });
    h.executor.on("/visita/{{p}}", { status: 500 });
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista"),
      { id: "recorre", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "items", as: "p" } },
      body({ onError: "stop" }),
      fetchStep("detalle", "/detalle", { dependsOn: ["visita"] }),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const cases = await h.runs.listCases(run.id);
    assert.equal(cases.find((item) => item.scenarioId.endsWith(":visita#0"))?.status, "failed");
    assert.equal(cases.find((item) => item.scenarioId.endsWith(":detalle#0"))?.status, "skipped");
    assert.equal(cases.some((item) => item.scenarioId.endsWith("#1")), false);
    assert.equal(await detailOf(h, run, "recorre", "Bucle"), "Fallaron 1 de 1 vueltas (1)");
    assert.equal(run.status, "failed");
  });

  test("cancelada entre vueltas, el bucle se detiene y lo que recorrió cuenta", async () => {
    const h = harness();
    h.executor.on("/lista", { status: 200, body: { items: [1, 2, 3] } });
    const flow = await saveFlow(h, [
      fetchStep("lista", "/lista"),
      { id: "recorre", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "items", as: "p" } },
      body(),
    ] as WorkflowStep[]);
    // 1 before «lista», 2 before «recorre», 3 before the first iteration, 4 before the second.
    h.queue.cancelFrom = 4;
    const run = await execute(h, { workflowId: flow });
    assert.equal(run.status, "cancelled");
    assert.equal(await detailOf(h, run, "recorre", "Bucle"), "Recorrió 1 de 3 elementos");
    assert.equal(h.executor.calls.filter((call) => call.url.startsWith("/visita")).length, 1);
  });
});

describe("el nodo webhook", () => {
  const delivered = (contentType: string, body: unknown): FlowHookOutcome => ({
    kind: "delivered",
    delivery: {
      method: "POST",
      contentType,
      headers: contentType ? { "content-type": contentType } : {},
      body,
      raw: typeof body === "string" ? body : JSON.stringify(body),
      receivedAt: new Date().toISOString(),
    },
  });

  test("una llamada sin tipo que no cumple la comprobación falla como «check»", async () => {
    const h = harness();
    h.hooks.outcome = delivered("", "texto");
    const flow = await saveFlow(h, [
      {
        id: "espera",
        kind: "webhook",
        webhook: { timeoutMs: 4_000 },
        checks: [{ source: "body", path: "estado", operator: "equals", value: "ok" }],
      },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "check");
    assert.equal(await detailOf(h, run, "espera", "Webhook"), "Llegó un POST");
    // One step row, rewritten in place when the wait ended.
    assert.equal((await h.runs.listSteps(node.id)).length, 1);
    assert.ok(h.events.some((event) => event instanceof RunHookWaitingEvent));
  });

  test("una llamada sin comprobaciones pasa y lo que trae lo leen los nodos siguientes", async () => {
    const h = harness();
    h.hooks.outcome = delivered("application/json", { pedido: "p-9" });
    const flow = await saveFlow(h, [
      {
        id: "espera",
        kind: "webhook",
        webhook: { timeoutMs: 4_000 },
        captures: [{ variable: "pedido", from: "body", path: "pedido" }],
      },
      {
        id: "decide",
        kind: "branch",
        dependsOn: ["espera"],
        condition: { from: "espera", check: { source: "body", path: "pedido", operator: "equals", value: "p-9" } },
      },
      fetchStep("si", "/si", { dependsOn: ["decide"], branch: { of: "decide", take: "then" } }),
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    assert.equal(run.status, "passed");
    assert.equal(h.target.variables.pedido, "p-9");
    assert.equal(await detailOf(h, run, "espera", "Variables capturadas"), "pedido");
    assert.equal((await caseOf(h, run, "si")).status, "passed");
  });

  test("una llamada JSON que cumple pero no trae lo que se captura falla como «flujo»", async () => {
    const h = harness();
    h.hooks.outcome = delivered("application/json", { estado: "ok" });
    const flow = await saveFlow(h, [
      {
        id: "espera",
        kind: "webhook",
        webhook: { timeoutMs: 4_000 },
        checks: [{ source: "body", path: "estado", operator: "equals", value: "ok" }],
        captures: [{ variable: "pedido", from: "body", path: "pedido" }],
      },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: flow });
    const node = await caseOf(h, run, "espera");
    assert.equal(node.failure, "flow");
    assert.equal(await detailOf(h, run, "espera", "Webhook"), "Llegó un POST con application/json");
    assert.equal(await detailOf(h, run, "espera", "Variables capturadas"), "No se encontraron: pedido");
  });
});

describe("el nodo sub-flujo", () => {
  test("una entrada que nombra una variable inexistente falla el nodo y salta a todos sus hijos", async () => {
    const h = harness();
    const child = await saveFlow(h, [fetchStep("hijo", "/hijo")], "Hijo");
    const parent = await saveFlow(h, [
      { id: "sub", kind: "subflow", subflow: { workflowId: child, inputs: [{ variable: "nombre", value: "{{falta}}" }] } },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: parent });
    const node = await caseOf(h, run, "sub");
    assert.equal(node.status, "failed");
    assert.equal(node.failure, "config");
    assert.equal(await detailOf(h, run, "sub", "Entradas del sub-flujo"), "Faltan variables: falta");
    assert.equal((await caseOf(h, run, "sub>hijo")).status, "skipped");
    assert.equal(h.executor.calls.length, 0);
  });

  test("la sesión que abre el hijo pasa al padre, y una salida que no aparece falla el nodo", async () => {
    const h = harness();
    h.executor.on("/login", { status: 200, body: { token: "sesion-del-hijo-42" } });
    const child = await saveFlow(h, [fetchStep("entra", "/login", { authorizes: { from: "body", path: "token" } })], "Login");
    const parent = await saveFlow(h, [
      { id: "sub", kind: "subflow", subflow: { workflowId: child, outputs: ["noexiste"] } },
      { id: "usa", kind: "fetch", fetch: { method: "GET", url: "/me", useSession: true }, dependsOn: ["sub"], onError: "continue" },
    ] as WorkflowStep[]);
    const run = await execute(h, { workflowId: parent });
    const node = await caseOf(h, run, "sub");
    assert.equal(node.status, "failed");
    assert.equal(await detailOf(h, run, "sub", "Sub-flujo"), "Pasaron sus 1 paso");
    assert.equal(await detailOf(h, run, "sub", "Variables devueltas"), "No se encontraron: noexiste");
    assert.equal(await detailOf(h, run, "sub", "Sesión obtenida"), "Los pasos siguientes presentarán Authorization");
    assert.equal(h.target.session?.value, "Bearer sesion-del-hijo-42");
  });

  test("un sub-flujo dentro de otro renombra a sus nietos bajo la ruta completa", async () => {
    const h = harness();
    const grandchild = await saveFlow(h, [fetchStep("nieto", "/nieto")], "Nieto");
    const child = await saveFlow(h, [{ id: "interno", kind: "subflow", subflow: { workflowId: grandchild } }] as WorkflowStep[], "Hijo");
    const parent = await saveFlow(h, [{ id: "externo", kind: "subflow", subflow: { workflowId: child } }] as WorkflowStep[], "Padre");
    const run = await execute(h, { workflowId: parent });
    assert.equal(run.status, "passed");
    const deepest = await caseOf(h, run, "externo>interno>nieto");
    assert.equal(deepest.status, "passed");
    assert.equal(deepest.scenarioId, `workflow:${parent}:externo>interno>nieto`);
  });

  test("cancelada dentro del hijo, el nodo lo dice", async () => {
    const h = harness();
    const child = await saveFlow(h, [fetchStep("uno", "/uno"), fetchStep("dos", "/dos", { dependsOn: ["uno"] })], "Hijo");
    const parent = await saveFlow(h, [{ id: "sub", kind: "subflow", subflow: { workflowId: child } }] as WorkflowStep[]);
    // 1 before «sub», 2 before «uno», 3 before «dos».
    h.queue.cancelFrom = 3;
    const run = await execute(h, { workflowId: parent });
    assert.equal(run.status, "cancelled");
    assert.equal(await detailOf(h, run, "sub", "Sub-flujo"), "La corrida se canceló dentro del sub-flujo");
    assert.equal((await caseOf(h, run, "sub")).status, "failed");
  });
});
