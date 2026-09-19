/**
 * Bordes del reparto de una colección en flujos: ids libres, scripts largos, llamadas que no caben
 * en un nodo y el nodo GraphQL. Complementa `postman-flows.test.ts`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { PostmanItem } from "@/modules/workflows/domain/import-requests";
import {
  definitionFrom,
  fetchCallFrom,
  flowsOf,
  freeId,
  graphqlCallFrom,
  type PostmanStepDraft,
} from "@/modules/workflows/domain/postman-flows";

const item = (request: Partial<PostmanItem["request"]> = {}): PostmanItem => ({
  trail: [],
  name: "Uno",
  label: "Uno",
  request: {
    name: "Uno",
    method: "POST",
    url: "{{base}}/x",
    headers: {},
    examples: [],
    body: { type: "none" },
    auth: { type: "inherit", params: {} },
    ...request,
  },
  prerequest: "",
  test: "",
});

describe("freeId", () => {
  test("a name with nothing usable becomes «paso», and repeated names get increasing suffixes", () => {
    const taken = new Set<string>();
    assert.equal(freeId("¡¿?!", taken), "paso");
    assert.equal(freeId("", taken), "paso-2");
    assert.equal(freeId("***", taken), "paso-3");
    assert.equal(freeId("Canción Ñandú", taken), "cancion-nandu");
    assert.equal(freeId("x".repeat(80), taken), "x".repeat(40));
  });
});

describe("flowsOf", () => {
  test("a nameless collection's root flow gets a default name and folders keep their order", () => {
    const flows = flowsOf({
      name: "  ",
      items: [{ ...item(), trail: ["B"] }, item(), { ...item(), trail: ["B", "c"] }],
    });
    assert.deepEqual(
      flows.map((flow) => [flow.name, flow.items.length]),
      [
        ["Colección importada", 1],
        ["B", 2],
      ],
    );
  });
});

describe("definitionFrom", () => {
  test("checks and captures ride on the node; a script over 20 000 chars is cut and says so", () => {
    const long = "a".repeat(25_000);
    const draft: PostmanStepDraft = {
      label: "Paso",
      source: { kind: "request", requestTemplateId: "tpl-1" },
      checks: [{ source: "status", operator: "equals", value: 200 }],
      captures: [{ variable: "id", from: "body", path: "id" }],
      prerequest: long,
      test: "",
    };
    const document = definitionFrom([draft]);
    assert.equal(document.steps.length, 2);
    const [pre, node] = document.steps;
    assert.equal(pre.id, "paso-antes");
    assert.equal(pre.script?.code.length, 20_000);
    assert.ok(pre.script?.code.endsWith("superaba los 20.000 caracteres."));
    assert.equal(node.id, "paso");
    assert.equal(node.requestTemplateId, "tpl-1");
    assert.deepEqual(node.dependsOn, ["paso-antes"]);
    assert.deepEqual(node.checks, draft.checks);
    assert.deepEqual(node.captures, draft.captures);
    assert.deepEqual(node.position, { x: 40, y: 210 });
  });

  test("a graphql node, a second step chained after a test script", () => {
    const document = definitionFrom([
      {
        label: "G",
        source: { kind: "graphql", graphql: { url: "/g", query: "{ a }" } },
        checks: [],
        captures: [],
        prerequest: "",
        test: "pm.visualizer.set('x')",
      },
      {
        label: "G",
        source: { kind: "fetch", fetch: { method: "GET", url: "/x" } },
        checks: [],
        captures: [],
        prerequest: "  ",
        test: "",
      },
    ]);
    assert.deepEqual(
      document.steps.map((step) => [step.id, step.kind ?? "request", step.dependsOn ?? []]),
      [
        ["g", "graphql", []],
        ["g-test", "script", ["g"]],
        ["g-2", "fetch", ["g-test"]],
      ],
    );
    assert.equal(document.steps[1].script?.from, "g");
    assert.equal(document.steps[0].checks, undefined);
  });
});

describe("fetchCallFrom", () => {
  test("refuses methods, URLs and bodies a fetch node cannot carry", () => {
    assert.equal(fetchCallFrom(item({ method: "propfind" }), null), "el método PROPFIND no se puede enviar");
    assert.equal(fetchCallFrom(item({ url: "   " }), null), "la URL no se puede leer");
    assert.equal(fetchCallFrom(item({ url: "/a\n/b" }), null), "la URL no se puede leer");
    assert.equal(fetchCallFrom(item({ url: `/${"a".repeat(2001)}` }), null), "la URL es demasiado larga");
    assert.equal(
      fetchCallFrom(item({ body: { type: "form-data", fields: {}, disabledFields: {} } }), null),
      "un cuerpo multipart no cabe en un nodo fetch: impórtalo como endpoint",
    );
  });

  test("a raw body without type is sent as text/plain; headers are filtered and a declared auth is kept", () => {
    const call = fetchCallFrom(
      item({
        body: { type: "raw", text: "hola", contentType: "" },
        headers: {
          "Bad Header": "x",
          "User-Agent": "PostmanRuntime",
          "X-Multi": "a\r\nb",
          Authorization: "Bearer eyJ.literal",
          "X-Api-Key": "{{key}}",
          "X-Ok": "1",
        },
        auth: { type: "bearer", params: { token: "{{t}}" } },
      }),
      201,
    );
    assert.ok(typeof call !== "string");
    assert.equal(call.droppedCredential, true);
    assert.deepEqual(call.fetch, {
      method: "POST",
      url: "{{base}}/x",
      headers: { "X-Api-Key": "{{key}}", "X-Ok": "1", "Content-Type": "text/plain" },
      body: "hola",
      expectedStatus: 201,
      useSession: true,
      auth: { type: "bearer", params: { token: "{{t}}" } },
    });
  });
});

describe("graphqlCallFrom", () => {
  const gql = (request: Partial<PostmanItem["request"]> = {}) =>
    item({ graphql: { query: "{ a }", variables: "" }, ...request });

  test("not GraphQL is null; bad URLs and non-object variables are refused", () => {
    assert.equal(graphqlCallFrom(item(), null), null);
    assert.equal(graphqlCallFrom(gql({ url: "" }), null), "la URL no se puede leer");
    assert.equal(graphqlCallFrom(gql({ url: "/g\r/h" }), null), "la URL no se puede leer");
    assert.equal(graphqlCallFrom(gql({ url: `/${"g".repeat(2001)}` }), null), "la URL es demasiado larga");
    assert.equal(
      graphqlCallFrom(gql({ graphql: { query: "{ a }", variables: "[1]" } }), null),
      "sus variables de GraphQL no son un objeto JSON",
    );
  });

  test("drops the content type and a literal credential, keeps variables and auth", () => {
    const call = graphqlCallFrom(
      gql({
        graphql: { query: "{ a }", variables: '{"id": 1}' },
        headers: { "Content-Type": "application/json", Cookie: "sid=secret", "X-T": "1" },
        auth: { type: "basic", params: { username: "u", password: "" } },
      }),
      200,
    );
    assert.ok(call && typeof call !== "string");
    assert.equal(call.droppedCredential, true);
    assert.deepEqual(call.graphql, {
      url: "{{base}}/x",
      query: "{ a }",
      variables: '{"id": 1}',
      headers: { "X-T": "1" },
      expectedStatus: 200,
      useSession: true,
      auth: { type: "basic", params: { username: "u", password: "" } },
    });
  });

  test("a minimal call carries only url and query", () => {
    const call = graphqlCallFrom(gql({ headers: { "content-type": "application/json" } }), null);
    assert.deepEqual(call, { graphql: { url: "{{base}}/x", query: "{ a }" }, droppedCredential: false });
  });
});
