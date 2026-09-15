/**
 * The subflow node, against a real HTTP target: a flow that runs another flow of its project inline.
 *
 * The fixture is the minimal copy of `runs.test.ts`'s — a project with the stub contract, two saved
 * requests and an environment — so this file can run on its own.
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

type RunCaseRow = { id: string; scenarioId: string; status: string; method: string };

before(async () => {
  context = await createTestApp();
  const email = "subflow-owner@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "subflow" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  owner = { organizationId: registered.body.organizationId, token: session.body.accessToken };
});

after(async () => {
  await context.app.close();
});

async function newProject(): Promise<string> {
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `p-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  return `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
}

/** A project against a fresh stub, with «Crear» (name from `{{entityName}}`) and «Consultar» (by `{{thingId}}`). */
async function flowAgainst(variables: Record<string, string> = {}) {
  const target = new StubTarget({});
  await target.start();
  const projectBase = await newProject();
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
  const create = await api()
    .post(`${projectBase}/request-templates`)
    .set(as(owner))
    .send({
      name: "Crear",
      operationId: "createThing",
      expectedStatus: 201,
      body: { type: "json", json: { name: "{{entityName}}", size: 7 } },
    });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const read = await api()
    .post(`${projectBase}/request-templates`)
    .set(as(owner))
    .send({ name: "Consultar", operationId: "getThing", expectedStatus: 200, parameters: { id: "{{thingId}}" } });
  assert.equal(read.status, 201, JSON.stringify(read.body));
  return {
    target,
    projectBase,
    environmentId: environment.body.environmentId as string,
    createTemplateId: create.body.requestTemplateId as string,
    readTemplateId: read.body.requestTemplateId as string,
  };
}

async function saveFlow(projectBase: string, name: string, steps: unknown[]) {
  return api().post(`${projectBase}/workflows`).set(as(owner)).send({ name, definition: { steps } });
}

async function createdFlow(projectBase: string, name: string, steps: unknown[] = []): Promise<string> {
  const saved = await saveFlow(projectBase, name, steps);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  return saved.body.workflowId as string;
}

const subflow = (id: string, workflowId: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "subflow",
  subflow: { workflowId },
  ...extra,
});

