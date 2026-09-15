import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mockBodyProblem, simulateMock } from "../src/mock.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const seed = { uuid: "fijo-uuid", now: new Date("2026-01-01T00:00:00Z"), random: 0.5, hmacSha256: () => "hmac" };

describe("la respuesta de un mock", () => {
  test("resuelve plantillas, pone las cabeceras en minúsculas y parsea el body JSON", () => {
    const simulated = simulateMock(
      {
        status: 201,
        headers: { "Content-Type": "application/json", "X-Pedido": "{{pedido}}" },
        body: '{"id": "{{thingId}}", "total": {{total}}, "traza": "{{$uuid}}"}',
      },
      { thingId: "t-1", total: "42", pedido: "PED-7" },
      seed,
    );
    assert.equal(simulated.ok, true);
    if (!simulated.ok) return;
    assert.equal(simulated.actual.status, 201);
    assert.equal(simulated.actual.contentType, "application/json");
    assert.deepEqual(simulated.actual.headers, { "content-type": "application/json", "x-pedido": "PED-7" });
    assert.deepEqual(simulated.actual.body, { id: "t-1", total: 42, traza: "fijo-uuid" });
    assert.equal(simulated.actual.raw, '{"id": "t-1", "total": 42, "traza": "fijo-uuid"}');
  });

  test("deduce el content-type cuando falta, y un body de texto se queda como texto", () => {
    const json = simulateMock({ status: 200, body: '{"ok":true}' }, {});
    assert.ok(json.ok && json.actual.contentType === "application/json" && (json.actual.body as { ok: boolean }).ok);
    const text = simulateMock({ status: 200, body: "hola" }, {});
    assert.ok(text.ok && text.actual.contentType === "text/plain" && text.actual.body === "hola");
    const empty = simulateMock({ status: 204 }, {});
    assert.ok(empty.ok && empty.actual.contentType === "" && empty.actual.raw === "");
    // Declarado como texto, aunque parsee: manda lo que el autor escribió.
    const declared = simulateMock({ status: 200, headers: { "content-type": "text/plain" }, body: "[1]" }, {});
    assert.ok(declared.ok && declared.actual.body === "[1]");
  });

  test("falla con una variable sin definir o con un JSON que se rompe al resolver", () => {
    const missing = simulateMock({ status: 200, headers: { "x-a": "{{cabecera}}" }, body: "{{noExiste}}" }, {});
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.deepEqual(missing.missing.sort(), ["cabecera", "noExiste"]);
    const broken = simulateMock(
      { status: 200, headers: { "content-type": "application/json" }, body: '{"nombre": "{{nombre}}"}' },
      { nombre: 'con "comillas"' },
    );
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.match(broken.problem, /no es JSON válido/);
  });

  test("el JSON del body se juzga antes de las variables, con cada plantilla como 0", () => {
    const json = { "content-type": "application/json; charset=utf-8" };
    assert.equal(mockBodyProblem({ headers: json, body: '{"id": "{{id}}", "n": {{total}}, "h": {{$hmacSha256:{{k}}:x}}}' }), null);
    assert.match(mockBodyProblem({ headers: json, body: '{"id": 1' }) ?? "", /no es JSON válido/);
    assert.equal(mockBodyProblem({ headers: { "Content-Type": "text/plain" }, body: "{roto" }), null);
    assert.equal(mockBodyProblem({ body: "{roto" }), null);
    assert.equal(mockBodyProblem({ headers: json, body: "  " }), null);
  });
});

describe("el nodo mock en el documento del flujo", () => {
  const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
  const req = (id: string, extra: Record<string, unknown> = {}) => ({ id, requestTemplateId: uuid(1), ...extra });
  const mock = (block: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    id: "m",
    kind: "mock",
    mock: { status: 200, headers: { "content-type": "application/json" }, body: '{"id": "{{x}}"}', ...block },
    ...extra,
  });

  test("valida estado, retardo y body; no lleva petición, reintentos, forEach ni login", () => {
    assert.equal(parse([mock()]), true);
    assert.equal(parse([mock({ status: 503, delayMs: 60_000, disabledHeaders: { "x-off": "1" } })]), true);
    assert.equal(parse([{ id: "m", kind: "mock", mock: { status: 204 } }]), true);
    assert.equal(parse([mock({ status: 99 })]), false);
    assert.equal(parse([mock({ status: 600 })]), false);
    assert.equal(parse([mock({ delayMs: 60_001 })]), false);
    assert.equal(parse([mock({ body: '{"id": ' })]), false);
    assert.equal(parse([mock({ headers: { "mal nombre": "x" } })]), false);
    assert.equal(parse([{ id: "m", kind: "mock" }]), false);
    assert.equal(parse([mock({}, { requestTemplateId: uuid(2) })]), false);
    assert.equal(parse([mock({}, { retry: { attempts: 2, delayMs: 0 } })]), false);
    assert.equal(parse([req("r"), mock({}, { dependsOn: ["r"], forEach: { from: "r", path: "data", as: "item" } })]), false);
    assert.equal(parse([mock({}, { authorizes: { from: "body", path: "token" } })]), false);
    assert.equal(parse([req("r", { mock: { status: 200 } })]), false);
  });

  test("lo de después lo lee como una respuesta; un reintento no lo repite y el contrato no lo conoce", () => {
    const after = (extra: Record<string, unknown>) => ({ dependsOn: ["m"], ...extra });
    const check = { source: "status", operator: "equals", value: "200" };
    assert.equal(parse([mock({}, { checks: [check], captures: [{ variable: "x2", from: "body", path: "id" }] }), { id: "v", kind: "validate", validate: { from: "m" }, checks: [check], ...after({}) }]), true);
    assert.equal(parse([mock(), { id: "b", kind: "branch", condition: { from: "m", check }, ...after({}) }]), true);
    assert.equal(
      parse([mock(), { id: "e", kind: "schema", schema: { from: "m", source: "custom", json: '{"type":"object"}' }, ...after({}) }]),
      true,
    );
    assert.equal(parse([mock(), { id: "e", kind: "schema", schema: { from: "m", source: "contract" }, ...after({}) }]), false);
    assert.equal(
      parse([mock(), { id: "p", kind: "poll", poll: { from: "m", attempts: 2, delayMs: 0 }, checks: [check], ...after({}) }]),
      false,
    );
  });
});
