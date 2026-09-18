/**
 * Una petición GraphQL de Postman, de ida y de vuelta.
 *
 * Antes de esto, `mode: "graphql"` caía en el «no es raw» del lector y la petición llegaba sin
 * cuerpo, sin decirlo: una colección de GraphQL se importaba entera y ninguna operación mandaba
 * nada. Lo que decide algo:
 *
 * - **Se lee la operación y sus variables aparte**, y el cuerpo lleva además el JSON que viaja, para
 *   quien no sabe de GraphQL.
 * - **Un endpoint la guarda en el modo `graphql`** y un flujo la convierte en nodo `graphql`, el que
 *   lee `errors` en un 200.
 * - **Sale otra vez como `mode: "graphql"`**, y lo que sale vuelve a entrar igual.
 * - **La documentación publicada tapa las variables** como tapa un cuerpo JSON.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseEndpointFile } from "@/modules/endpoints/domain/import-endpoints";
import { EMPTY_BODY } from "@/modules/endpoints/domain/model";
import { docBody } from "@/modules/docs/domain/doc-page";
import { toPostmanExport } from "@/modules/projects/domain/postman-export";
import type { ProjectBundle } from "@/modules/projects/domain/project-bundle";
import { parseInsomniaExport, readPostmanCollection as readOrNull } from "@/modules/workflows/domain/import-requests";
import { definitionFrom, graphqlCallFrom } from "@/modules/workflows/domain/postman-flows";

/** Todas estas colecciones se leen: `null` sería un fallo del fixture, no del lector. */
const readPostmanCollection = (text: string) => {
  const read = readOrNull(text);
  assert.ok(read);
  return read;
};

const QUERY = "query Usuario($id: ID!) {\n  user(id: $id) {\n    name\n  }\n}";

const collection = (body: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    info: { name: "API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [
      {
        name: "Usuario",
        request: { method: "POST", url: "{{base}}/graphql", header: [], body, ...extra },
      },
    ],
  });

const graphqlBody = (variables: unknown) => ({ mode: "graphql", graphql: { query: QUERY, variables } });

describe("leer una petición GraphQL de Postman", () => {
  test("la operación y las variables aparte, y el cuerpo con el JSON que viaja", () => {
    const read = readPostmanCollection(collection(graphqlBody('{"id": "7"}')));
    const request = read.items[0]!.request;
    assert.deepEqual(request.graphql, { query: QUERY, variables: '{"id": "7"}' });
    assert.deepEqual(request.body, { type: "json", json: { query: QUERY, variables: { id: "7" } } });
  });

  test("unas variables con una plantilla sin comillas no se tiran: van como texto", () => {
    const read = readPostmanCollection(collection(graphqlBody('{"first": {{count}}}')));
    const request = read.items[0]!.request;
    assert.equal(request.graphql?.variables, '{"first": {{count}}}');
    assert.equal(request.body.type, "raw");
    if (request.body.type === "raw") {
      assert.equal(request.body.contentType, "application/json");
      assert.match(request.body.text, /"variables":\{"first": \{\{count\}\}\}/);
    }
  });

  test("sin operación no es GraphQL: sin cuerpo, como antes, y sin inventar nada", () => {
    const read = readPostmanCollection(collection({ mode: "graphql", graphql: { query: "  " } }));
    assert.equal(read.items[0]!.request.graphql, undefined);
    assert.deepEqual(read.items[0]!.request.body, { type: "none" });
  });

  test("Insomnia guarda lo mismo como `application/graphql` con las variables en objeto", () => {
    const read = parseInsomniaExport(
      JSON.stringify({
        _type: "export",
        resources: [
          {
            _id: "req_1",
            _type: "request",
            name: "Usuario",
            method: "POST",
            url: "https://api.test/graphql",
            body: { mimeType: "application/graphql", text: JSON.stringify({ query: QUERY, variables: { id: "7" } }) },
          },
        ],
      }),
    );
    assert.deepEqual(read.requests[0]!.graphql, { query: QUERY, variables: '{\n  "id": "7"\n}' });
  });
});