async function runAndWait(projectBase: string, body: Record<string, unknown>) {
  const started = await api().post(`${projectBase}/runs`).set(as(owner)).send(body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await context.queue.idle();
  const run = await api().get(`${projectBase}/runs/${started.body.runId}`).set(as(owner));
  return run.body as { id: string; status: string; cases: RunCaseRow[] };
}

describe("el nodo sub-flujo", () => {
  test("ejecuta otro flujo con entradas, sus pasos salen bajo el nodo y solo vuelven sus salidas", async () => {
    const flow = await flowAgainst({ prefijo: "base" });
    const child = await createdFlow(flow.projectBase, "Alta", [
      {
        id: "crear",
        requestTemplateId: flow.createTemplateId,
        captures: [{ variable: "thingId", from: "body", path: "data.id" }],
      },
      { id: "marca", kind: "set", dependsOn: ["crear"], set: { assignments: [{ variable: "interno", value: "{{thingId}}" }] } },
    ]);
    const parent = await createdFlow(flow.projectBase, "Principal", [
      subflow("alta", child, {
        subflow: { workflowId: child, inputs: [{ variable: "entityName", value: "{{prefijo}}-hijo" }], outputs: ["thingId"] },
      }),
      { id: "consultar", requestTemplateId: flow.readTemplateId, dependsOn: ["alta"] },
      // `interno` is the child's own variable and not an output: it must not be there.
      { id: "fuga", kind: "set", dependsOn: ["alta"], set: { assignments: [{ variable: "visto", value: "{{interno}}" }] } },
    ]);

    const run = await runAndWait(flow.projectBase, { environmentId: flow.environmentId, workflowId: parent });
    const caseOf = (rest: string) => run.cases.find((item) => item.scenarioId === `workflow:${parent}:${rest}`);
    const detailOf = async (id: string | undefined) =>
      (await api().get(`${flow.projectBase}/runs/${run.id}/cases/${id}`).set(as(owner))).body;

    assert.equal(caseOf("alta")?.method, "FLOW");
    assert.equal(caseOf("alta")?.status, "passed");
    assert.equal(caseOf("alta>crear")?.status, "passed");
    assert.equal(caseOf("alta>marca")?.status, "passed");
    assert.equal(caseOf("consultar")?.status, "passed");
    assert.equal(caseOf("fuga")?.status, "failed");

    const created = await detailOf(caseOf("alta>crear")?.id);
    assert.match(JSON.stringify(created.steps[0].request.body), /base-hijo/);
    const node = await detailOf(caseOf("alta")?.id);
    const note = (label: string) => node.steps[0].assertions.find((item: { label: string }) => item.label === label)?.detail;
    assert.equal(note("Sub-flujo"), "Pasaron sus 2 pasos");
    assert.equal(note("Variables devueltas"), "thingId");
    assert.doesNotMatch(JSON.stringify(node.steps[0].request.body), /base-hijo/);
    assert.match((await detailOf(caseOf("consultar")?.id)).steps[0].request.url, /\/things\/[^/]+$/);
    assert.match(
      (await detailOf(caseOf("fuga")?.id)).steps[0].assertions[0].detail,
      /Faltan variables: interno/,
    );
    await flow.target.stop();
  });

  test("un paso del hijo que falla tumba el nodo y salta lo que depende; un sub-flujo saltado salta sus pasos", async () => {
    const flow = await flowAgainst();
    const broken = await createdFlow(flow.projectBase, "Roto", [
      { id: "pide", kind: "fetch", fetch: { method: "GET", url: "/things", expectedStatus: 418 } },
      { id: "luego", kind: "fetch", dependsOn: ["pide"], fetch: { method: "GET", url: "/things" } },
    ]);
    const list = await createdFlow(flow.projectBase, "Lista", [
      { id: "listar", kind: "fetch", fetch: { method: "GET", url: "/things", expectedStatus: 200 } },
    ]);
    const parent = await createdFlow(flow.projectBase, "Con roto", [
      subflow("roto", broken),
      { id: "despues", kind: "fetch", dependsOn: ["roto"], fetch: { method: "GET", url: "/things" } },
      subflow("otro", list, { dependsOn: ["roto"] }),
    ]);

    const run = await runAndWait(flow.projectBase, { environmentId: flow.environmentId, workflowId: parent });
    const statusOf = (rest: string) => run.cases.find((item) => item.scenarioId === `workflow:${parent}:${rest}`)?.status;
    assert.equal(statusOf("roto"), "failed");
    assert.equal(statusOf("roto>pide"), "failed");
    assert.equal(statusOf("roto>luego"), "skipped");
    assert.equal(statusOf("despues"), "skipped");
    assert.equal(statusOf("otro"), "skipped");
    assert.equal(statusOf("otro>listar"), "skipped");
    assert.equal(run.cases.filter((item) => item.status === "queued").length, 0);
    await flow.target.stop();
  });

  test("al guardar rechaza autorreferencia, ciclos, archivados, otro proyecto y más de 3 niveles", async () => {
    const flow = await flowAgainst();
    const base = flow.projectBase;
    const put = (id: string, body: Record<string, unknown>) => api().put(`${base}/workflows/${id}`).set(as(owner)).send(body);
    const refusal = (response: request.Response, pattern: RegExp) => {
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.match(JSON.stringify(response.body), pattern);
    };

    const a = await createdFlow(base, "A");
    refusal(await put(a, { definition: { steps: [subflow("yo", a)] } }), /el flujo que lo contiene/);

    const b = await createdFlow(base, "B", [subflow("a", a)]);
    refusal(await put(a, { definition: { steps: [subflow("b", b)] } }), /ciclo: «A» › «B» › «A»/);

    const archived = await createdFlow(base, "Viejo");
    assert.equal((await put(archived, { status: "archived" })).status, 204);
    refusal(await saveFlow(base, "Usa viejo", [subflow("v", archived)]), /archivado/);

    const elsewhere = await createdFlow(await newProject(), "Ajeno");
    refusal(await saveFlow(base, "Usa ajeno", [subflow("x", elsewhere)]), /no existe en este proyecto/);

    const l4 = await createdFlow(base, "L4");
    const l3 = await createdFlow(base, "L3", [subflow("s", l4)]);
    const l2 = await createdFlow(base, "L2", [subflow("s", l3)]);
    const l1 = await createdFlow(base, "L1", [subflow("s", l2)]);
    refusal(await saveFlow(base, "L0", [subflow("s", l1)]), /más de 3 niveles/);

    const inLoop = await saveFlow(base, "En bucle", [
      { id: "listar", kind: "fetch", fetch: { method: "GET", url: "/things" } },
      { id: "bucle", kind: "loop", dependsOn: ["listar"], loop: { from: "listar", path: "data", as: "cosa" } },
      subflow("s", a, { dependsOn: ["bucle"], inLoop: "bucle" }),
    ]);
    refusal(inLoop, /no puede ir dentro de un bucle/);

    // Borrar un flujo que otro ejecuta es 409, como el que usa una suite.
    const deleted = await api().delete(`${base}/workflows/${a}`).set(as(owner));
    assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
    await flow.target.stop();
  });

  test("si el hijo se archiva después de guardar, la corrida acaba en error en vez de ejecutarlo", async () => {
    const flow = await flowAgainst();
    const child = await createdFlow(flow.projectBase, "Hijo", [
      { id: "listar", kind: "fetch", fetch: { method: "GET", url: "/things", expectedStatus: 200 } },
    ]);
    const parent = await createdFlow(flow.projectBase, "Padre", [subflow("hijo", child)]);
    const archived = await api().put(`${flow.projectBase}/workflows/${child}`).set(as(owner)).send({ status: "archived" });
    assert.equal(archived.status, 204, JSON.stringify(archived.body));

    const run = await runAndWait(flow.projectBase, { environmentId: flow.environmentId, workflowId: parent });
    assert.equal(run.status, "error");
    await flow.target.stop();
  });
});
