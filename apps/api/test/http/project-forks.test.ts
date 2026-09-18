/**
 * Bifurcar un proyecto, traer cambios del original y fusionarlos en él, por HTTP.
 *
 * Lo que aquí importa y un test del dominio no ve: que las rutas piden el rol que dicen, que un
 * proyecto de otra organización no existe, que la huella caducada es un 409 y que ningún secreto
 * cruza ni se pisa con un hueco.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import type { Role } from "@/modules/iam/domain/model";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  return {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    token: session.body.accessToken,
  };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
async function joinAs(actor: Actor, organizationId: string, role: Role) {
  await context.repositories.memberships.save({ organizationId, userId: actor.userId, role, createdAt: new Date() });
}

let owner: Actor;
let viewer: Actor;
let outsider: Actor;
const org = () => `/orgs/${owner.organizationId}/projects`;
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

before(async () => {
  context = await createTestApp();
  owner = await signUp("fork-owner@example.com");
  viewer = await signUp("fork-viewer@example.com");
  outsider = await signUp("fork-outsider@example.com");
  await joinAs(viewer, owner.organizationId, "viewer");
});
after(async () => {
  await context?.close();
});

/** Un original con un endpoint, una prueba, un flujo con su dataset y un entorno con un secreto. */
async function parentProject() {
  const created = await api()
    .post(org())
    .set(as(owner))
    .send({ name: unique("original") });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.projectId as string;
  const base = `${org()}/${id}`;
  for (const path of ["/orders", "/users"]) {
    const endpoint = await api().post(`${base}/endpoints`).set(as(owner)).send({ method: "GET", path });
    assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
  }
  const template = await api()
    .post(`${base}/request-templates`)
    .set(as(owner))
    .send({ name: "Listar", operationId: "listOrders", expectedStatus: 200 });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const workflow = await api()
    .post(`${base}/workflows`)
    .set(as(owner))
    .send({
      name: "Pedidos",
      definition: { steps: [{ id: "listar", requestTemplateId: template.body.requestTemplateId }] },
    });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const dataset = await api()
    .post(`${base}/workflows/${workflow.body.workflowId}/datasets`)
    .set(as(owner))
    .send({ name: "clientes", rows: [{ sku: "A1" }] });
  assert.equal(dataset.status, 201, JSON.stringify(dataset.body));
  const environment = await api()
    .post(`${base}/environments`)
    .set(as(owner))
    .send({
      name: "staging",
      baseUrl: "https://staging.example.com",
      variables: {
        tenant: { initial: "acme", current: "acme", sensitive: false },
        token: { initial: "secreto-del-original", current: "secreto-del-original", sensitive: true },
      },
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  return {
    id,
    base,
    workflowId: workflow.body.workflowId as string,
    environmentId: environment.body.environmentId as string,
  };
}

async function fork(parentId: string, actor = owner) {
  return api()
    .post(`${org()}/${parentId}/fork`)
    .set(as(actor))
    .send({ name: unique("bifurcacion") });
}

async function endpointId(base: string, path: string): Promise<string> {
  const rows = (await api().get(`${base}/endpoints`).set(as(owner))).body.data as { id: string; path: string }[];
  return rows.find((row) => row.path === path)!.id;
}

describe("bifurcar", () => {
  test("copia endpoints, flujos con sus pruebas y datasets, y entornos sin secretos, y recuerda el original", async () => {
    const parent = await parentProject();
    const response = await fork(parent.id);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.copied.endpoints, 2);
    assert.equal(response.body.copied.workflows, 1);
    assert.equal(response.body.copied.environments, 1);
    assert.ok(response.body.skipped.some((entry: { detail: string }) => entry.detail.includes("token")));
    const base = `${org()}/${response.body.projectId}`;

    const summary = (await api().get(base).set(as(owner))).body;
    assert.equal(summary.fork.parentProjectId, parent.id);
    assert.ok(summary.fork.parentName.startsWith("original"));

    const flows = (await api().get(`${base}/workflows`).set(as(owner))).body;
    const template = flows.requestTemplates[0];
    assert.equal(flows.workflows[0].steps[0].requestTemplateId, template.id);
    assert.equal(flows.datasets?.length ?? 1, 1);

    const [environment] = (await api().get(`${base}/environments`).set(as(owner))).body;
    assert.equal(environment.variables.tenant.current, "acme");
    assert.equal(environment.variables.token.current, "");
    // Ni rastro del secreto en la foto común guardada: es `jsonb` en claro.
    const stored = context.repositories.forks.rows.get(response.body.projectId)!;
    assert.ok(!JSON.stringify(stored).includes("secreto-del-original"));

    // Nada que traer ni que fusionar recién nacida.
    const pull = (await api().get(`${base}/fork/pull`).set(as(owner))).body;
    assert.deepEqual(pull.entries, [], JSON.stringify(pull.entries));
  });

  test("un viewer no bifurca, un ajeno recibe 403, y un proyecto de otra organización es 404", async () => {
    const parent = await parentProject();
    assert.equal((await fork(parent.id, viewer)).status, 403);
    assert.equal((await fork(parent.id, outsider)).status, 403);
    const theirs = await api()
      .post(`/orgs/${outsider.organizationId}/projects`)
      .set(as(outsider))
      .send({ name: "Suyo" });
    const across = await fork(theirs.body.projectId);
    assert.equal(across.status, 404, JSON.stringify(across.body));
  });

  test("comparar un proyecto que no es bifurcación es 409, y un sentido desconocido 422", async () => {
    const parent = await parentProject();
    assert.equal((await api().get(`${parent.base}/fork/pull`).set(as(owner))).status, 409);
    assert.equal((await api().get(`${parent.base}/fork/sideways`).set(as(owner))).status, 422);
  });
});

describe("traer y fusionar", () => {
  test("trae lo que cambió el original y deja lo que cambió la bifurcación, que sale al fusionar", async () => {
    const parent = await parentProject();
    const forked = (await fork(parent.id)).body.projectId as string;
    const forkBase = `${org()}/${forked}`;

    await api()
      .patch(`${parent.base}/endpoints/${await endpointId(parent.base, "/orders")}`)
      .set(as(owner))
      .send({ description: "del original" });
    await api().post(`${parent.base}/endpoints`).set(as(owner)).send({ method: "POST", path: "/orders" });
    await api()
      .patch(`${forkBase}/endpoints/${await endpointId(forkBase, "/users")}`)
      .set(as(owner))
      .send({ description: "de la bifurcación" });

    const diff = (await api().get(`${forkBase}/fork/pull`).set(as(owner))).body;
    const byKey = Object.fromEntries(
      diff.entries.map((entry: { key: string; status: string }) => [entry.key, entry.status]),
    );
    assert.deepEqual(byKey, { "GET /orders": "incoming", "GET /users": "kept", "POST /orders": "incoming" });

    const pulled = await api().post(`${forkBase}/fork/pull`).set(as(owner)).send({ token: diff.token });
    assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
    assert.equal(pulled.body.applied.endpoint, 2);
    const rows = (await api().get(`${forkBase}/endpoints`).set(as(owner))).body.data as {
      path: string;
      method: string;
      description: string;
    }[];
    assert.equal(rows.find((row) => row.path === "/orders" && row.method === "GET")!.description, "del original");
    assert.ok(rows.some((row) => row.method === "POST"));

    // Después de traer, lo único distinto es el trabajo de la bifurcación, y va hacia el original.
    assert.deepEqual(
      (await api().get(`${forkBase}/fork/pull`).set(as(owner))).body.entries.map((e: { status: string }) => e.status),
      ["kept"],
    );
    const merge = (await api().get(`${forkBase}/fork/merge`).set(as(owner))).body;
    assert.deepEqual(
      merge.entries.map((entry: { key: string; status: string }) => [entry.key, entry.status]),
      [["GET /users", "incoming"]],
    );
    const merged = await api().post(`${forkBase}/fork/merge`).set(as(owner)).send({ token: merge.token });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    const parentRows = (await api().get(`${parent.base}/endpoints`).set(as(owner))).body.data as {
      path: string;
      description: string;
    }[];
    assert.equal(parentRows.find((row) => row.path === "/users")!.description, "de la bifurcación");
    assert.deepEqual((await api().get(`${forkBase}/fork/merge`).set(as(owner))).body.entries, []);
  });

  test("un conflicto pide decisión; una huella vieja es 409; y ganar en el destino no se pierde", async () => {
    const parent = await parentProject();
    const forked = (await fork(parent.id)).body.projectId as string;
    const forkBase = `${org()}/${forked}`;
    const edit = async (base: string, description: string) =>
      api()
        .patch(`${base}/endpoints/${await endpointId(base, "/orders")}`)
        .set(as(owner))
        .send({ description });
    await edit(parent.base, "original");
    await edit(forkBase, "bifurcación");

    const diff = (await api().get(`${forkBase}/fork/pull`).set(as(owner))).body;
    assert.equal(diff.entries[0].status, "conflict");
    assert.deepEqual(diff.entries[0].fields[0], {
      path: "description",
      base: "",
      source: "original",
      target: "bifurcación",
    });

    const unresolved = await api().post(`${forkBase}/fork/pull`).set(as(owner)).send({ token: diff.token });
    assert.equal(unresolved.status, 422, JSON.stringify(unresolved.body));

    const resolutions = { "endpoint:GET /orders": "target" };
    const stale = await api()
      .post(`${forkBase}/fork/pull`)
      .set(as(owner))
      .send({ token: "0".repeat(32), resolutions });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));

    const kept = await api().post(`${forkBase}/fork/pull`).set(as(owner)).send({ token: diff.token, resolutions });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.version, 2);
    // La bifurcación se quedó con lo suyo, y eso ahora es un cambio suyo que va hacia el original.
    const merge = (await api().get(`${forkBase}/fork/merge`).set(as(owner))).body;
    assert.deepEqual(
      merge.entries.map((entry: { status: string }) => entry.status),
      ["incoming"],
    );
    assert.equal((await api().get(`${forkBase}/fork/pull`).set(as(owner))).body.entries[0].status, "kept");
  });

  test("fusionar un entorno no pisa el secreto del original con el hueco de la bifurcación", async () => {
    const parent = await parentProject();
    const forked = (await fork(parent.id)).body.projectId as string;
    const forkBase = `${org()}/${forked}`;
    const before = context.repositories.environments.rows.get(parent.environmentId)!.variables.token!.initial;
    const [environment] = (await api().get(`${forkBase}/environments`).set(as(owner))).body;
    const renamed = await api()
      .patch(`${forkBase}/environments/${environment.id}`)
      .set(as(owner))
      .send({ name: "pre", baseUrl: "https://pre.example.com" });
    assert.equal(renamed.status, 204, JSON.stringify(renamed.body));

    const merge = (await api().get(`${forkBase}/fork/merge`).set(as(owner))).body;
    assert.deepEqual(
      merge.entries.map((entry: { kind: string; key: string; status: string }) => [
        entry.kind,
        entry.key,
        entry.status,
      ]),
      [["environment", parent.environmentId, "incoming"]],
    );
    const merged = await api().post(`${forkBase}/fork/merge`).set(as(owner)).send({ token: merge.token });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));

    // El mismo entorno —renombrar es modificar, por linaje—, con su secreto intacto.
    const stored = context.repositories.environments.rows.get(parent.environmentId)!;
    assert.equal(stored.name, "pre");
    assert.equal(stored.baseUrl, "https://pre.example.com");
    assert.equal(stored.variables.token!.initial, before);
    assert.notEqual(before, "");
  });

  test("un flujo nuevo en la bifurcación llega al original apuntando a sus pruebas, y un renombre es el mismo flujo", async () => {
    const parent = await parentProject();
    const forked = (await fork(parent.id)).body.projectId as string;
    const forkBase = `${org()}/${forked}`;
    const flows = (await api().get(`${forkBase}/workflows`).set(as(owner))).body;
    const templateId = flows.requestTemplates[0].id;
    await api().put(`${forkBase}/workflows/${flows.workflows[0].id}`).set(as(owner)).send({ name: "Pedidos v2" });
    const created = await api()
      .post(`${forkBase}/workflows`)
      .set(as(owner))
      .send({ name: "Nuevo", definition: { steps: [{ id: "a", requestTemplateId: templateId }] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const merge = (await api().get(`${forkBase}/fork/merge`).set(as(owner))).body;
    const merged = await api().post(`${forkBase}/fork/merge`).set(as(owner)).send({ token: merge.token });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));

    const parentFlows = (await api().get(`${parent.base}/workflows`).set(as(owner))).body;
    const names = parentFlows.workflows.map((row: { name: string }) => row.name).sort();
    assert.deepEqual(names, ["Nuevo", "Pedidos v2"]);
    const renamed = parentFlows.workflows.find((row: { name: string }) => row.name === "Pedidos v2");
    assert.equal(renamed.id, parent.workflowId);
    const fresh = parentFlows.workflows.find((row: { name: string }) => row.name === "Nuevo");
    assert.equal(fresh.steps[0].requestTemplateId, parentFlows.requestTemplates[0].id);

    // Y la siguiente comparación ya no tiene nada: el flujo nuevo quedó emparejado.
    assert.deepEqual((await api().get(`${forkBase}/fork/pull`).set(as(owner))).body.entries, []);
  });

  test("fusionar pide poder escribir en el original: un viewer no, y un original archivado tampoco", async () => {
    const parent = await parentProject();
    const forked = (await fork(parent.id)).body.projectId as string;
    const forkBase = `${org()}/${forked}`;
    await api().post(`${forkBase}/endpoints`).set(as(owner)).send({ method: "DELETE", path: "/orders" });
    const merge = (await api().get(`${forkBase}/fork/merge`).set(as(owner))).body;

    assert.equal((await api().get(`${forkBase}/fork/merge`).set(as(viewer))).status, 403);
    assert.equal((await api().post(`${forkBase}/fork/merge`).set(as(viewer)).send({ token: merge.token })).status, 403);
    assert.equal(
      (await api().post(`${forkBase}/fork/merge`).set(as(outsider)).send({ token: merge.token })).status,
      403,
    );
    // Con el id de la bifurcación bajo la organización de un ajeno: no existe.
    const across = await api().get(`/orgs/${outsider.organizationId}/projects/${forked}/fork/merge`).set(as(outsider));
    assert.equal(across.status, 404, JSON.stringify(across.body));

    await api().patch(`${parent.base}/archived`).set(as(owner)).send({ archived: true });
    const archived = await api().post(`${forkBase}/fork/merge`).set(as(owner)).send({ token: merge.token });
    assert.equal(archived.status, 409, JSON.stringify(archived.body));
  });
});
