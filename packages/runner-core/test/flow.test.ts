/**
 * The multi-step flows, driven without a server.
 *
 * These are the cases that catch an endpoint which looks correct and is not: a POST that answers
 * 201 and drops half the payload, a DELETE that answers 204 over a row it did not remove. In the
 * coupled dashboard the logic lived inside a React component and could only be exercised by
 * clicking; here the flow is a generator, so a test hands it outcomes and reads back the plan.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { resolveOperations, scenariosFor } from "../src/scenarios.ts";
import { detailOperationFor, idFieldOf, planFlow, type StepOutcome, type StepRequest } from "../src/flow.ts";
import {
  capturedId,
  evaluateResponse,
  matchesShape,
  verifyPersistedFields,
  type ActualResponse,
} from "../src/assertions.ts";
import { expectedShapeFor } from "../src/envelope.ts";
import type { Operation, ResolvedOperation, TestScenario } from "../src/types.ts";

const operations: Operation[] = [
  { id: "listThings", method: "GET", path: "/things", summary: "", tag: "T", statuses: [200], parameters: [] },
  { id: "createThing", method: "POST", path: "/things", summary: "", tag: "T", statuses: [201, 422], parameters: [] },
  {
    id: "getThing",
    method: "GET",
    path: "/things/{id}",
    summary: "",
    tag: "T",
    statuses: [200, 404],
    parameters: ["id"],
  },
  {
    id: "replaceThing",
    method: "PUT",
    path: "/things/{id}",
    summary: "",
    tag: "T",
    statuses: [200, 404],
    parameters: ["id"],
  },
  {
    id: "patchThing",
    method: "PATCH",
    path: "/things/{id}",
    summary: "",
    tag: "T",
    statuses: [200, 404],
    parameters: ["id"],
  },
  {
    id: "deleteThing",
    method: "DELETE",
    path: "/things/{id}",
    summary: "",
    tag: "T",
    statuses: [204, 404],
    parameters: ["id"],
  },
];

const config = defineProjectConfig({
  bodyTemplates: {
    createThing: { body: { name: "nuevo", size: 3 } },
    replaceThing: { body: { name: "reemplazado", size: 3 }, replaceBody: { name: "reemplazado", size: 9 } },
    patchThing: { body: { name: "parcheado" } },
  },
  envelope: {
    rules: [{ id: "delete", match: { methods: ["DELETE"] }, shape: "No body" }],
    fallbackShape: "{ data: Resource }",
    errorShape: "ProblemDetails",
  },
  pathDefaults: { id: "1" },
});

const resolved = resolveOperations(operations, config);
const find = (id: string) => resolved.find((operation) => operation.id === id)!;
const caseOf = (operationId: string, scenarioId: string): TestScenario =>
  scenariosFor(find(operationId), config).find((scenario) => scenario.id === scenarioId)!;

const okBody = (id: string) => ({
  status: 201,
  statusText: "Created",
  contentType: "application/json",
  headers: {},
  body: { data: { id, name: "nuevo", size: 3 } },
  raw: "{}",
});
const emptyOk: ActualResponse = {
  status: 204,
  statusText: "No Content",
  contentType: "",
  headers: {},
  body: "",
  raw: "",
};

/** A target that answers a create with a resource and everything else with an empty 204. The
 * distinction matters: answering the prepare step with a bodyless 204 leaves the flow with no id
 * to address, and it stops — correctly, but for a reason the test did not intend. */
const createsThenEmpty = (step: StepRequest): Partial<StepOutcome> =>
  step.method === "POST" ? {} : { actual: emptyOk };

/** Drives a flow to completion, answering every step with the same canned outcome builder. */
function walk(
  operation: ResolvedOperation,
  scenario: TestScenario,
  answer: (step: StepRequest) => Partial<StepOutcome> = () => ({}),
): StepRequest[] {
  const flow = planFlow({ operation, scenario, config, operations: resolved, samples: 1 });
  const steps: StepRequest[] = [];
  let result = flow.next();
  while (!result.done) {
    const step = result.value;
    steps.push(step);
    const canned = answer(step);
    result = flow.next({
      request: step,
      actual: canned.actual === undefined ? (okBody("42") as ActualResponse) : canned.actual,
      ok: canned.ok ?? true,
      assertions: canned.assertions ?? [],
    });
  }
  return steps;
}

