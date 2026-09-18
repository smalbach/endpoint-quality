/**
 * The `graphql` node, against a GraphQL endpoint on loopback.
 *
 * The point of the node is the case a status cannot see: a GraphQL server answers a query it
 * refuses with a 200 and an `errors` array. So the test that matters is «roto»: 200, red, and the
 * server's message in the assertion. The rest proves it travels the fetch's road — variables
 * substituted and parsed, captures and checks over `data`, the writes guard — and that a variables
 * text that stops being JSON after substituting is refused before anything leaves.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { STUB_SPEC_YAML } from "../support/stub-target";
import { GraphqlStub } from "../support/graphql-stub";

let context: TestContext;
const api = () => request(context.app.getHttpServer());
let token = "";
let organizationId = "";
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  context = await createTestApp();
  const email = "graphql-owner@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "graphql-owner" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, `no se pudo iniciar sesión: ${JSON.stringify(session.body)}`);
  token = session.body.accessToken as string;
  organizationId = registered.body.organizationId as string;
});

after(async () => {
  await context?.close();
});

type CaseRow = { id: string; scenarioId: string; status: string; method: string; path: string; failure: string | null };
type Detail = {
  steps: { request: { method: string; url: string; body: unknown; headers: Record<string, string> }; assertions: { label: string; pass: boolean; detail: string }[] }[];
};

/** A project whose environment points at the stub, one flow with `steps`, and that flow run to the end. */
async function runFlow(
  stub: GraphqlStub,
  steps: unknown[],
  environment: { writesAllowed?: boolean; variables?: Record<string, string> } = {},
) {
  const project = await api()
    .post(`/orgs/${organizationId}/projects`)
    .set(auth())
    .send({ name: `gql-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectBase = `/orgs/${organizationId}/projects/${project.body.projectId}`;
  const imported = await api()
    .post(`${projectBase}/spec-versions`)
    .set(auth())
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const created = await api()
    .post(`${projectBase}/environments`)
    .set(auth())
    .send({
      name: "graphql",
      baseUrl: stub.origin,
      specUrl: `${stub.origin}/openapi.json`,
      writesAllowed: environment.writesAllowed ?? true,
      authEnforced: false,
      variables: environment.variables ?? {},
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const workflow = await api()
    .post(`${projectBase}/workflows`)
    .set(auth())
    .send({ name: "GraphQL", definition: { steps } });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));

  const started = await api()
    .post(`${projectBase}/runs`)
    .set(auth())
    .send({ environmentId: created.body.environmentId, workflowId: workflow.body.workflowId });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await context.queue.idle();
  const run = await api().get(`${projectBase}/runs/${started.body.runId}`).set(auth());
  const cases = run.body.cases as CaseRow[];
  const caseOf = (stepId: string): CaseRow => {
    const found = cases.find((item) => item.scenarioId.endsWith(`:${stepId}`));
    if (!found) throw new Error(`La corrida no contiene el paso ${stepId}`);
    return found;
  };
  const detailOf = async (stepId: string): Promise<Detail> =>
    (await api().get(`${projectBase}/runs/${started.body.runId}/cases/${caseOf(stepId).id}`).set(auth())).body as Detail;
  return { caseOf, detailOf };
}

describe("el nodo GraphQL", () => {
  test("envía la operación, captura y comprueba sobre data, y falla con errors salvo allowErrors", async () => {
    const stub = new GraphqlStub();
    await stub.start();
    // cosa (ruta relativa, variables con plantillas, captura + check) → usa (URL absoluta, gasta la captura)
    //      → roto (200 con errors: falla) → tras-roto (se salta)
    //      → permitido (200 con errors y allowErrors: pasa)
    //      → mal (las variables dejan de ser JSON al sustituir) · falta (variable inexistente)
    const { caseOf, detailOf } = await runFlow(
      stub,
      [
        {
          id: "cosa",
          kind: "graphql",
          graphql: {
            url: "/graphql",
            query: "query Thing($id: ID!, $first: Int) { thing(id: $id) { id name first } }",
            variables: '{"id": "{{thingId}}", "first": {{primeros}}}',
            operationName: "Thing",
            headers: { "X-Tenant": "acme" },
          },
          captures: [{ variable: "nombre", from: "body", path: "data.thing.name" }],
          checks: [{ source: "body", path: "data.thing.first", operator: "equals", value: "3" }],
        },
        {
          id: "usa",
          kind: "graphql",
          dependsOn: ["cosa"],
          graphql: { url: `${stub.origin}/graphql`, query: "query Again($id: ID!) { thing(id: $id) { name } }", variables: '{"id": "{{nombre}}"}' },
          checks: [{ source: "body", path: "data.thing.name", operator: "equals", value: "cosa-cosa-7" }],
        },
        { id: "roto", kind: "graphql", dependsOn: ["cosa"], graphql: { url: "/graphql", query: "{ broken }" } },
        { id: "tras-roto", kind: "graphql", dependsOn: ["roto"], graphql: { url: "/graphql", query: "{ __typename }" } },
        {
          id: "permitido",
          kind: "graphql",
          dependsOn: ["cosa"],
          graphql: { url: "/graphql", query: "{ broken }", allowErrors: true },
        },
        { id: "mal", kind: "graphql", graphql: { url: "/graphql", query: "query N($n: Int) { __typename }", variables: '{"n": {{cuenta}}}' } },
        { id: "falta", kind: "graphql", graphql: { url: "/graphql", query: "{ __typename }", variables: '{"id": "{{nadie}}"}' } },
      ],
      { variables: { thingId: "7", primeros: "3", cuenta: "abc" } },
    );

    assert.equal(caseOf("cosa").status, "passed");
    assert.equal(caseOf("usa").status, "passed");
    assert.equal(caseOf("roto").status, "failed");
    assert.equal(caseOf("roto").failure, "contract");
    assert.equal(caseOf("tras-roto").status, "skipped");
    assert.equal(caseOf("permitido").status, "passed");
    assert.equal(caseOf("mal").status, "failed");
    assert.equal(caseOf("mal").failure, "config");
    assert.equal(caseOf("falta").status, "failed");

    // The row names the operation, or the URL when it has none.
    assert.equal(caseOf("cosa").method, "GQL");
    assert.equal(caseOf("cosa").path, "Thing");
    assert.equal(caseOf("roto").path, "/graphql");

    // What crossed the wire: a JSON POST with the variables substituted and parsed — `first` a number.
    const thing = stub.requests.find((item) => item.body?.operationName === "Thing");
    assert.ok(thing, "la operación Thing no llegó");
    assert.equal(thing.method, "POST");
    assert.match(thing.headers["content-type"] ?? "", /application\/json/);
    assert.equal(thing.headers["x-tenant"], "acme");
    assert.deepEqual(thing.body, {
      query: "query Thing($id: ID!, $first: Int) { thing(id: $id) { id name first } }",
      variables: { id: "7", first: 3 },
      operationName: "Thing",
    });
    assert.deepEqual(stub.requests.find((item) => item.body?.query === "query Again($id: ID!) { thing(id: $id) { name } }")?.body?.variables, {
      id: "cosa-7",
    });
    // Neither refused node sent anything: cosa, usa, roto and permitido are the only operations.
    assert.equal(stub.operations().length, 4);

    const roto = await detailOf("roto");
    const errors = roto.steps[0].assertions.find((item) => item.label === "Errores GraphQL");
    assert.equal(errors?.pass, false);
    assert.match(errors?.detail ?? "", /Cannot query field "broken"/);
    assert.equal(roto.steps[0].assertions.find((item) => item.label === "Estado HTTP")?.pass, true);

    const cosa = await detailOf("cosa");
    assert.match(cosa.steps[0].request.url, /\/graphql$/);
    assert.deepEqual((cosa.steps[0].request.body as { variables: unknown }).variables, { id: "7", first: 3 });
    assert.match(cosa.steps[0].assertions.at(-1)?.detail ?? "", /nombre/);

    assert.match((await detailOf("mal")).steps[0].assertions[0].detail, /tras sustituir/);
    assert.match((await detailOf("falta")).steps[0].assertions[0].detail, /Faltan variables: nadie/);
    await stub.stop();
  });

  test("un entorno sin escrituras no la envía a su propia URL: es un POST", async () => {
    const stub = new GraphqlStub();
    await stub.start();
    const { caseOf, detailOf } = await runFlow(
      stub,
      [{ id: "leer", kind: "graphql", graphql: { url: "/graphql", query: "{ __typename }" } }],
      { writesAllowed: false },
    );
    assert.equal(caseOf("leer").status, "failed");
    assert.equal(caseOf("leer").failure, "config");
    assert.match((await detailOf("leer")).steps[0].assertions[0].detail, /no permite escrituras/);
    assert.equal(stub.operations().length, 0);
    await stub.stop();
  });

  test("lleva su autenticación como un fetch: Basic con el usuario del entorno y la clave firmada", async () => {
    const stub = new GraphqlStub();
    await stub.start();
    const { caseOf, detailOf } = await runFlow(
      stub,
      [
        {
          id: "firmado",
          kind: "graphql",
          graphql: {
            url: "/graphql",
            query: "{ __typename }",
            auth: { type: "basic", params: { username: "{{usuario}}", password: "{{clave}}" } },
          },
        },
      ],
      { variables: { usuario: "ana", clave: "hunter2" } },
    );
    assert.equal(caseOf("firmado").status, "passed");
    const sent = stub.requests.find((entry) => entry.method === "POST");
    assert.equal(sent?.headers.authorization, `Basic ${Buffer.from("ana:hunter2").toString("base64")}`);
    // En el informe la cabecera sale tapada, como en un fetch.
    assert.doesNotMatch(JSON.stringify(await detailOf("firmado")), /hunter2|YW5hOmh1bnRlcjI/);
    await stub.stop();
  });

  test("una contraseña escrita a mano no se guarda en el documento; la {{variable}} sí", async () => {
    const project = await api()
      .post(`/orgs/${organizationId}/projects`)
      .set(auth())
      .send({ name: `gql-${Math.random().toString(36).slice(2, 8)}` });
    const base = `/orgs/${organizationId}/projects/${project.body.projectId}/workflows`;
    const created = await api()
      .post(base)
      .set(auth())
      .send({
        name: "Con secretos",
        definition: {
          steps: [
            {
              id: "g",
              kind: "graphql",
              graphql: {
                url: "/graphql",
                query: "{ a }",
                auth: { type: "basic", params: { username: "ana", password: "literal-que-no-se-guarda" } },
              },
            },
            {
              id: "f",
              kind: "fetch",
              fetch: { method: "GET", url: "/x", auth: { type: "bearer", params: { token: "{{token}}" } } },
            },
          ],
        },
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const list = await api().get(base).set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const saved = (list.body.workflows as { id: string; steps: unknown[] }[]).find(
      (row) => row.id === created.body.workflowId,
    );
    assert.ok(saved, "el flujo guardado está en la lista");
    assert.equal(JSON.stringify(saved).includes("literal-que-no-se-guarda"), false);
    const steps = saved.steps as { id: string; graphql?: { auth: unknown }; fetch?: { auth: unknown } }[];
    assert.deepEqual(steps.find((step) => step.id === "g")?.graphql?.auth, {
      type: "basic",
      params: { username: "ana", password: "" },
    });
    assert.deepEqual(steps.find((step) => step.id === "f")?.fetch?.auth, {
      type: "bearer",
      params: { token: "{{token}}" },
    });
  });

  test("el documento rechaza variables que no pueden ser un objeto JSON", async () => {
    const stub = new GraphqlStub();
    await stub.start();
    const project = await api()
      .post(`/orgs/${organizationId}/projects`)
      .set(auth())
      .send({ name: `gql-${Math.random().toString(36).slice(2, 8)}` });
    const refused = await api()
      .post(`/orgs/${organizationId}/projects/${project.body.projectId}/workflows`)
      .set(auth())
      .send({
        name: "GraphQL roto",
        definition: { steps: [{ id: "g", kind: "graphql", graphql: { url: "/graphql", query: "{ a }", variables: "[1]" } }] },
      });
    assert.ok(refused.status === 400 || refused.status === 422, `esperado 400/422, recibido ${refused.status}`);
    assert.match(JSON.stringify(refused.body), /objeto JSON/);
    await stub.stop();
  });
});
