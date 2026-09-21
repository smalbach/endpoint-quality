/**
 * The run orchestrator with every collaborator scripted — the same fakes as
 * `test/unit/runs-cov-orchestrator.test.ts`, lifted here so the c100 runs tests can share them.
 */
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
import { InMemoryRunRepository, InMemoryWorkflowRepository } from "@test/support/in-memory-repositories";

export const PROJECT = "project-1";

// The orchestrator logs a run it could not set up; several tests do that on purpose.
Logger.overrideLogger(false);

/** An answer the fake executor gives for a URL: a status and a body, or `null` for «nothing answered». */
export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | null;

export class ScriptedQueue implements RunQueuePort {
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

export function actualOf(reply: NonNullable<Reply>): ActualResponse {
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
export class ScriptedExecutor {
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

export class ScriptedSandbox {
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

export class ScriptedHooks {
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

export type Harness = {
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

export function harness(
  options: { maxCases?: number; variables?: Record<string, string>; secrets?: string[] } = {},
): Harness {
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

export async function saveFlow(h: Harness, steps: WorkflowStep[], name = "Flujo", id = randomUUID()): Promise<string> {
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
    deletedAt: null,
  });
  return id;
}

export async function execute(h: Harness, plan: Partial<RunPlan>): Promise<Run> {
  const id = randomUUID();
  await h.runs.save({
    id,
    projectId: PROJECT,
    environmentId: "env-1",
    specVersionId: null,
    status: "queued",
    plan: {
      order: "default" as never,
      customOrder: [],
      operationIds: [],
      caseSelection: {},
      samples: 1,
      delayMs: 0,
      ...plan,
    },
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

export async function caseOf(h: Harness, run: Run, suffix: string) {
  const found = (await h.runs.listCases(run.id)).filter((item) => item.scenarioId.endsWith(`:${suffix}`));
  assert.equal(found.length, 1, `un caso que termina en «:${suffix}»`);
  return found[0];
}

export async function assertionsOf(h: Harness, run: Run, suffix: string) {
  const runCase = await caseOf(h, run, suffix);
  return (await h.runs.listSteps(runCase.id)).flatMap((step) => step.assertions);
}

export const detailOf = async (h: Harness, run: Run, suffix: string, label: string) =>
  (await assertionsOf(h, run, suffix)).find((assertion) => assertion.label === label)?.detail;

export const fetchStep = (id: string, url: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  kind: "fetch",
  fetch: { method: "GET", url },
  ...extra,
});