describe("descubrimiento de operaciones relacionadas", () => {
  test("la operación de detalle de una colección es la que tiene un placeholder más", () => {
    assert.equal(detailOperationFor(find("listThings"), resolved)?.id, "getThing");
  });
  test("una colección sin detalle devuelve undefined en vez de adivinar", () => {
    const orphan = resolveOperations(
      [{ id: "listOrphans", method: "GET", path: "/orphans", summary: "", tag: "T", statuses: [200], parameters: [] }],
      config,
    )[0];
    assert.equal(detailOperationFor(orphan, resolved), undefined);
  });
  test("el identificador es el último placeholder de la ruta", () => {
    assert.equal(idFieldOf(find("getThing")), "id");
    const nested = resolveOperations(
      [
        {
          id: "getNested",
          method: "GET",
          path: "/a/{a_id}/b/{b_id}",
          summary: "",
          tag: "T",
          statuses: [200],
          parameters: ["a_id", "b_id"],
        },
      ],
      config,
    )[0];
    assert.equal(idFieldOf(nested), "b_id");
  });
});

describe("create-read", () => {
  test("crea, lee el recurso creado y lo borra", () => {
    // The cleanup is not tidiness: without it the second run of this case is a 409 over the
    // natural key, which reports the previous run rather than the endpoint.
    const steps = walk(find("createThing"), caseOf("createThing", "create-read"));
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.method} ${step.requestPath}`),
      ["act:POST /things", "verify:GET /things/42", "cleanup:DELETE /things/42"],
    );
  });

  test("si el POST falla no persigue una lectura que no diría nada nuevo", () => {
    const steps = walk(find("createThing"), caseOf("createThing", "create-read"), () => ({ ok: false }));
    assert.equal(steps.length, 1);
  });

  test("si la respuesta no trae identificador, el flujo se detiene ahí", () => {
    // A create that answers 201 without saying what it created cannot be read back, and the case
    // reports that instead of requesting `/things/undefined`.
    const steps = walk(find("createThing"), caseOf("createThing", "create-read"), () => ({
      actual: {
        status: 201,
        statusText: "",
        contentType: "application/json",
        headers: {},
        body: { data: { name: "nuevo" } },
        raw: "{}",
      },
    }));
    assert.equal(steps.length, 1);
  });

  test("un caso de un solo request no genera pasos extra", () => {
    assert.equal(walk(find("createThing"), caseOf("createThing", "invalid-body")).length, 1);
  });
});

describe("replace-read", () => {
  test("crea su propia entidad en vez de mutar una semilla", () => {
    // A PUT over fixture id 1 changes what every later case in the matrix reads.
    const steps = walk(find("replaceThing"), caseOf("replaceThing", "replace-read"));
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.method}`),
      ["prepare:POST", "act:PUT", "verify:GET", "cleanup:DELETE"],
    );
    assert.equal(steps[1].requestPath, "/things/42");
    assert.deepEqual(steps[1].body, { name: "reemplazado", size: 9 });
  });

  test("si la preparación falla no se ejecuta la mutación", () => {
    // Otherwise the PUT lands on a seed row, which is exactly the fixture damage the prepare
    // step exists to avoid.
    const steps = walk(find("replaceThing"), caseOf("replaceThing", "replace-read"), (step) =>
      step.purpose === "prepare" ? { ok: false } : {},
    );
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare"],
    );
  });

  test("aunque la mutación falle, la entidad creada se limpia", () => {
    const steps = walk(find("replaceThing"), caseOf("replaceThing", "replace-read"), (step) =>
      step.purpose === "act" ? { ok: false } : {},
    );
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act", "cleanup"],
    );
  });

  test("patch-read sigue la misma forma con el body parcial", () => {
    const steps = walk(find("patchThing"), caseOf("patchThing", "patch-read"));
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act", "verify", "cleanup"],
    );
    assert.deepEqual(steps[1].body, { name: "parcheado" });
  });
});

