/**
 * The `mock` node, run by the real engine.
 *
 * What has to be true is that a response nobody sent is indistinguishable from a real one for the
 * nodes after it — an If, a schema, a capture read into a set — and completely distinguishable in the
 * report. The fixture is the smallest slice of `runs.test.ts` a flow needs: a project, a contract, an
 * environment. The stub target is there because an environment wants one; the mocks never call it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}

/** A project with a contract, an environment with `variables`, and an empty flow to fill in. */
async function flowAgainst(variables: Record<string, string | { initial: string; current: string; sensitive: boolean }>) {
  const target = new StubTarget({});
  await target.start();
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `mock-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
  const imported = await api()
    .post(`${projectBase}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const environment = await api()
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: "stub",
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: true,
      authEnforced: false,
      variables,
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  const workflow = await api()
    .post(`${projectBase}/workflows`)
    .set(as(owner))
    .send({ name: "Con mock", definition: { steps: [{ id: "inicio", kind: "wait", waitMs: 1 }] } });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  return {
    target,
    projectBase,
    environmentId: environment.body.environmentId as string,
    workflowId: workflow.body.workflowId as string,
  };
}

async function runAndWait(projectBase: string, body: Record<string, unknown>) {
  const started = await api().post(`${projectBase}/runs`).set(as(owner)).send(body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await context.queue.idle();
  const run = await api().get(`${projectBase}/runs/${started.body.runId}`).set(as(owner));
  return run.body;
}

type RunCaseRow = { id: string; scenarioId: string; status: string; method: string; path: string; failure: string | null };

before(async () => {
  context = await createTestApp();
  owner = await signUp("mock-owner@example.com");
});

after(async () => {
  await context?.close();
});

describe("el nodo mock", () => {
  test("responde sin red; lo de después lo lee como una respuesta y el informe dice que es simulada", async () => {
    // `apiKey` is sensitive: only those are masked in what the report stores.
    const flow = await flowAgainst({
      entityName: "pedido",
      apiKey: { initial: "clave-muy-secreta", current: "", sensitive: true },
    });
    const check = (value: string) => ({ source: "status", operator: "equals", value });
    // simulado(201, captura thingId) → si(If sobre el estado) → en-si(set, rama «sí»)
    //                                → esquema(propio, cumple) · copia(set {{thingId}})
    // mal(variable inexistente, falla) → tras-mal(se salta)
    // estado-malo(500 con check de 200, falla)
    const saved = await api()
      .put(`${flow.projectBase}/workflows/${flow.workflowId}`)
      .set(as(owner))
      .send({
        definition: {
          steps: [
            {
              id: "simulado",
              kind: "mock",
              mock: {
                status: 201,
                headers: { "Content-Type": "application/json", "X-Clave": "{{apiKey}}" },
                body: '{"data": {"id": "{{entityName}}-1", "total": 3}}',
                delayMs: 20,
              },
              checks: [check("201"), { source: "durationMs", operator: "greater_than", value: "10" }],
              captures: [{ variable: "thingId", from: "body", path: "data.id" }],
            },
            { id: "si", kind: "branch", dependsOn: ["simulado"], condition: { from: "simulado", check: check("201") } },
            {
              id: "en-si",
              kind: "set",
              dependsOn: ["si"],
              branch: { of: "si", take: "then" },
              set: { assignments: [{ variable: "rama", value: "sí" }] },
            },
            {
              id: "esquema",
              kind: "schema",
              dependsOn: ["simulado"],
              schema: {
                from: "simulado",
                source: "custom",
                json: JSON.stringify({ type: "object", required: ["data"], properties: { data: { type: "object", required: ["id"] } } }),
              },
            },
            { id: "copia", kind: "set", dependsOn: ["simulado"], set: { assignments: [{ variable: "copia", value: "{{thingId}}" }] } },
            { id: "mal", kind: "mock", mock: { status: 200, body: "{{noExiste}}" } },
            { id: "tras-mal", kind: "set", dependsOn: ["mal"], set: { assignments: [{ variable: "nada", value: "x" }] } },
            { id: "estado-malo", kind: "mock", mock: { status: 500 }, checks: [check("200")] },
          ],
        },
      });
    assert.equal(saved.status, 204, JSON.stringify(saved.body));

    const run = await runAndWait(flow.projectBase, { environmentId: flow.environmentId, workflowId: flow.workflowId });
    const caseOf = (stepId: string) => run.cases.find((item: RunCaseRow) => item.scenarioId.endsWith(`:${stepId}`)) as RunCaseRow;
    const detailOf = async (stepId: string) =>
      (await api().get(`${flow.projectBase}/runs/${run.id}/cases/${caseOf(stepId).id}`).set(as(owner))).body.steps[0];

    assert.equal(caseOf("simulado").status, "passed");
    assert.equal(caseOf("simulado").method, "MOCK");
    assert.equal(caseOf("simulado").path, "201");
    assert.equal(caseOf("si").status, "passed");
    assert.equal(caseOf("en-si").status, "passed");
    assert.equal(caseOf("esquema").status, "passed");
    assert.equal(caseOf("copia").status, "passed");
    assert.equal(caseOf("mal").status, "failed");
    assert.equal(caseOf("mal").failure, "config");
    assert.equal(caseOf("tras-mal").status, "skipped");
    assert.equal(caseOf("estado-malo").status, "failed");
    assert.equal(caseOf("estado-malo").failure, "check");

    const simulated = await detailOf("simulado");
    assert.equal(simulated.actual.status, 201);
    assert.deepEqual(simulated.actual.body, { data: { id: "pedido-1", total: 3 } });
    // The environment's secret is masked in what the report stores.
    assert.equal(simulated.actual.headers["x-clave"], "••••••••");
    assert.equal(simulated.request.method, "MOCK");
    const labels = simulated.assertions.map((assertion: { label: string }) => assertion.label);
    assert.equal(labels[0], "Respuesta simulada");
    assert.match(simulated.assertions[0].detail, /No se hizo ninguna petición de red/);
    assert.ok(labels.includes("Variables capturadas"), JSON.stringify(labels));
    assert.match((await detailOf("mal")).assertions[0].detail, /Faltan variables: noExiste/);
    await flow.target.stop();
  });

  test("no se guarda un mock con JSON roto, ni un reintento que lo repita", async () => {
    const flow = await flowAgainst({});
    const put = (steps: unknown[]) =>
      api().put(`${flow.projectBase}/workflows/${flow.workflowId}`).set(as(owner)).send({ definition: { steps } });
    const broken = await put([
      { id: "m", kind: "mock", mock: { status: 200, headers: { "content-type": "application/json" }, body: '{"a":' } },
    ]);
    assert.equal(broken.status, 422);
    const polled = await put([
      { id: "m", kind: "mock", mock: { status: 200 } },
      {
        id: "p",
        kind: "poll",
        dependsOn: ["m"],
        poll: { from: "m", attempts: 2, delayMs: 0 },
        checks: [{ source: "status", operator: "equals", value: "200" }],
      },
    ]);
    assert.equal(polled.status, 422);
    await flow.target.stop();
  });
});
