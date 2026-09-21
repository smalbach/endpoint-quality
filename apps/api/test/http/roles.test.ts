/**
 * Roles through the API: the rows, their permission per endpoint, the rules between them, and the
 * `access` section the contract matrix keeps reading, derived from all of it.
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
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let outsider: Actor;
let projectId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;
let endpoints: { id: string; path: string; operationId: string | null }[] = [];
const endpointId = (path: string) => endpoints.find((endpoint) => endpoint.path === path)!.id;

async function accessSection() {
  const config = await api().get(`${base()}/config`).set(as(owner));
  assert.equal(config.status, 200);
  return config.body.sections.access.data.access as {
    roles: string[];
    rules: { operationId: string; allow: string[]; deny: string[] }[];
    crossRole: { source: string; target: string }[];
    deniedStatuses: number[];
  };
}

async function createRole(name: string, extra: Record<string, unknown> = {}) {
  const created = await api()
    .post(`${base()}/roles`)
    .set(as(owner))
    .send({ name, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body as { id: string; name: string; color: string; position: number };
}

before(async () => {
  context = await createTestApp();
  owner = await signUp("roles@example.com");
  outsider = await signUp("roles-ajeno@example.com");
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: "Tienda con roles", baseUrl: "http://127.0.0.1:9" });
  projectId = created.body.projectId;

  const spec = `
openapi: 3.1.0
info: { title: Tienda, version: "1.0.0" }
paths:
  /orders:
    get: { operationId: listOrders, responses: { "200": {} } }
  /orders/{orderId}:
    delete: { operationId: deleteOrder, responses: { "204": {} } }
`;
  const imported = await api()
    .post(`${base()}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: spec } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "GET", path: "/health" });
  for (let attempt = 0; attempt < 50 && endpoints.length < 3; attempt += 1) {
    endpoints = (await api().get(`${base()}/endpoints?status=all&limit=500`).set(as(owner))).body.data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(endpoints.length, 3);
});

after(async () => {
  await context?.close();
});

describe("roles", () => {
  test("crear les da el siguiente color de la paleta; el nombre sigue la regla de las credenciales", async () => {
    const seller = await createRole("vendedor", { description: "Vende" });
    const buyer = await createRole("comprador", { sameRoleDataIsolation: true });
    assert.equal(seller.color, "#6366f1");
    assert.equal(buyer.color, "#8b5cf6");
    assert.equal(buyer.position, 1);

    const duplicate = await api().post(`${base()}/roles`).set(as(owner)).send({ name: "vendedor" });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.type, /role-name-taken$/);
    const reserved = await api().post(`${base()}/roles`).set(as(owner)).send({ name: "primary" });
    assert.equal(reserved.status, 422);
    const spaced = await api().post(`${base()}/roles`).set(as(owner)).send({ name: "super admin" });
    assert.equal(spaced.status, 422);

    const list = await api().get(`${base()}/roles`).set(as(owner));
    assert.deepEqual(
      list.body.map((role: { name: string; sameRoleDataIsolation: boolean }) => [
        role.name,
        role.sameRoleDataIsolation,
      ]),
      [
        ["vendedor", false],
        ["comprador", true],
      ],
    );
    assert.deepEqual((await accessSection()).roles, ["vendedor", "comprador"]);
  });

  test("otra organización no ve los roles", async () => {
    const response = await api().get(`/orgs/${outsider.organizationId}/projects/${projectId}/roles`).set(as(outsider));
    assert.equal(response.status, 404);
  });
});

describe("permisos por endpoint", () => {
  test("guardar solo toca lo enviado; lo enlazado al contrato se deriva a la matriz", async () => {
    const [seller, buyer] = (await api().get(`${base()}/roles`).set(as(owner))).body as { id: string }[];

    const first = await api()
      .put(`${base()}/roles/${buyer.id}/permissions`)
      .set(as(owner))
      .send({
        permissions: [
          { endpointId: endpointId("/orders"), access: "allow", dataScope: "own" },
          { endpointId: endpointId("/orders/{orderId}"), access: "deny" },
          { endpointId: endpointId("/health"), access: "allow" },
        ],
      });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await api()
      .put(`${base()}/roles/${seller.id}/permissions`)
      .set(as(owner))
      .send({ permissions: [{ endpointId: endpointId("/orders"), access: "allow" }] });

    assert.deepEqual((await accessSection()).rules, [
      { operationId: "deleteOrder", allow: [], deny: ["comprador"] },
      { operationId: "listOrders", allow: ["vendedor", "comprador"], deny: [] },
    ]);

    // Only one cell sent: the others keep what they had.
    await api()
      .put(`${base()}/roles/${buyer.id}/permissions`)
      .set(as(owner))
      .send({ permissions: [{ endpointId: endpointId("/orders"), access: "undecided" }] });
    const stored = await api().get(`${base()}/roles/${buyer.id}/permissions`).set(as(owner));
    assert.deepEqual(
      stored.body.permissions
        .map((cell: { endpointId: string; access: string }) => [
          endpoints.find((e) => e.id === cell.endpointId)!.path,
          cell.access,
        ])
        .sort(),
      [
        ["/health", "allow"],
        ["/orders/{orderId}", "deny"],
      ],
    );

    const counts = (await api().get(`${base()}/roles`).set(as(owner))).body as { allowed: number; denied: number }[];
    assert.deepEqual([counts[1].allowed, counts[1].denied], [1, 1]);
  });

  test("un endpoint de otro proyecto o repetido es 422 con el campo", async () => {
    const [seller] = (await api().get(`${base()}/roles`).set(as(owner))).body as { id: string }[];
    const response = await api()
      .put(`${base()}/roles/${seller.id}/permissions`)
      .set(as(owner))
      .send({
        permissions: [
          { endpointId: "00000000-0000-4000-8000-000000000000", access: "allow" },
          { endpointId: endpointId("/health"), access: "allow" },
          { endpointId: endpointId("/health"), access: "deny" },
        ],
      });
    assert.equal(response.status, 422);
    assert.deepEqual(
      response.body.errors.map((error: { field: string }) => error.field),
      ["permissions.0.endpointId", "permissions.2.endpointId"],
    );
  });

  test("desde el endpoint: todos los roles, con lo no decidido dicho como tal", async () => {
    const id = endpointId("/orders/{orderId}");
    const before = await api().get(`${base()}/endpoints/${id}/role-access`).set(as(owner));
    assert.deepEqual(
      before.body.roles.map((role: { name: string; access: string }) => [role.name, role.access]),
      [
        ["vendedor", "undecided"],
        ["comprador", "deny"],
      ],
    );
    const sellerId = before.body.roles[0].roleId;
    const saved = await api()
      .put(`${base()}/endpoints/${id}/role-access`)
      .set(as(owner))
      .send({ permissions: [{ roleId: sellerId, access: "allow", dataScope: "all" }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(
      (await accessSection()).rules.find((rule) => rule.operationId === "deleteOrder"),
      { operationId: "deleteOrder", allow: ["vendedor"], deny: ["comprador"] },
    );
  });
});

describe("reglas entre roles", () => {
  test("se guardan enteras, sin filas vacías y sin un rol sobre sí mismo", async () => {
    const [seller, buyer] = (await api().get(`${base()}/roles`).set(as(owner))).body as { id: string }[];
    const self = await api()
      .put(`${base()}/role-rules`)
      .set(as(owner))
      .send({
        rules: [{ sourceRoleId: seller.id, targetRoleId: seller.id, canRead: true, canWrite: false, canDelete: false }],
      });
    assert.equal(self.status, 422);

    const saved = await api()
      .put(`${base()}/role-rules`)
      .set(as(owner))
      .send({
        rules: [
          { sourceRoleId: seller.id, targetRoleId: buyer.id, canRead: true, canWrite: false, canDelete: false },
          { sourceRoleId: buyer.id, targetRoleId: seller.id, canRead: false, canWrite: false, canDelete: false },
        ],
      });
    assert.deepEqual(saved.body, { stored: 1 });
    const rules = await api().get(`${base()}/role-rules`).set(as(owner));
    assert.deepEqual(rules.body.rules, [
      { sourceRoleId: seller.id, targetRoleId: buyer.id, canRead: true, canWrite: false, canDelete: false },
    ]);
  });
});

describe("renombrar y borrar", () => {
  test("renombrar arrastra sus credenciales y la matriz; borrar se lleva credenciales, permisos y reglas", async () => {
    const [seller, buyer] = (await api().get(`${base()}/roles`).set(as(owner))).body as { id: string }[];
    const environment = await api()
      .post(`${base()}/environments`)
      .set(as(owner))
      .send({ name: "local", baseUrl: "http://127.0.0.1:9" });
    const environmentId = environment.body.environmentId;
    const credential = await api()
      .put(`${base()}/environments/${environmentId}/credentials`)
      .set(as(owner))
      .send({ name: "vendedor", role: "vendedor", kind: "bearer", secret: "tok-vendedor" });
    assert.equal(credential.status, 200, JSON.stringify(credential.body));

    const renamed = await api()
      .patch(`${base()}/roles/${seller.id}`)
      .set(as(owner))
      .send({ name: "seller", description: "" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.description, "");
    const credentials = async () =>
      ((await api().get(`${base()}/environments`).set(as(owner))).body[0].credentials as { role: string }[]).map(
        (entry) => entry.role,
      );
    assert.deepEqual(await credentials(), ["seller"]);
    const access = await accessSection();
    assert.deepEqual(access.roles, ["seller", "comprador"]);
    assert.ok(access.rules.some((rule) => rule.allow.includes("seller")));

    const removed = await api().delete(`${base()}/roles/${seller.id}`).set(as(owner));
    assert.equal(removed.status, 204);
    // Blando: sale de la matriz y de las reglas, y **sus credenciales se quedan**. Llevárselas
    // haría que restaurarlo devolviera un rol que no puede autenticarse contra nada.
    assert.deepEqual(await credentials(), ["seller"]);
    assert.deepEqual((await accessSection()).roles, ["comprador"]);
    assert.deepEqual((await api().get(`${base()}/role-rules`).set(as(owner))).body.rules, []);
    assert.deepEqual(
      ((await api().get(`${base()}/roles`).set(as(owner))).body as { id: string }[]).map((role) => role.id),
      [buyer.id],
    );
    const trash = await api().get(`${base()}/roles?state=deleted`).set(as(owner));
    assert.deepEqual(
      (trash.body as { id: string }[]).map((role) => role.id),
      [seller.id],
    );

    // Restaurarlo devuelve la matriz que se decidió con él: sus celdas y sus reglas siguen ahí.
    const back = await api().post(`${base()}/roles/${seller.id}/restore`).set(as(owner));
    assert.equal(back.status, 204);
    assert.deepEqual((await accessSection()).roles, ["seller", "comprador"]);
    assert.ok((await api().get(`${base()}/role-rules`).set(as(owner))).body.rules.length > 0);

    // El definitivo pide que antes esté eliminado, y ese sí se lleva las credenciales.
    assert.equal((await api().delete(`${base()}/roles/${seller.id}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base()}/roles/${seller.id}`).set(as(owner));
    assert.equal((await api().delete(`${base()}/roles/${seller.id}?purge=true`).set(as(owner))).status, 204);
    assert.deepEqual(await credentials(), []);
    assert.equal((await api().get(`${base()}/roles/${seller.id}/permissions`).set(as(owner))).status, 404);
    assert.ok(buyer.id);
  });
});