describe("delete-read y deleted-read", () => {
  test("delete-read crea, borra y relee: el 204 no es la comprobación", () => {
    // It used to stop at the DELETE, which made the name of the case a promise it did not keep —
    // and left it asserting precisely the thing the flow exists to distrust. A soft delete whose
    // read path forgot the flag answers a perfectly correct 204 and goes on serving the row; only
    // the read-back sees it.
    const steps = walk(find("deleteThing"), caseOf("deleteThing", "delete-read"), createsThenEmpty);
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.method}:${step.expectedStatus}`),
      ["prepare:POST:201", "act:DELETE:204", "verify:GET:404"],
    );
  });

  test("deleted-read va un paso más allá: el segundo DELETE", () => {
    // Not a duplicate of the one above. That one asks what the resource *is* afterwards; this one
    // asks whether the endpoint admits the row is gone.
    const steps = walk(find("deleteThing"), caseOf("deleteThing", "deleted-read"));
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.method}:${step.expectedStatus}`),
      [
        "prepare:POST:201",
        "act:DELETE:204",
        "verify:GET:404",
        // An endpoint that answers 204 to a second DELETE is reporting success for work it did
        // not do.
        "verify:DELETE:404",
      ],
    );
  });
});

describe("muestras de latencia", () => {
  test("solo se repiten los métodos seguros", () => {
    // Repeating a POST would create N resources: the measurement would change the thing being
    // measured.
    const flow = planFlow({
      operation: find("createThing"),
      scenario: caseOf("createThing", "create-read"),
      config,
      operations: resolved,
      samples: 30,
    });
    const first = flow.next().value as StepRequest;
    assert.equal(first.samples, 1);
    const read = flow.next({ request: first, actual: okBody("7") as ActualResponse, ok: true, assertions: [] })
      .value as StepRequest;
    assert.equal(read.samples, 30);
  });
});

describe("credenciales por paso", () => {
  test("un caso de autorización envía su credencial solo en el paso que la prueba", () => {
    // The prepare and cleanup steps have to work, or the case fails for a reason that is not the
    // one it is testing.
    const scenario = caseOf("deleteThing", "delete-read");
    const authScenario: TestScenario = { ...scenario, auth: "none" };
    const steps = walk(find("deleteThing"), authScenario, createsThenEmpty);
    assert.equal(steps.find((step) => step.purpose === "prepare")!.auth, "default");
    assert.equal(steps.find((step) => step.purpose === "act")!.auth, "none");
  });
});

