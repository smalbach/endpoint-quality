/**
 * Importing chosen elements from one project into another: a preview, then a selective copy.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let sourceId: string;
let targetId: string;
const org = () => `/orgs/${owner.organizationId}`;

before(async () => {
  context = await createTestApp();
  owner = await signUp("import@example.com");
  const source = await api().post(`${org()}/projects`).set(as(owner)).send({ name: "Origen" });
  sourceId = source.body.projectId;
  const target = await api().post(`${org()}/projects`).set(as(owner)).send({ name: "Destino" });
  targetId = target.body.projectId;
  await api()
    .post(`${org()}/projects/${sourceId}/endpoints`)
    .set(as(owner))
    .send({ method: "GET", path: "/orders", requiresAuth: true });
  await api()
    .post(`${org()}/projects/${sourceId}/environments`)
    .set(as(owner))
    .send({ name: "staging", baseUrl: "https://s.example.com" });
});

after(async () => {
  await context?.close();
});

describe("importar de otro proyecto por elementos", () => {
  test("la vista previa lista lo que el origen ofrece, y se copia lo elegido", async () => {
    const preview = (
      await api().get(`${org()}/projects/${targetId}/import-preview?sourceProjectId=${sourceId}`).set(as(owner))
    ).body;
    assert.equal(preview.endpoints.length, 1);
    assert.equal(preview.environments.length, 1);
    const endpointId = preview.endpoints[0].id;
    const environmentId = preview.environments[0].id;

    const result = await api()
      .post(`${org()}/projects/${targetId}/import-elements`)
      .set(as(owner))
      .send({ sourceProjectId: sourceId, endpointIds: [endpointId], environmentIds: [environmentId] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.endpoints, 1);
    assert.equal(result.body.environments, 1);

    const endpoints = (await api().get(`${org()}/projects/${targetId}/endpoints`).set(as(owner))).body;
    assert.ok(
      endpoints.data.some((row: { method: string; path: string }) => row.method === "GET" && row.path === "/orders"),
    );
    const environments = (await api().get(`${org()}/projects/${targetId}/environments`).set(as(owner))).body;
    assert.ok(environments.some((row: { name: string }) => row.name === "staging"));

    // Importar lo mismo otra vez no duplica el endpoint (misma ruta).
    const again = await api()
      .post(`${org()}/projects/${targetId}/import-elements`)
      .set(as(owner))
      .send({ sourceProjectId: sourceId, endpointIds: [endpointId] });
    assert.equal(again.body.endpoints, 0);
    assert.equal(again.body.skipped.length, 1);
  });

  test("un flujo con un nodo canal trae su canal, y el nodo apunta a la copia", async () => {
    const base = `${org()}/projects/${sourceId}`;
    const created = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({ name: "eco", url: "wss://eco.example.test/socket" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const flow = await api()
      .post(`${base}/workflows`)
      .set(as(owner))
      .send({
        name: "con canal",
        definition: { steps: [{ id: "c", kind: "channel", channel: { channelId: created.body.id } }] },
      });
    assert.equal(flow.status, 201, JSON.stringify(flow.body));

    const result = await api()
      .post(`${org()}/projects/${targetId}/import-elements`)
      .set(as(owner))
      .send({ sourceProjectId: sourceId, workflowIds: [flow.body.workflowId] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.workflows, 1);
    assert.equal(result.body.channels, 1);

    const channels = (await api().get(`${org()}/projects/${targetId}/channels`).set(as(owner))).body.channels as {
      id: string;
      name: string;
    }[];
    const copy = channels.find((row) => row.name === "eco");
    assert.ok(copy, JSON.stringify(channels));
    assert.notEqual(copy.id, created.body.id);
    const flows = (await api().get(`${org()}/projects/${targetId}/workflows`).set(as(owner))).body.workflows as {
      name: string;
      steps: { channel?: { channelId: string } }[];
    }[];
    const imported = flows.find((row) => row.name === "con canal")!;
    assert.equal(imported.steps[0]!.channel!.channelId, copy.id);

    // Si el canal ya no está en el origen, el flujo no se copia y se dice por qué.
    assert.equal((await api().delete(`${base}/channels/${created.body.id}`).set(as(owner))).status, 204);
    const orphan = await api()
      .post(`${org()}/projects/${targetId}/import-elements`)
      .set(as(owner))
      .send({ sourceProjectId: sourceId, workflowIds: [flow.body.workflowId] });
    assert.equal(orphan.status, 201, JSON.stringify(orphan.body));
    assert.equal(orphan.body.workflows, 0);
    assert.match(JSON.stringify(orphan.body.skipped), /ya no existe en el origen/);
  });

  test("un flujo con sub-flujos trae los flujos que ejecuta, y cada nodo apunta a su copia", async () => {
    const base = `${org()}/projects/${sourceId}`;
    const save = async (name: string, steps: Record<string, unknown>[]) => {
      const created = await api().post(`${base}/workflows`).set(as(owner)).send({ name, definition: { steps } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.workflowId as string;
    };
    const nieto = await save("nieto", [{ id: "m", kind: "mock", mock: { status: 200 } }]);
    // Un webhook no lleva ids del proyecto: viaja tal cual.
    const hijo = await save("hijo", [
      { id: "espera", kind: "webhook", webhook: { timeoutMs: 5_000 } },
      { id: "n", kind: "subflow", subflow: { workflowId: nieto }, dependsOn: ["espera"] },
    ]);
    const padre = await save("padre", [{ id: "h", kind: "subflow", subflow: { workflowId: hijo } }]);

    const result = await api()
      .post(`${org()}/projects/${targetId}/import-elements`)
      .set(as(owner))
      .send({ sourceProjectId: sourceId, workflowIds: [padre] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.workflows, 3, "vienen el padre, el hijo y el nieto");

    type Flow = {
      id: string;
      name: string;
      steps: { id: string; subflow?: { workflowId: string }; webhook?: unknown }[];
    };
    const flows = (await api().get(`${org()}/projects/${targetId}/workflows`).set(as(owner))).body.workflows as Flow[];
    const byName = (name: string) => flows.find((row) => row.name === name)!;
    assert.equal(byName("padre").steps[0]!.subflow!.workflowId, byName("hijo").id);
    assert.equal(byName("hijo").steps[1]!.subflow!.workflowId, byName("nieto").id);
    assert.deepEqual(byName("hijo").steps[0]!.webhook, { timeoutMs: 5_000 });
    for (const flow of flows) {
      for (const step of flow.steps)
        assert.ok(![padre, hijo, nieto].includes(step.subflow?.workflowId ?? ""), "ningún nodo apunta al origen");
    }
    // Y lo copiado se puede volver a guardar: el destino lo reconoce como suyo.
    const resaved = await api()
      .put(`${org()}/projects/${targetId}/workflows/${byName("padre").id}`)
      .set(as(owner))
      .send({ name: "padre", definition: { steps: byName("padre").steps } });
    assert.equal(resaved.status, 204, JSON.stringify(resaved.body));

    // Un sub-flujo que ya no está en el origen deja fuera al flujo que lo usa, dicho.
    const row = await context.repositories.workflows.findWorkflow(sourceId, padre);
    await context.repositories.workflows.saveWorkflow({
      ...row!,
      definition: {
        steps: [{ id: "h", kind: "subflow", subflow: { workflowId: "00000000-0000-4000-8000-00000000dead" } }],
      },
    });
    const orphan = await api()
      .post(`${org()}/projects/${targetId}/import-elements`)
      .set(as(owner))
      .send({ sourceProjectId: sourceId, workflowIds: [padre] });
    assert.equal(orphan.status, 201, JSON.stringify(orphan.body));
    assert.equal(orphan.body.workflows, 0);
    assert.match(JSON.stringify(orphan.body.skipped), /ejecuta un flujo que no se ha podido traer/);
  });
});
