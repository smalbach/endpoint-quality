/**
 * The load generator on its own, with fakes for its ports: what it sends (the variables substituted,
 * the extracted values threaded), how each check operator judges an answer, what a blocked or dead
 * target counts as, and how a run ends — errored, cancelled or judged by its thresholds.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BlockedTargetError, type SafeFetchResult, type SafeRequestOptions } from "@/shared/http/safe-fetch";
import { FixedClock } from "@/shared/clock/clock.port";
import { PerformanceExecutor } from "@/modules/performance/infrastructure/performance-executor";
import {
  PerformanceProgressStream,
  type PerformanceProgressEvent,
} from "@/modules/performance/infrastructure/performance-progress.stream";
import type { PerformancePlanDefinition, PerformanceRun } from "@/modules/performance/domain/model";

const NOW = new Date("2026-05-01T12:00:00.000Z");

const reply = (status: number, body: string, durationMs = 5): SafeFetchResult => ({
  status,
  headers: {},
  setCookie: [],
  body,
  finalUrl: "",
  durationMs,
  timing: { dnsMs: 0, ttfbMs: 1, downloadMs: 0 },
});

function run(definition: PerformancePlanDefinition, overrides: Partial<PerformanceRun> = {}): PerformanceRun {
  return {
    id: "perf-1",
    projectId: "p1",
    planId: "plan-1",
    planName: "Plan",
    environmentId: "e1",
    status: "queued",
    definition,
    progress: { elapsedS: 0, totalS: definition.profile.durationS, requests: 0, vus: 0 },
    summary: null,
    windows: [],
    endpoints: [],
    thresholds: [],
    error: null,
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

type World = {
  run: PerformanceRun | null;
  environment?: unknown;
  environmentThrows?: unknown;
  cancelled?: boolean;
  answer?: (url: string, options: SafeRequestOptions) => SafeFetchResult | Error;
};

function build(world: World) {
  const stored = new Map<string, PerformanceRun>();
  if (world.run) stored.set(world.run.id, structuredClone(world.run));
  const saves: PerformanceRun[] = [];
  const calls: { url: string; options: SafeRequestOptions }[] = [];
  const progress = new PerformanceProgressStream();
  const events: PerformanceProgressEvent[] = [];
  progress.forRun("perf-1").subscribe((event) => events.push(event.data as PerformanceProgressEvent));
  const executor = new PerformanceExecutor(
    {
      findById: async (id: string) => (stored.has(id) ? structuredClone(stored.get(id)!) : null),
      save: async (saved: PerformanceRun) => {
        saves.push(structuredClone(saved));
        stored.set(saved.id, structuredClone(saved));
      },
    } as never,
    { process: () => undefined, isCancelled: () => world.cancelled ?? false } as never,
    {
      findById: async () => {
        if (world.environmentThrows !== undefined) throw world.environmentThrows;
        return world.environment === undefined
          ? { id: "e1", baseUrl: "http://load.test/", variables: {} }
          : world.environment;
      },
    } as never,
    { decrypt: (payload: string) => payload.replace(/^enc:/, "") } as never,
    {
      request: async (url: string, options: SafeRequestOptions) => {
        calls.push({ url, options });
        const answer = (world.answer ?? (() => reply(200, "{}")))(url, options);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as never,
    new FixedClock(NOW),
    progress,
  );
  return { executor, stored, saves, calls, events };
}

const constant = (durationS: number): PerformancePlanDefinition["profile"] => ({ type: "constant", vus: 1, durationS });

describe("el generador de carga, rama por rama", () => {
  test("una corrida que ya no existe no se toca", async () => {
    const world = build({ run: null });
    await world.executor.execute("perf-1");
    assert.equal(world.saves.length, 0);
    assert.equal(world.events.length, 0);
  });

  test("sin entorno —borrado, o nunca puesto— la corrida acaba en error y lo anuncia", async () => {
    const definition = { scenarios: [], profile: constant(1), thresholds: {} };
    for (const world of [
      build({ run: run(definition), environment: null }),
      build({ run: run(definition, { environmentId: null }) }),
    ]) {
      await world.executor.execute("perf-1");
      const stored = world.stored.get("perf-1")!;
      assert.equal(stored.status, "error");
      assert.equal(stored.error, "El entorno ya no existe");
      assert.deepEqual(stored.finishedAt, NOW);
      assert.equal(world.saves[0].status, "running", "antes pasó por running");
      assert.equal(world.events.at(-1)!.status, "error");
      assert.equal(world.calls.length, 0);
    }
  });

  test("un fallo que no es un Error se guarda como texto", async () => {
    const world = build({
      run: run({ scenarios: [], profile: constant(1), thresholds: {} }),
      environmentThrows: "caído",
    });
    await world.executor.execute("perf-1");
    assert.equal(world.stored.get("perf-1")!.error, "caído");
  });

  test("cancelada antes de arrancar: cancelled, sin peticiones y con el evento final", async () => {
    const world = build({
      run: run({
        scenarios: [{ id: "s", name: "s", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/x" }] }],
        profile: constant(30),
        thresholds: { maxErrorRate: 0 },
      }),
      cancelled: true,
    });
    await world.executor.execute("perf-1");
    const stored = world.stored.get("perf-1")!;
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.summary!.requests, 0);
    assert.equal(world.calls.length, 0);
    const last = world.events.at(-1)!;
    assert.equal(last.type, "finished");
    assert.equal(last.status, "cancelled");
  });

  test("un plan sin escenarios no envía nada y pasa: no había nada que fallar", async () => {
    const world = build({ run: run({ scenarios: [], profile: constant(1), thresholds: {} }) });
    await world.executor.execute("perf-1");
    const stored = world.stored.get("perf-1")!;
    assert.equal(stored.status, "passed");
    assert.equal(stored.summary!.requests, 0);
    assert.equal(world.calls.length, 0);
  });

  test("una corrida entera: variables, extracciones, cada operador de comprobación y cada tipo de fallo", async () => {
    const definition: PerformancePlanDefinition = {
      scenarios: [
        {
          id: "flujo",
          name: "Flujo",
          weight: 1,
          thinkMs: 5,
          requests: [
            {
              method: "POST",
              path: "login",
              headers: { "X-Env": "{{envPlain}}" },
              body: { user: "{{user}}" },
              extract: [
                { variable: "token", path: "token" },
                { variable: "missing", path: "no.existe" },
                { variable: "nulled", path: "nul" },
              ],
              checks: [
                { source: "status", operator: "equals", value: 200 },
                { source: "durationMs", operator: "less_than", value: 1000 },
                { source: "body", path: "count", operator: "greater_than", value: 3 },
                { source: "body", path: "name", operator: "contains", value: "ali" },
                { source: "body", path: "name", operator: "not_equals", value: "bob" },
                { source: "body", path: "token", operator: "exists" },
                { source: "body", operator: "exists" },
              ],
            },
            {
              method: "GET",
              path: "/orders/{{token}}/{{missing}}/{{nulled}}",
              headers: { Authorization: "Bearer {{token}}" },
              checks: [{ source: "body", path: "absent", operator: "exists" }],
            },
            { method: "GET", path: "/boom", body: null },
            // No checks: a 2xx is a success on its own.
            { method: "GET", path: "/plain" },
            { method: "GET", path: "/blocked" },
            { method: "GET", path: "/down" },
            {
              method: "PUT",
              path: "/raw",
              body: "id={{token}}",
              checks: [{ source: "status", operator: "equals", value: 204 }],
            },
          ],
        },
        { id: "nunca", name: "Nunca", weight: 0, thinkMs: 0, requests: [{ method: "GET", path: "/never" }] },
      ],
      profile: constant(2),
      thresholds: { maxErrorRate: 0.1 },
    };
    const world = build({
      run: run(definition),
      environment: {
        id: "e1",
        baseUrl: "http://load.test//",
        variables: {
          user: { initial: "", current: "enc:alice", sensitive: true },
          envPlain: { initial: "plano", current: "", sensitive: false },
        },
      },
      answer: (url) => {
        if (url.endsWith("/login"))
          return reply(200, JSON.stringify({ token: "tok-1", count: 5, name: "alice", nul: null }));
        if (url.endsWith("/boom")) return reply(500, "oops");
        if (url.endsWith("/blocked")) return new BlockedTargetError("10.0.0.1", "privada");
        if (url.endsWith("/down")) return new Error("ECONNRESET");
        if (url.endsWith("/raw")) return reply(204, "");
        return reply(200, "{}");
      },
    });
    await world.executor.execute("perf-1");
    const stored = world.stored.get("perf-1")!;

    // What went out: base URL without the doubled slash, variables from the environment (a secret
    // decrypted), extracted values threaded, what was never extracted left as written.
    const login = world.calls.find((call) => call.url === "http://load.test/login")!;
    assert.ok(login, world.calls.map((call) => call.url).join(", "));
    assert.equal(login.options.method, "POST");
    assert.equal(login.options.body, '{"user":"alice"}');
    assert.equal(login.options.headers?.["X-Env"], "plano");
    const order = world.calls.find((call) => call.url.includes("/orders/"))!;
    assert.equal(order.url, "http://load.test/orders/tok-1/{{missing}}/{{nulled}}");
    assert.equal(order.options.headers?.Authorization, "Bearer tok-1");
    assert.equal(order.options.body, undefined);
    assert.equal(world.calls.find((call) => call.url.endsWith("/boom"))!.options.body, undefined);
    assert.equal(world.calls.find((call) => call.url.endsWith("/raw"))!.options.body, "id=tok-1");
    assert.equal(world.calls.some((call) => call.url.endsWith("/never")), false, "peso 0 es nunca");

    // How each was judged, per endpoint.
    const stat = (path: string) => stored.endpoints.find((entry) => entry.path === path)!;
    assert.equal(stat("login").failures, 0, "todas las comprobaciones pasan");
    assert.equal(stat("/raw").failures, 0, "un 204 sin cuerpo pasa su comprobación");
    assert.equal(stat("/plain").failures, 0, "sin comprobaciones, un 200 es un éxito");
    for (const path of ["/orders/tok-1/{{missing}}/{{nulled}}", "/boom", "/blocked", "/down"]) {
      assert.ok(stat(path), path);
      assert.equal(stat(path).failures, stat(path).requests, path);
    }

    // And the run as a whole: judged by its thresholds, with a tick of progress on the way.
    assert.ok(stored.summary!.requests >= 7);
    assert.equal(stored.status, "failed");
    assert.equal(stored.thresholds.length, 1);
    assert.equal(stored.thresholds[0].ok, false);
    assert.equal(stored.progress.totalS, 2);
    assert.equal(stored.progress.vus, 0);
    assert.ok(stored.windows.length >= 1);
    assert.deepEqual(stored.finishedAt, NOW);
    const progressTicks = world.events.filter((event) => event.type === "progress");
    assert.ok(progressTicks.length >= 1, "al menos un tick por segundo");
    assert.equal(progressTicks[0].status, "running");
    assert.equal(progressTicks[0].progress.vus, 1);
    const finished = world.events.filter((event) => event.type === "finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, "failed");
  });

  test("listen registra el ejecutor en la cola", async () => {
    const registered: { handler?: (runId: string) => Promise<void> } = {};
    const executor = new PerformanceExecutor(
      { findById: async () => null } as never,
      { process: (handler: (runId: string) => Promise<void>) => (registered.handler = handler) } as never,
      {} as never,
      {} as never,
      {} as never,
      new FixedClock(NOW),
      new PerformanceProgressStream(),
    );
    executor.listen();
    assert.ok(registered.handler);
    await registered.handler("nada");
  });
});