describe("un endpoint y un nodo de flujo", () => {
  test("como endpoint entra en el modo graphql, con la operación en `text`", () => {
    const parsed = parseEndpointFile("postman", collection(graphqlBody('{"id": "7"}')));
    assert.deepEqual(parsed.drafts[0]!.body, {
      ...EMPTY_BODY,
      mode: "graphql",
      text: QUERY,
      contentType: "application/json",
      variables: '{"id": "7"}',
    });
  });

  test("como nodo de flujo es un nodo graphql, con su autenticación y sin el Content-Type de la colección", () => {
    const read = readPostmanCollection(
      collection(graphqlBody(""), {
        header: [
          { key: "Content-Type", value: "application/json" },
          { key: "X-Tenant", value: "acme" },
        ],
        auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
      }),
    );
    const call = graphqlCallFrom(read.items[0]!, 200);
    assert.ok(call && typeof call !== "string");
    if (!call || typeof call === "string") return;
    assert.deepEqual(call.graphql, {
      url: "{{base}}/graphql",
      query: QUERY,
      headers: { "X-Tenant": "acme" },
      expectedStatus: 200,
      auth: { type: "bearer", params: { token: "{{token}}" } },
    });
    const definition = definitionFrom([
      {
        label: "Usuario",
        source: { kind: "graphql", graphql: call.graphql },
        checks: [],
        captures: [],
        prerequest: "",
        test: "",
      },
    ]);
    assert.equal(definition.steps[0]!.kind, "graphql");
    assert.equal(definition.steps[0]!.graphql?.query, QUERY);
  });

  test("unas variables que no pueden ser un objeto no se convierten en un nodo que no valida", () => {
    const read = readPostmanCollection(collection(graphqlBody("[1, 2]")));
    assert.equal(typeof graphqlCallFrom(read.items[0]!, null), "string");
  });

  test("una petición que no es GraphQL no es asunto de este nodo", () => {
    const read = readPostmanCollection(collection({ mode: "raw", raw: "{}" }));
    assert.equal(graphqlCallFrom(read.items[0]!, null), null);
  });
});

const bundle = (patch: Partial<ProjectBundle>): ProjectBundle =>
  ({
    format: "endpoint-quality/project",
    version: 1,
    project: { name: "API" },
    settings: { baseUrl: "https://api.test" },
    ...patch,
  }) as ProjectBundle;

describe("de vuelta a Postman", () => {
  test("un endpoint graphql sale como `mode: graphql`, y vuelve a entrar igual", () => {
    const exported = toPostmanExport(
      bundle({
        endpoints: [
          {
            method: "POST",
            path: "/graphql",
            description: "",
            pathParameters: [],
            query: [],
            headers: [],
            body: {
              mode: "graphql",
              text: QUERY,
              contentType: "application/json",
              fields: [],
              variables: '{"id": "7"}',
            },
            requiresAuth: false,
            tags: [],
            status: "active",
            operationId: null,
            preRequestScript: "",
            postResponseScript: "",
          },
        ],
      } as never),
      { collectionId: "c", environmentIds: [] },
      { contents: "endpoints" },
    );
    const [item] = exported.collection.item as { request: { body: unknown } }[];
    assert.deepEqual(item!.request.body, { mode: "graphql", graphql: { query: QUERY, variables: '{"id": "7"}' } });

    const back = parseEndpointFile("postman", JSON.stringify(exported.collection));
    assert.equal(back.drafts[0]!.body?.mode, "graphql");
    assert.equal(back.drafts[0]!.body?.text, QUERY);
    assert.equal(back.drafts[0]!.body?.variables, '{"id": "7"}');
  });

  test("un nodo graphql ya no se queda fuera del fichero; lo que no cabe se dice", () => {
    const exported = toPostmanExport(
      bundle({
        flows: {
          requestTemplates: [],
          workflows: [
            {
              id: "w1",
              name: "Usuarios",
              description: null,
              status: "ready",
              definition: {
                steps: [
                  {
                    id: "usuario",
                    kind: "graphql",
                    graphql: {
                      url: "{{base}}/graphql",
                      query: QUERY,
                      variables: '{"id": "7"}',
                      operationName: "Usuario",
                      auth: { type: "bearer", params: { token: "{{token}}" } },
                    },
                  },
                ],
              },
            },
          ],
          datasets: [],
          suites: [],
        },
      } as never),
      { collectionId: "c", environmentIds: [] },
    );
    const folder = exported.collection.item[0] as { item: { request: Record<string, unknown> }[] };
    const request = folder.item[0]!.request;
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, { mode: "graphql", graphql: { query: QUERY, variables: '{"id": "7"}' } });
    assert.equal((request.auth as { type: string }).type, "bearer");
    assert.doesNotMatch(exported.skipped.map((entry) => entry.detail).join(" | "), /«graphql»/);
    assert.match(exported.skipped.map((entry) => entry.detail).join(" | "), /operationName «Usuario»/);

    // Y vuelve como nodo graphql, con la misma operación.
    const read = readPostmanCollection(JSON.stringify(exported.collection));
    const call = graphqlCallFrom(read.items[0]!, null);
    assert.ok(call && typeof call !== "string");
    if (call && typeof call !== "string") assert.equal(call.graphql.query, QUERY);
  });
});

describe("la documentación publicada", () => {
  test("la operación sale tal cual y las variables, tapadas como un cuerpo JSON", () => {
    const body = docBody({
      ...EMPTY_BODY,
      mode: "graphql",
      text: QUERY,
      variables: '{"id": "7", "password": "hunter2"}',
    });
    assert.equal(body?.mode, "graphql");
    assert.equal(body?.text, QUERY);
    assert.doesNotMatch(body?.variables ?? "", /hunter2/);
    assert.deepEqual(body?.masked, ["password"]);
  });
});
