/**
 * The small pure pieces around a run: how a webhook call is kept, how a channel session becomes a
 * step, how a notification is sent, how a nested case is named, what a report says about things
 * that no longer exist — and the context a run is set up with.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { WorkflowStep } from "@eq/runner-core";

import { keptHookHeaders, readHookPayload } from "@/modules/runs/domain/flow-hooks";
import { channelStep, TRANSCRIPT_EXCERPT } from "@/modules/runs/infrastructure/channel-node";
import { sendNotification } from "@/modules/runs/infrastructure/notify-step";
import { nestedScenarioId } from "@/modules/runs/infrastructure/subflow-support";
import { toHtmlReport, toJUnitXml } from "@/modules/runs/presentation/report-formats";
import type { ReportCase, RunReport } from "@/modules/runs/application/queries/get-run";
import { ExecutionContextFactory } from "@/modules/runs/infrastructure/execution-context";
import type { ExecutionTarget } from "@/modules/runs/infrastructure/case-executor";
import type { RunCase } from "@/modules/runs/domain/model";
import type { SafeFetchPort } from "@/shared/http/safe-fetch";
import { MASK } from "@/modules/endpoints/domain/examples";
import { InMemoryConfigRepository } from "@test/support/in-memory-repositories";

describe("una llamada a un webhook, guardada", () => {
  test("las cabeceras se cortan en 40, una repetida se une y una credencial se tapa", () => {
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`X-Extra-${index}`, `v${index}`]));
    const kept = keptHookHeaders({ "X-Lista": ["a", "b"], Authorization: "Bearer x", ...many });
    assert.equal(Object.keys(kept).length, 40);
    assert.equal(kept["x-lista"], "a, b");
    assert.equal(kept.authorization, MASK);
    assert.equal(kept["x-extra-44"], undefined);
  });

  test("un cuerpo en bytes se lee como texto, uno que no es texto queda vacío y sin tipo no se parsea", () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    const fromBytes = readHookPayload("POST", { "content-type": "application/json" }, Buffer.from('{"a":1}'), now);
    assert.deepEqual(fromBytes.body, { a: 1 });
    assert.equal(fromBytes.receivedAt, now.toISOString());

    const fromObject = readHookPayload("POST", {}, { ya: "parseado" }, now);
    assert.equal(fromObject.raw, "");
    assert.equal(fromObject.contentType, "");
    assert.equal(fromObject.body, "");

    const untyped = readHookPayload("PUT", {}, '{"a":1}', now);
    // Kept as text: without a JSON type nothing claims it is an object.
    assert.equal(typeof untyped.body, "string");
    assert.deepEqual(JSON.parse(untyped.body as string), { a: 1 });
  });

  test("un formulario tapa por nombre, deja los pares sin «=» y compara tal cual un nombre mal codificado", () => {
    const form = readHookPayload(
      "POST",
      { "content-type": "application/x-www-form-urlencoded" },
      "suelto&password=abc&%E0%A4%A=1&nombre=ana",
      new Date(),
    );
    const pairs = form.raw.split("&");
    assert.equal(pairs[0], "suelto");
    assert.equal(pairs[1], `password=${encodeURIComponent(MASK)}`);
    assert.equal(pairs[2], "%E0%A4%A=1");
    assert.equal(pairs[3], "nombre=ana");
  });
});

describe("un nodo de canal, como paso", () => {
  const runCase = { id: "c", method: "CHANNEL", path: "canal-1", scenarioId: "workflow:f:canal" } as RunCase;
  const step = { id: "canal", kind: "channel", channel: { channelId: "canal-1" } } as WorkflowStep;
  const channel = { id: "canal-1", name: "Precios", protocol: "ws", messages: [] };

  const session = (overrides: Record<string, unknown>, messages: { body: string; direction: "in" | "out" }[]) => ({
    kind: "session" as const,
    channel,
    session: {
      id: "sesion-1",
      stopReason: null,
      verdict: null,
      conversation: {
        closedAtMs: null,
        handshake: null,
        closeCode: null,
        counters: { sent: 0, received: messages.length },
        messages: messages.map((message, index) => ({ seq: index + 1, atMs: index, bytes: message.body.length, ...message })),
      },
      ...overrides,
    },
    received: messages.filter((message) => message.direction === "in").map((message) => ({ body: message.body })),
    problems: [],
  });

  test("sin motivo de cierre ni veredicto dice «cerrada», y la transcripción se recorta", () => {
    const long = "x".repeat(2_500);
    const messages = Array.from({ length: TRANSCRIPT_EXCERPT + 3 }, (_, index) => ({
      body: index === 0 ? long : `m${index}`,
      direction: "in" as const,
    }));
    const result = channelStep(step, runCase, session({}, messages) as never, {});
    assert.equal(result.executed.ok, true);
    assert.match(result.executed.assertions[0].detail, /· cerrada ·/);
    assert.equal(result.executed.durationMs, TRANSCRIPT_EXCERPT + 2);
    const body = result.executed.actual?.body as { transcript: { body: string }[]; omitted: number };
    assert.equal(body.transcript.length, TRANSCRIPT_EXCERPT);
    assert.equal(body.omitted, 3);
    assert.equal(body.transcript[0].body.length, 2_001);
    assert.ok(body.transcript[0].body.endsWith("…"));
    assert.deepEqual(result.caseFields, { method: "WS", path: "«Precios»" });
  });

  test("un motivo que no tiene texto propio se enseña tal cual", () => {
    const result = channelStep(step, runCase, session({ stopReason: "algo-nuevo" }, []) as never, {});
    assert.match(result.executed.assertions[0].detail, /· algo-nuevo ·/);
    assert.equal(result.executed.durationMs, 0);
  });
});

describe("el nodo notify", () => {
  const target = (variables: Record<string, string>, session: ExecutionTarget["session"] = null): ExecutionTarget => ({
    baseUrl: "https://api.ejemplo.test",
    writesAllowed: true,
    spec: null,
    specError: null,
    credentials: [],
    variables,
    session,
    cookies: [],
  });
  const origin = { runId: "r", workflowId: "w", stepId: "avisa" };

  test("un receptor que contesta 500 sin cuerpo falla como «server» cuando el nodo lo pide", async () => {
    const http = {
      request: async () => ({ status: 503, headers: {}, setCookie: [], body: "   " }),
    } as unknown as SafeFetchPort;
    const outcome = await sendNotification(http, {
      notify: { channel: "slack", urlVariable: "hook", message: "hola", onError: "fail" } as never,
      target: target({ hook: "https://hooks.slack.test/T/B/x" }, { header: "Authorization", value: "Bearer sesion-larga" }),
      origin,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failure, "server");
    assert.equal(outcome.assertions[0].detail, "slack respondió 503");
    assert.equal(outcome.sent.url, "{{hook}}");
  });

  test("un error que no es un Error se cuenta con un texto propio y, sin «fallar», es un aviso", async () => {
    const http = {
      request: async () => {
        throw "cadena";
      },
    } as unknown as SafeFetchPort;
    const outcome = await sendNotification(http, {
      notify: { channel: "slack", urlVariable: "hook", message: "hola" } as never,
      target: target({ hook: "https://hooks.slack.test/T/B/x" }),
      origin,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.assertions[0].severity, "warning");
    assert.match(outcome.assertions[0].detail, /^La notificación no se pudo enviar · no se entregó/);
  });
});

describe("el nombre de un caso anidado", () => {
  test("un id que no viene del hijo se cuelga entero, y uno demasiado largo se resume con un hash", () => {
    assert.equal(nestedScenarioId("padre", "nodo", "hijo", "suelto"), "workflow:padre:nodo>suelto");
    const long = nestedScenarioId("p".repeat(36), "n".repeat(60), "h", `workflow:h:${"s".repeat(150)}`);
    assert.ok(long.length <= 200, String(long.length));
    assert.match(long, /^workflow:p{36}:n{20}>[0-9a-f]{8}>s+$/);
  });
});

describe("un informe de algo que ya no existe", () => {
  const base = (source: RunReport["run"]["source"], cases: Partial<ReportCase>[], finishedAt: Date | null = null): RunReport =>
    ({
      run: {
        id: "run-1",
        projectId: "p1",
        environmentId: "e1",
        status: "failed",
        totals: { cases: cases.length, completed: cases.length, passed: 0, failed: 1, skipped: 0 },
        source,
        startedAt: new Date(Date.now() - 1_000),
        finishedAt,
        error: null,
      },
      cases: cases.map((item, index) => ({
        id: `c${index}`,
        operationId: "",
        scenarioId: `s${index}`,
        method: "GET",
        path: "/x",
        status: "failed",
        failure: null,
        position: index,
        durationMs: null,
        startedAt: null,
        finishedAt: null,
        steps: [],
        ...item,
      })),
    }) as RunReport;

  test("una suite y un canal borrados se nombran como tales, y un fallo sin aserciones tiene su mensaje", () => {
    const suite = toJUnitXml(base({ kind: "suite", suiteId: "s", name: null, flowNames: [null] } as never, [{}]));
    assert.match(suite, /<testsuites name="Suite eliminada · 1 flujos"/);
    assert.match(suite, /<failure type="check" message="El caso no cumplió lo que esperaba">/);
    assert.match(suite, /time="0\.000">/);

    const channel = toJUnitXml(base({ kind: "channel", channelId: "c", name: null } as never, []));
    assert.match(channel, /<testsuites name="Canal eliminado"/);
  });

  test("el HTML de una corrida sin terminar pinta 0 ms en un caso sin duración", () => {
    const html = toHtmlReport(base({ kind: "channel", channelId: "c", name: "Precios" } as never, [{}]));
    assert.match(html, /<td class="num">0 ms<\/td>/);
    assert.match(html, /Canal Precios/);
  });
});

describe("el contexto de una corrida", () => {
  const project = { id: "p1" };
  const environment = {
    id: "env-1",
    projectId: "p1",
    baseUrl: "https://api.ejemplo.test",
    specUrl: null,
    variables: {
      publica: { initial: "uno", current: "", sensitive: false },
      secreta: { initial: "", current: "cifrado", sensitive: true },
    },
    writesAllowed: false,
    authEnforced: true,
  };
  const operation = {
    rowId: "row",
    specVersionId: "v1",
    position: 0,
    derivedId: false,
    security: [],
    id: "listThings",
    method: "GET",
    path: "/things",
    summary: "",
    tag: "",
    statuses: [200],
    parameters: [],
  };

  function factory(options: {
    project?: unknown;
    environment?: unknown;
    operations?: unknown[];
    get?: SafeFetchPort["get"];
  }) {
    const requested: string[] = [];
    const http = {
      get: async (url: string) => {
        requested.push(url);
        return (options.get ?? (async () => ({ status: 200, body: "{}" })))(url);
      },
    } as unknown as SafeFetchPort;
    const built = new ExecutionContextFactory(
      { findById: async () => ("project" in options ? options.project : project) } as never,
      { listOperations: async () => options.operations ?? [operation] } as never,
      {
        findById: async () => ("environment" in options ? options.environment : environment),
        listCredentials: async () => [],
      } as never,
      new InMemoryConfigRepository(),
      { decrypt: (payload: string) => `claro(${payload})` } as never,
      http,
    );
    return { built, requested };
  }

  const reject = async (promise: Promise<unknown>, pattern: RegExp) => {
    await assert.rejects(promise, (error: Error) => pattern.test(error.message));
  };

  test("sin proyecto, sin entorno o con un contrato vacío no se puede preparar", async () => {
    await reject(
      factory({ project: null }).built.build({ projectId: "p1", environmentId: "env-1", specVersionId: null }),
      /El proyecto ya no existe/,
    );
    await reject(
      factory({}).built.build({ projectId: "p1", environmentId: null, specVersionId: null }),
      /Hace falta un entorno con URL base/,
    );
    await reject(
      factory({ environment: null }).built.build({ projectId: "p1", environmentId: "env-1", specVersionId: null }),
      /Hace falta un entorno con URL base/,
    );
    await reject(
      factory({ operations: [] }).built.build({ projectId: "p1", environmentId: "env-1", specVersionId: "v1" }),
      /no tiene operaciones/,
    );
  });

  test("sin versión del contrato no pide el documento; los secretos se descifran y se apartan", async () => {
    const { built, requested } = factory({});
    const context = await built.build({ projectId: "p1", environmentId: "env-1", specVersionId: null });
    assert.deepEqual(requested, []);
    assert.equal(context.target.spec, null);
    assert.equal(context.target.specError, "La corrida no usa el contrato del proyecto");
    assert.deepEqual(context.resolved, []);
    assert.equal(context.target.variables.publica, "uno");
    assert.equal(context.target.variables["env.secreta"], "claro(cifrado)");
    assert.deepEqual(context.target.secrets, ["claro(cifrado)"]);
    assert.equal(context.target.writesAllowed, false);
    assert.equal(context.authEnabled, true);
  });

  test("el contrato en vivo que responde 404, o que no se puede leer, se dice sin tumbar la corrida", async () => {
    const notFound = factory({ get: async () => ({ status: 404, body: "" }) as never });
    const missing = await notFound.built.build({ projectId: "p1", environmentId: "env-1", specVersionId: "v1" });
    assert.deepEqual(notFound.requested, ["https://api.ejemplo.test/openapi.json"]);
    assert.equal(missing.target.specError, "El contrato en vivo respondió 404");
    assert.equal(missing.resolved.length, 1);

    const broken = factory({
      get: async () => {
        throw "sin red";
      },
    });
    const unreadable = await broken.built.build({ projectId: "p1", environmentId: "env-1", specVersionId: "v1" });
    assert.equal(unreadable.target.specError, "No se pudo leer el contrato en vivo");

    const garbled = factory({ get: async () => ({ status: 200, body: "no es json" }) as never });
    const unparsable = await garbled.built.build({ projectId: "p1", environmentId: "env-1", specVersionId: "v1" });
    assert.equal(unparsable.target.spec, null);
    assert.match(unparsable.target.specError ?? "", /JSON/);
  });
});
