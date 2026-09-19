/**
 * The security executor on its own: fed plain fakes for every port, so each branch of the walk —
 * a missing environment, a cancel between probes, a probe that never got an answer, a forged JWT —
 * is asserted on the stored run and on the progress events, with no network and no Nest.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ProbeResult } from "@eq/security-rules";

import { BlockedTargetError, type SafeFetchResult, type SafeRequestOptions } from "@/shared/http/safe-fetch";
import { FixedClock } from "@/shared/clock/clock.port";
import { SecurityRunExecutor } from "@/modules/security-runs/infrastructure/security-run-executor";
import {
  SecurityRunProgressStream,
  type SecurityProgressEvent,
} from "@/modules/security-runs/infrastructure/security-run-progress.stream";
import type { SecurityRun } from "@/modules/security-runs/domain/model";
import { normalizeSelection, RULE_KEYS } from "@eq/security-rules";

const NOW = new Date("2026-05-01T12:00:00.000Z");

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A real-looking JWT, so the executor can forge the jwt-attack variants from it. */
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "admin", exp: 4102444800 })}.firma`;

type Reply = SafeFetchResult | Error | string;

class FakeHttp {
  readonly calls: { url: string; options: SafeRequestOptions }[] = [];
  constructor(private readonly answer: (url: string, options: SafeRequestOptions) => Reply) {}
  async get(url: string): Promise<SafeFetchResult> {
    return this.request(url, { method: "GET" });
  }
  async request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    this.calls.push({ url, options });
    const reply = this.answer(url, options);
    if (reply instanceof Error || typeof reply === "string") throw reply;
    return reply;
  }
}

const ok = (body: string, status = 200): SafeFetchResult => ({
  status,
  headers: { "content-type": "application/json" },
  setCookie: [],
  body,
  finalUrl: "",
  durationMs: 3,
  timing: { dnsMs: 0, ttfbMs: 1, downloadMs: 0 },
});

function baseRun(overrides: Partial<SecurityRun> = {}): SecurityRun {
  return {
    id: "run-1",
    projectId: "p1",
    environmentId: "e1",
    label: "Prueba",
    status: "queued",
    rules: normalizeSelection(undefined),
    options: {
      rateLimitIterations: 5,
      requestTimeoutMs: 1000,
      crossUserPermutations: false,
      endpointIds: [],
      adminRole: null,
    },
    progress: { phase: "En cola", percentage: 0, detail: "", endpointsTested: 0, endpointsTotal: 0 },
    score: null,
    risk: null,
    summary: null,
    findings: [],
    probes: [],
    ai: null,
    visibility: "private",
    shareToken: null,
    triggeredByKind: "user",
    triggeredBy: "u1",
    startedAt: NOW,
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

const endpoint = (id: string, method: string, path: string, body: Record<string, unknown> = {}, status = "active") => ({
  id,
  projectId: "p1",
  method,
  path,
  status,
  requiresAuth: true,
  operationId: null,
  body: { mode: "none", text: "", contentType: "", fields: [], ...body },
});

type World = {
  run?: SecurityRun | null;
  environment?: unknown;
  environmentThrows?: unknown;
  project?: unknown;
  endpoints?: unknown[];
  credentials?: unknown[];
  roles?: unknown[];
  permissions?: unknown[];
  rules?: unknown[];
  cancelledAfter?: number;
  answer?: (url: string, options: SafeRequestOptions) => Reply;
};

function build(world: World) {
  const stored = new Map<string, SecurityRun>();
  if (world.run) stored.set(world.run.id, structuredClone(world.run));
  const saves: SecurityRun[] = [];
  let cancelChecks = 0;
  const http = new FakeHttp(world.answer ?? (() => ok("{}")));
  const progress = new SecurityRunProgressStream();
  const events: SecurityProgressEvent[] = [];
  progress.forRun(world.run?.id ?? "run-1").subscribe((event) => events.push(event.data as SecurityProgressEvent));

  const executor = new SecurityRunExecutor(
    {
      findById: async (id: string) => (stored.has(id) ? structuredClone(stored.get(id)!) : null),
      save: async (run: SecurityRun) => {
        saves.push(structuredClone(run));
        stored.set(run.id, structuredClone(run));
      },
    } as never,
    {
      process: () => undefined,
      isCancelled: () => {
        cancelChecks += 1;
        return world.cancelledAfter !== undefined && cancelChecks > world.cancelledAfter;
      },
    } as never,
    {
      findById: async () =>
        world.project === undefined ? { id: "p1", name: "Tienda", organizationId: "o1" } : world.project,
    } as never,
    {
      findById: async () => {
        if (world.environmentThrows !== undefined) throw world.environmentThrows;
        return world.environment === undefined
          ? { id: "e1", projectId: "p1", baseUrl: "http://target.test/api/", authEnforced: true }
          : world.environment;
      },
      listCredentials: async () => world.credentials ?? [],
    } as never,
    { listAll: async () => world.endpoints ?? [endpoint("ep-list", "GET", "/items")] } as never,
    {
      list: async () => world.roles ?? [],
      listPermissions: async () => world.permissions ?? [],
      listRules: async () => world.rules ?? [],
    } as never,
    { decrypt: (payload: string) => payload.replace(/^enc:/, "") } as never,
    http as never,
    new FixedClock(NOW),
    progress,
  );
  return { executor, stored, saves, http, events };
}

describe("el ejecutor de seguridad, rama por rama", () => {
  test("una corrida que ya no existe no guarda nada ni emite nada", async () => {
    const world = build({ run: null });
    await world.executor.execute("run-1");
    assert.equal(world.saves.length, 0);
    assert.equal(world.events.length, 0);
    assert.equal(world.http.calls.length, 0);
  });

  test("sin entorno, sin proyecto o sin endpoints activos la corrida acaba en error con el motivo", async () => {
    const cases: [World, string][] = [
      [{ environment: null }, "El entorno ya no existe"],
      [{ project: null }, "El proyecto ya no existe"],
      [{ endpoints: [endpoint("old", "GET", "/old", {}, "deprecated")] }, "No hay endpoints activos que probar"],
      // Elegidos por id, pero ninguno de los activos es uno de ellos.
      [
        { run: baseRun({ options: { ...baseRun().options, endpointIds: ["otro"] } }) },
        "No hay endpoints activos que probar",
      ],
    ];
    for (const [overrides, message] of cases) {
      const world = build({ run: baseRun(), ...overrides });
      await world.executor.execute("run-1");
      const run = world.stored.get("run-1")!;
      assert.equal(run.status, "error", message);
      assert.equal(run.error, message);
      assert.deepEqual(run.finishedAt, NOW);
      assert.equal(world.http.calls.length, 0);
      const last = world.events.at(-1)!;
      assert.equal(last.type, "finished");
      assert.equal(last.status, "error");
    }
  });

  test("un fallo que no es un Error se guarda como texto", async () => {
    const world = build({ run: baseRun(), environmentThrows: "se cayó la base" });
    await world.executor.execute("run-1");
    const run = world.stored.get("run-1")!;
    assert.equal(run.status, "error");
    assert.equal(run.error, "se cayó la base");
  });

  test("cancelada antes de la primera sonda de descubrimiento: cancelled, sin peticiones", async () => {
    const world = build({ run: baseRun(), cancelledAfter: 0 });
    await world.executor.execute("run-1");
    const run = world.stored.get("run-1")!;
    assert.equal(run.status, "cancelled");
    assert.deepEqual(run.finishedAt, NOW);
    assert.equal(world.http.calls.length, 0);
    assert.equal(world.events.at(-1)!.type, "finished");
    assert.equal(world.events.at(-1)!.status, "cancelled");
  });

  test("cancelada entre sondas de la matriz: las enviadas quedan, la siguiente no sale", async () => {
    // One discovery probe (GET /items), then the matrix; the cancel lands after two matrix probes.
    const world = build({ run: baseRun(), cancelledAfter: 3 });
    await world.executor.execute("run-1");
    const run = world.stored.get("run-1")!;
    assert.equal(run.status, "cancelled");
    assert.equal(world.http.calls.length, 3);
    // La primera sonda de la matriz ya dejó progreso guardado con lo enviado hasta ahí.
    assert.ok(world.saves.some((saved) => saved.progress.phase === "Ejecutando sondas"));
  });

  test("corrida completa: credenciales por rol, JWT forjado, cuerpos, errores de red y fases de progreso", async () => {
    const endpoints = [
      endpoint("ep-list", "GET", "items"),
      endpoint("ep-create", "POST", "/items", { mode: "json", text: '{"name":"x"}' }),
      endpoint("ep-gql", "POST", "/graphql", {
        mode: "graphql",
        text: "query { me { id } }",
        variables: '{"first": 2}',
      }),
      endpoint("ep-gql-novars", "POST", "/graphql2", { mode: "graphql", text: "query { a }", variables: "not json" }),
      endpoint("ep-gql-empty", "POST", "/graphql3", { mode: "graphql", text: "   " }),
      // Rows from before GraphQL variables existed have no `variables` at all.
      endpoint("ep-gql-legacy", "POST", "/graphql4", { mode: "graphql", text: "query { b }" }),
      endpoint("ep-bad-json", "PUT", "/bad", { mode: "json", text: "{ nope" }),
      endpoint("ep-array", "PATCH", "/arr", { mode: "json", text: "[1,2]" }),
      endpoint("ep-detail", "GET", "/items/{id}"),
      endpoint("ep-blocked", "GET", "/blocked"),
      endpoint("ep-boom", "GET", "/boom"),
      endpoint("ep-silent", "GET", "/silent"),
    ];
    const credentials = [
      { role: "admin", kind: "bearer", headerName: null, secretCiphertext: `enc:${JWT}` },
      { role: "client", kind: "apiKey", headerName: "X-Key", secretCiphertext: "enc:clave-del-cliente" },
      // Stored for a role the project does not declare: resolved, but never planned.
      { role: "ghost", kind: "basic", headerName: null, secretCiphertext: "enc:Z2hvc3Q=" },
    ];
    const roles = [
      { id: "r-admin", name: "admin", sameRoleDataIsolation: false },
      { id: "r-client", name: "client", sameRoleDataIsolation: true },
      { id: "r-anon", name: "anon", sameRoleDataIsolation: false },
    ];
    const world = build({
      run: baseRun({ options: { ...baseRun().options, adminRole: "admin", crossUserPermutations: true } }),
      endpoints,
      credentials,
      roles,
      permissions: [
        { roleId: "r-client", endpointId: "ep-create", access: "deny", dataScope: "none" },
        { roleId: "r-desconocido", endpointId: "ep-create", access: "allow", dataScope: "all" },
      ],
      rules: [
        { sourceRoleId: "r-client", targetRoleId: "r-admin", canRead: false, canWrite: false, canDelete: false },
        { sourceRoleId: "r-client", targetRoleId: "r-nadie", canRead: true, canWrite: true, canDelete: true },
        { sourceRoleId: "r-nadie", targetRoleId: "r-admin", canRead: true, canWrite: true, canDelete: true },
      ],
      answer: (url) => {
        if (url.endsWith("/blocked")) return new BlockedTargetError("169.254.169.254", "metadatos");
        if (url.endsWith("/boom")) return new Error("ECONNREFUSED");
        if (url.endsWith("/silent")) return "sin forma de error";
        if (url.endsWith("/items")) return ok(JSON.stringify([{ id: 7 }, { id: 8 }]));
        return ok('{"ok":true}');
      },
    });
    await world.executor.execute("run-1");
    const run = world.stored.get("run-1")!;

    assert.ok(["passed", "failed"].includes(run.status), run.error ?? "");
    assert.equal(run.error, null);
    assert.equal(run.progress.phase, "Terminado");
    assert.equal(run.progress.percentage, 100);
    assert.equal(run.progress.endpointsTotal, endpoints.length);
    assert.equal(run.progress.endpointsTested, endpoints.length);
    assert.equal(typeof run.score, "number");
    assert.equal(run.score, run.summary!.score);
    assert.equal(run.risk, run.summary!.risk);

    // The base URL loses its trailing slash; a path without one gains it.
    assert.ok(world.http.calls.some((call) => call.url === "http://target.test/api/items"));
    assert.ok(world.http.calls.every((call) => !call.url.includes("api//")));

    // Discovery goes as the admin role, with its real bearer token on the wire.
    const discovery = run.probes.find((probe) => probe.testType === "discovery" && probe.endpointId === "ep-list")!;
    assert.equal(discovery.sentAuthorization, true);
    assert.equal(discovery.headers.Authorization, "••••••••");
    assert.ok(
      world.http.calls.some(
        (call) => call.url.endsWith("/items") && call.options.headers?.Authorization === `Bearer ${JWT}`,
      ),
    );

    // The unauthenticated probe carries no Authorization at all.
    const noAuth = run.probes.find((probe) => probe.testType === "no-auth" && probe.endpointId === "ep-list")!;
    assert.equal(noAuth.sentAuthorization, false);
    assert.equal(noAuth.headers.Authorization, undefined);

    // JSON bodies go on writes with their content type; a GET never carries one.
    const create = world.http.calls.find(
      (call) => call.url.endsWith("/items") && call.options.method === "POST" && call.options.body === '{"name":"x"}',
    );
    assert.ok(create, "el cuerpo JSON del endpoint salió tal cual");
    assert.equal(create.options.headers?.["Content-Type"], "application/json");
    assert.ok(
      world.http.calls.filter((call) => call.options.method === "GET").every((call) => call.options.body === undefined),
    );

    // GraphQL: the operation with its variables; unparseable variables are dropped; blank means no body.
    const noAuthOf = (id: string) =>
      run.probes.find((probe: ProbeResult) => probe.endpointId === id && probe.testType === "no-auth")!;
    assert.deepEqual(JSON.parse(noAuthOf("ep-gql").body!), { query: "query { me { id } }", variables: { first: 2 } });
    assert.deepEqual(JSON.parse(noAuthOf("ep-gql-novars").body!), { query: "query { a }" });
    assert.deepEqual(JSON.parse(noAuthOf("ep-gql-legacy").body!), { query: "query { b }" });
    assert.equal(noAuthOf("ep-gql").contentType, "application/json");
    // A blank operation, invalid JSON and a JSON array are not an object to mutate: no body.
    for (const id of ["ep-gql-empty", "ep-bad-json", "ep-array"]) assert.equal(noAuthOf(id).body, null, id);

    // A probe that never got an answer is a status-0 result with the reason, not a dead run.
    const errorOf = noAuthOf;
    assert.equal(errorOf("ep-blocked").status, 0);
    assert.match(errorOf("ep-blocked").error!, /169\.254\.169\.254.*bloqueado/);
    assert.equal(errorOf("ep-boom").error, "ECONNREFUSED");
    assert.equal(errorOf("ep-silent").error, "sin respuesta");

    // The jwt-attack probes carry a forged token derived from the admin's real one, masked in storage.
    const attacks = world.http.calls.filter((call) => {
      const auth = call.options.headers?.Authorization ?? "";
      return auth.startsWith("Bearer ") && auth !== `Bearer ${JWT}`;
    });
    assert.ok(attacks.length >= 3, "salieron las tres variantes forjadas");
    const algNone = attacks.find((call) => {
      const header = JSON.parse(Buffer.from(call.options.headers!.Authorization.slice(7).split(".")[0], "base64url").toString());
      return header.alg === "none";
    });
    assert.ok(algNone, "una va con alg: none");
    for (const probe of run.probes.filter((entry) => entry.testType.startsWith("jwt-attack:")))
      assert.equal(probe.headers.Authorization, "••••••••");

    // The api-key role travels in its own header.
    assert.ok(
      world.http.calls.some((call) => call.options.headers?.["X-Key"] === "clave-del-cliente"),
      "el rol client usa X-Key",
    );

    // BOLA with the real ids that discovery read.
    assert.ok(run.probes.some((probe) => probe.testType.startsWith("bola-real-id:") && probe.path === "/items/7"));

    // Progress: running, discovery, probes, analysis, then one finished event with the score.
    const phases = world.events.map((event) => event.progress.phase);
    assert.ok(phases.includes("Descubriendo ids"));
    assert.ok(phases.includes("Ejecutando sondas"));
    assert.ok(phases.includes("Analizando con las reglas"));
    assert.equal(world.events[0].status, "running");
    const finished = world.events.filter((event) => event.type === "finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].score, run.score);
    assert.equal(finished[0].risk, run.risk);
  });

  test("el secreto de una credencial API-key no se guarda en la sonda, ni se inventa un Authorization", async () => {
    const world = build({
      run: baseRun(),
      endpoints: [endpoint("ep-list", "GET", "/items")],
      credentials: [{ role: "client", kind: "apiKey", headerName: "X-Key", secretCiphertext: "enc:clave-secreta" }],
      roles: [{ id: "r-client", name: "client", sameRoleDataIsolation: false }],
    });
    await world.executor.execute("run-1");
    const run = world.stored.get("run-1")!;
    // It was sent for real...
    assert.ok(world.http.calls.some((call) => call.options.headers?.["X-Key"] === "clave-secreta"));
    // ...and what is stored — and shown, and shared by a public link — is masked.
    const authed = run.probes.find((probe) => probe.testType === "auth:client")!;
    assert.equal(authed.sentAuthorization, true);
    assert.equal(authed.headers["X-Key"], "••••••••");
    assert.equal(authed.headers.Authorization, undefined, "no se envió Authorization, no se guarda uno");
    assert.equal(JSON.stringify(run).includes("clave-secreta"), false);
  });

  test("un token que no es JWT, o vacío, no se puede forjar: la sonda jwt-attack sale con la credencial real", async () => {
    const rules = Object.fromEntries(RULE_KEYS.map((key) => [key, key === "jwt_attack"])) as SecurityRun["rules"];
    for (const secret of ["token-opaco", ""]) {
      const world = build({
        run: baseRun({ rules }),
        endpoints: [endpoint("ep-list", "GET", "/items/{id}")],
        credentials: [{ role: "admin", kind: "bearer", headerName: null, secretCiphertext: `enc:${secret}` }],
        roles: [{ id: "r-admin", name: "admin", sameRoleDataIsolation: false }],
      });
      await world.executor.execute("run-1");
      const attackProbes = world.stored.get("run-1")!.probes.filter((probe) => probe.testType.startsWith("jwt-attack:"));
      assert.equal(attackProbes.length, 3, secret);
      for (const probe of attackProbes) assert.equal(probe.token, null);
      const attackCalls = world.http.calls.slice(-3);
      for (const call of attackCalls) assert.equal(call.options.headers?.Authorization, `Bearer ${secret}`);
    }
  });

  test("listen registra el ejecutor en la cola", async () => {
    const registered: { handler?: (runId: string) => Promise<void> } = {};
    const executor = new SecurityRunExecutor(
      { findById: async () => null } as never,
      { process: (handler: (runId: string) => Promise<void>) => (registered.handler = handler) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new FixedClock(NOW),
      new SecurityRunProgressStream(),
    );
    executor.listen();
    assert.ok(registered.handler);
    await registered.handler("nada");
  });
});
