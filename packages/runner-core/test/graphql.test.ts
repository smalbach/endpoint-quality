import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  graphqlAssertion,
  graphqlBody,
  graphqlErrors,
  graphqlVariablesProblem,
  parseGraphqlVariables,
} from "../src/graphql.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("variables de un nodo GraphQL", () => {
  test("una plantilla vale dentro de una cadena o en lugar de un valor; el JSON roto o que no es objeto, no", () => {
    assert.equal(graphqlVariablesProblem(undefined), null);
    assert.equal(graphqlVariablesProblem("   "), null);
    assert.equal(graphqlVariablesProblem('{"id": "{{thingId}}"}'), null);
    assert.equal(graphqlVariablesProblem('{"first": {{count}}, "after": "{{$uuid}}"}'), null);
    assert.equal(graphqlVariablesProblem('{"filtro": {"nombre": "a \\"{{b}}\\" c"}}'), null);
    assert.match(graphqlVariablesProblem('{"id": {{thingId}}') ?? "", /no son JSON válido/);
    assert.match(graphqlVariablesProblem("[1, 2]") ?? "", /objeto JSON/);
    assert.match(graphqlVariablesProblem("{{todo}}") ?? "", /objeto JSON/);
  });

  test("tras sustituir se vuelve a leer, y lo que ya no es objeto lo dice", () => {
    assert.deepEqual(parseGraphqlVariables('{"first": 5}'), { ok: true, value: { first: 5 } });
    assert.deepEqual(parseGraphqlVariables(""), { ok: true, value: undefined });
    const broken = parseGraphqlVariables('{"first": abc}');
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.match(broken.problem, /tras sustituir/);
  });

  test("el body lleva query, y variables y operationName solo cuando existen", () => {
    assert.equal(graphqlBody({ query: "{ a }" }), '{"query":"{ a }"}');
    assert.deepEqual(JSON.parse(graphqlBody({ query: "query Q { a }", variables: { x: 1 }, operationName: "Q" })), {
      query: "query Q { a }",
      variables: { x: 1 },
      operationName: "Q",
    });
  });
});

describe("respuesta de un nodo GraphQL", () => {
  test("errors no vacío falla y lista los mensajes; allowErrors lo deja pasar", () => {
    const body = { data: null, errors: [{ message: "Campo desconocido" }, { message: "Otro" }] };
    assert.deepEqual(graphqlErrors(body), { shaped: true, messages: ["Campo desconocido", "Otro"] });
    const failed = graphqlAssertion(body);
    assert.equal(failed.pass, false);
    assert.match(failed.detail, /2 errores: Campo desconocido · Otro/);
    const allowed = graphqlAssertion(body, true);
    assert.equal(allowed.pass, true);
    assert.match(allowed.detail, /permitidos/);
  });

  test("sin errores pasa; un body que no es de GraphQL falla", () => {
    assert.equal(graphqlAssertion({ data: { a: 1 } }).pass, true);
    assert.equal(graphqlAssertion({ data: { a: 1 }, errors: [] }).pass, true);
    assert.equal(graphqlAssertion("<html>").pass, false);
    assert.equal(graphqlAssertion({ ok: true }).pass, false);
  });

  test("muchos errores se recortan a unos pocos", () => {
    const body = { errors: Array.from({ length: 8 }, (_, index) => ({ message: `e${index}` })) };
    assert.match(graphqlAssertion(body).detail, /8 errores: e0 · e1 · e2 · e3 · e4 \(y 3 más\)/);
  });
});

describe("esquema del nodo GraphQL", () => {
  const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps });
  const node = (graphql: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
    id: "g",
    kind: "graphql",
    ...(graphql ? { graphql } : {}),
    ...extra,
  });

  test("lleva URL y query; variables como objeto con plantillas; operationName como nombre GraphQL", () => {
    assert.equal(
      parse([
        node({
          url: "/graphql",
          query: "query Cosa($id: ID!) { cosa(id: $id) { id } }",
          variables: '{"id": "{{thingId}}", "n": {{count}}}',
          operationName: "Cosa",
          headers: { "X-Tenant": "{{tenant}}" },
          useSession: true,
          allowErrors: false,
          expectedStatus: 200,
        }),
      ]).ok,
      true,
    );
    assert.equal(parse([node({ url: "https://api.ejemplo.com/graphql", query: "{ a }" })]).ok, true);
  });

  test("rechaza lo que no se podría enviar", () => {
    const issues = (steps: unknown[]) => {
      const result = parse(steps);
      return result.ok ? [] : result.issues.map((issue) => issue.detail);
    };
    assert.ok(issues([node(undefined)]).some((detail) => detail.includes("URL y su query")));
    assert.ok(issues([node({ url: "/graphql", query: "  " })]).some((detail) => detail.includes("query")));
    assert.ok(issues([node({ url: "", query: "{ a }" })]).some((detail) => detail.includes("URL")));
    assert.ok(issues([node({ url: "/graphql", query: "{ a }", variables: "[1]" })]).some((detail) => detail.includes("objeto")));
    assert.ok(issues([node({ url: "/graphql", query: "{ a }", variables: '{"a": ' })]).some((detail) => detail.includes("JSON")));
    assert.equal(parse([node({ url: "/graphql", query: "{ a }", operationName: "no-vale" })]).ok, false);
    assert.equal(parse([node({ url: "/graphql\r\nHost: y", query: "{ a }" })]).ok, false);
    // El bloque solo en un nodo GraphQL, y un nodo GraphQL no lleva petición guardada.
    assert.equal(parse([{ id: "a", requestTemplateId: uuid(1), graphql: { url: "/graphql", query: "{ a }" } }]).ok, false);
    assert.ok(
      issues([node({ url: "/graphql", query: "{ a }" }, { requestTemplateId: uuid(1) })]).some((detail) =>
        detail.includes("petición escrita"),
      ),
    );
  });
});
