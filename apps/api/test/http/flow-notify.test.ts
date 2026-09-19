/**
 * The `notify` node against a real receiver.
 *
 * A local echo server stands in for Slack/Teams/a webhook: it records every body it gets and answers
 * 500 on `/roto`, so the test sees what actually crossed the wire through SAFE_FETCH and what the
 * run stored — which must never include the webhook URL.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let receiver: Server;
let hooks: string;
const received: { path: string; body: Record<string, unknown> }[] = [];

before(async () => {
  receiver = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      received.push({ path: incoming.url ?? "", body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      // A failing receiver echoes where it was reached, the way some error pages do: it must be redacted.
      if (incoming.url?.startsWith("/roto")) response.writeHead(500).end(`no aceptado en ${hooks}${incoming.url}`);
      else response.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  hooks = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  context = await createTestApp();
  const email = "notify-owner@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "notify" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  owner = { organizationId: registered.body.organizationId, token: session.body.accessToken };
});

after(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  // Y la propia aplicación: sin esto el proceso seguía vivo con sus sockets al acabar, y
  // `--test-force-exit` lo remataba antes de que volcara su cobertura.
  await context.close();
});

type RunCaseRow = { id: string; scenarioId: string; status: string; method: string; path: string; failure: string | null };

/** A project, its contract, one saved «crear» request capturing `thingId`, and an environment. */
async function fixture(variables: Record<string, unknown>) {
  const target = new StubTarget({});
  await target.start();
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `n-${Math.random().toString(36).slice(2, 8)}` });
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
    .send({ name: "stub", baseUrl: target.origin, specUrl: `${target.origin}/openapi.json`, writesAllowed: true, variables });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  const create = await api()
    .post(`${projectBase}/request-templates`)
    .set(as(owner))
    .send({ name: "Crear", operationId: "createThing", expectedStatus: 201, body: { type: "json", json: { name: "x", size: 7 } } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  return { target, projectBase, environmentId: environment.body.environmentId as string, createTemplateId: create.body.requestTemplateId as string };
}

async function runFlow(flow: Awaited<ReturnType<typeof fixture>>, steps: unknown[]) {
  const workflow = await api().post(`${flow.projectBase}/workflows`).set(as(owner)).send({ name: "Avisos", definition: { steps } });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const started = await api()
    .post(`${flow.projectBase}/runs`)
    .set(as(owner))
    .send({ environmentId: flow.environmentId, workflowId: workflow.body.workflowId });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await context.queue.idle();
  const run = (await api().get(`${flow.projectBase}/runs/${started.body.runId}`).set(as(owner))).body;
  const caseOf = (stepId: string): RunCaseRow => {
    const found = run.cases.find((item: RunCaseRow) => item.scenarioId.endsWith(`:${stepId}`));
    assert.ok(found, `sin caso para ${stepId}`);
    return found;
  };
  const detailOf = async (stepId: string) =>
    (await api().get(`${flow.projectBase}/runs/${run.id}/cases/${caseOf(stepId).id}`).set(as(owner))).body;
  return { run, workflowId: workflow.body.workflowId as string, caseOf, detailOf };
}

describe("nodo notificar", () => {
  test("envía la forma de cada canal con el mensaje resuelto, y la URL no se guarda en ningún sitio", async () => {
    const flow = await fixture({
      SLACK_HOOK: { initial: "", current: `${hooks}/slack/T0/B0/secreto`, sensitive: true },
      TEAMS_HOOK: `${hooks}/teams`,
      HOOK: `${hooks}/generico`,
    });
    received.length = 0;
    const { run, workflowId, caseOf, detailOf } = await runFlow(flow, [
      { id: "crear", requestTemplateId: flow.createTemplateId, captures: [{ variable: "thingId", from: "body", path: "data.id" }] },
      { id: "slack", kind: "notify", dependsOn: ["crear"], notify: { channel: "slack", urlVariable: "SLACK_HOOK", message: "pedido creado: {{thingId}}" } },
      { id: "teams", kind: "notify", dependsOn: ["slack"], notify: { channel: "teams", urlVariable: "TEAMS_HOOK", message: "hola {{thingId}}" } },
      { id: "hook", kind: "notify", dependsOn: ["teams"], notify: { channel: "webhook", urlVariable: "HOOK", message: "listo" } },
    ]);

    assert.equal(run.status, "passed", JSON.stringify(run.cases));
    assert.deepEqual(received.find((item) => item.path.startsWith("/slack"))?.body, { text: "pedido creado: 100" });
    assert.equal(received.find((item) => item.path === "/teams")?.body.text, "hola 100");
    assert.equal(received.find((item) => item.path === "/teams")?.body["@type"], "MessageCard");
    assert.deepEqual(received.find((item) => item.path === "/generico")?.body, { text: "listo", runId: run.id, workflowId, stepId: "hook" });

    assert.equal(caseOf("slack").method, "NOTIFY");
    assert.equal(caseOf("slack").path, "slack → SLACK_HOOK");
    const detail = await detailOf("slack");
    assert.equal(detail.steps[0].request.url, "{{SLACK_HOOK}}");
    assert.deepEqual(detail.steps[0].request.body, { text: "pedido creado: 100" });
    assert.match(detail.steps[0].assertions[0].detail, /slack respondió 200/);
    for (const stepId of ["slack", "teams", "hook"]) {
      assert.doesNotMatch(JSON.stringify(await detailOf(stepId)), new RegExp(hooks.replace(/[.:/]/g, "\\$&")));
    }
    assert.doesNotMatch(JSON.stringify(run), /secreto/);
    await flow.target.stop();
  });

  test("variable ausente o plantilla sin resolver: falla como config y no envía nada", async () => {
    const flow = await fixture({ HOOK: `${hooks}/generico` });
    received.length = 0;
    const { caseOf, detailOf } = await runFlow(flow, [
      { id: "sin-url", kind: "notify", notify: { channel: "slack", urlVariable: "NO_EXISTE", message: "hola" } },
      { id: "sin-var", kind: "notify", notify: { channel: "slack", urlVariable: "HOOK", message: "id {{nadie}}", onError: "continue" } },
    ]);
    assert.equal(caseOf("sin-url").status, "failed");
    assert.equal(caseOf("sin-url").failure, "config");
    assert.match((await detailOf("sin-url")).steps[0].assertions[0].detail, /«NO_EXISTE» no está definida/);
    assert.equal(caseOf("sin-var").status, "failed");
    assert.equal(caseOf("sin-var").failure, "config");
    assert.match((await detailOf("sin-var")).steps[0].assertions[0].detail, /Faltan variables: nadie/);
    assert.equal(received.length, 0);
    await flow.target.stop();
  });

  test("un envío fallido solo avisa por defecto, y falla con onError fail — sin filtrar la URL", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/muerto`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const flow = await fixture({ ROTO: `${hooks}/roto/abc`, MUERTO: deadUrl });
    const { caseOf, detailOf } = await runFlow(flow, [
      { id: "aviso", kind: "notify", notify: { channel: "webhook", urlVariable: "ROTO", message: "hola" } },
      { id: "estricto", kind: "notify", notify: { channel: "webhook", urlVariable: "ROTO", message: "hola", onError: "fail" } },
      { id: "sin-red", kind: "notify", notify: { channel: "slack", urlVariable: "MUERTO", message: "hola", onError: "fail" } },
    ]);

    assert.equal(caseOf("aviso").status, "passed");
    const warned = (await detailOf("aviso")).steps[0].assertions[0];
    assert.equal(warned.pass, false);
    assert.equal(warned.severity, "warning");
    assert.match(warned.detail, /respondió 500/);

    assert.equal(caseOf("estricto").status, "failed");
    assert.equal(caseOf("estricto").failure, "server");
    const strict = JSON.stringify(await detailOf("estricto"));
    assert.match(strict, /respondió 500: no aceptado en ••••••••/);
    assert.doesNotMatch(strict, /\/roto\/abc/);

    assert.equal(caseOf("sin-red").status, "failed");
    assert.equal(caseOf("sin-red").failure, "network");
    assert.doesNotMatch(JSON.stringify(await detailOf("sin-red")), /\/muerto/);
    await flow.target.stop();
  });
});