describe("aserciones sobre una respuesta", () => {
  const base = {
    method: "GET",
    operationPath: "/things",
    expectedStatus: 200,
    expectedShape: "{ data: [...], meta, links }",
    errorShape: "ProblemDetails",
    schema: null,
    budget: null,
    latencySamples: [10],
  };
  const response = (over: Partial<ActualResponse>): ActualResponse => ({
    status: 200,
    statusText: "OK",
    contentType: "application/json",
    headers: {},
    body: { data: [] },
    raw: '{"data":[]}',
    ...over,
  });

  test("un 200 con el envelope correcto pasa", () => {
    const verdict = evaluateResponse({ ...base, actual: response({}) });
    assert.equal(verdict.ok, true);
  });

  test("un 200 con el envelope roto falla, y falla la aserción de schema", () => {
    // The status assertion still passes, which is the point: "the API answered 200" and "the API
    // answered what it promised" are different claims.
    const verdict = evaluateResponse({ ...base, actual: response({ body: { items: [] }, raw: '{"items":[]}' }) });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.assertions.find((assertion) => assertion.label === "Status 200")!.pass, true);
    assert.equal(verdict.assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.pass, false);
  });

  test("un 405 es su propio diagnóstico y silencia el resto", () => {
    const verdict = evaluateResponse({ ...base, actual: response({ status: 405, body: "", raw: "" }) });
    assert.equal(verdict.notImplemented, true);
    assert.match(verdict.assertions[0].detail, /no está implementado/);
    // No latency assertion at all: nothing downstream says anything useful about a response the
    // API never produced.
    assert.equal(
      verdict.assertions.some((assertion) => /ms/.test(assertion.label)),
      false,
    );
  });

  test("sin schema declarado se verifica el envelope y se dice que fue eso", () => {
    const verdict = evaluateResponse({ ...base, actual: response({}) });
    assert.match(
      verdict.assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.detail,
      /no declara 200/,
    );
  });

  test("con schema declarado manda el schema", () => {
    const schema = { type: "object", required: ["data"], properties: { data: { type: "array" } } };
    assert.equal(evaluateResponse({ ...base, schema, actual: response({}) }).ok, true);
    const broken = evaluateResponse({ ...base, schema, actual: response({ body: { data: "no es un array" } }) });
    assert.equal(broken.ok, false);
    assert.match(
      broken.assertions.find((assertion) => assertion.label === "Schema OpenAPI")!.detail,
      /tipo esperado array/,
    );
  });

  test("sin presupuesto no se emite aserción de latencia", () => {
    const verdict = evaluateResponse({ ...base, actual: response({}) });
    assert.equal(verdict.assertions.length, 3);
  });

  test("con presupuesto incumplido el caso falla aunque todo lo demás esté bien", () => {
    // The number that can disqualify the delivery is an assertion like any other.
    const verdict = evaluateResponse({
      ...base,
      budget: { ms: 70, label: "GET p95 < 70 ms", source: "RFP §6" },
      latencySamples: [120],
      actual: response({}),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.assertions.at(-1)!.pass, false);
  });

  test("un 204 se espera sin cuerpo aunque nadie lo configure", () => {
    // RFC 9110 says a 204 cannot contain content. A project that had to declare that would be
    // configuring the specification, and every project that forgot would see a red DELETE.
    const bare = defineProjectConfig({});
    assert.equal(expectedShapeFor(find("deleteThing"), 204, bare), "No body");
    assert.equal(expectedShapeFor(find("deleteThing"), 404, bare), bare.envelope.errorShape);
    assert.equal(expectedShapeFor(find("getThing"), 200, bare), bare.envelope.fallbackShape);
  });

  test("un 204 debe venir sin cuerpo", () => {
    const noBody = { ...base, expectedStatus: 204, expectedShape: "No body" };
    assert.equal(
      evaluateResponse({ ...noBody, actual: response({ status: 204, contentType: "", body: "", raw: "" }) }).ok,
      true,
    );
    assert.equal(
      evaluateResponse({ ...noBody, actual: response({ status: 204, body: "algo", raw: "algo" }) }).ok,
      false,
    );
  });

  test("un error debe traer Problem Details, no un objeto cualquiera", () => {
    const error = { ...base, expectedStatus: 404, expectedShape: "ProblemDetails" };
    assert.equal(
      evaluateResponse({ ...error, actual: response({ status: 404, body: { type: "x", title: "y", status: 404 } }) })
        .ok,
      true,
    );
    // `{ "error": "not found" }` is the shape this assertion exists to reject.
    assert.equal(
      evaluateResponse({ ...error, actual: response({ status: 404, body: { error: "not found" } }) }).ok,
      false,
    );
  });
});

describe("envelope y campos persistidos", () => {
  test("la clave del envelope se lee de la forma configurada", () => {
    const actual: ActualResponse = {
      status: 200,
      statusText: "",
      contentType: "application/json",
      headers: {},
      body: { payload: {} },
      raw: "{}",
    };
    assert.equal(matchesShape(actual, "{ payload: Resource }", "ProblemDetails"), true);
    assert.equal(matchesShape(actual, "{ data: Resource }", "ProblemDetails"), false);
  });

  test("el identificador se captura a través del envelope del proyecto", () => {
    assert.equal(capturedId({ payload: { id: 7 } }, "{ payload: Resource }", "id"), "7");
    assert.equal(capturedId({ data: { id: null } }, "{ data: Resource }", "id"), undefined);
  });

  test("un campo que cambia de tipo al persistirse es un fallo", () => {
    // `4900` and `"4900"` is a contract violation, not a formatting detail.
    assert.equal(verifyPersistedFields({ price: "4900" }, { price: 4900 }).pass, false);
    assert.equal(verifyPersistedFields({ price: 4900 }, { price: 4900 }).pass, true);
  });

  test("nombra los campos que no coinciden", () => {
    const assertion = verifyPersistedFields({ a: 1, b: 2 }, { a: 1, b: 9, c: 3 });
    assert.equal(assertion.pass, false);
    assert.match(assertion.detail, /b, c/);
  });

  test("sin recurso en la respuesta, lo dice en vez de listar todos los campos", () => {
    assert.match(verifyPersistedFields(undefined, { a: 1 }).detail, /no contiene el recurso/);
  });
});
