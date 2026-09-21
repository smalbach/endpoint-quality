/**
 * Proyectos, roles e identidad por la API, en los bordes que el resto de pruebas no pisa: un token
 * de servicio que importa un contrato o crea un rol, una organización nueva, un cambio de rol que sí
 * se guarda, la cookie con dominio, y los datos que se quedaron colgando —un entorno activo o un
 * contrato que ya no están, un permiso sobre un endpoint borrado, una regla hacia un rol que no
 * existe— al bifurcar, exportar, listar o importar.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

const PASSWORD = "Una-contraseña-larga-1";
type Actor = { organizationId: string; userId: string; token: string };
let owner: Actor;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const org = () => `/orgs/${owner.organizationId}/projects`;
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

const OPENAPI = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Pedidos", version: "1.0.0" },
  paths: { "/orders": { get: { operationId: "listOrders", responses: { "200": { description: "ok" } } } } },
});

async function signUp(email: string): Promise<Actor> {
  const registered = await api().post("/auth/register").send({ email, password: PASSWORD, name: "x" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const session = await api().post("/auth/login").send({ email, password: PASSWORD });
  return { organizationId: registered.body.organizationId, userId: registered.body.userId, token: session.body.accessToken };
}
async function ok(response: request.Response | Promise<request.Response>): Promise<request.Response> {
  const settled = await response;
  assert.ok(settled.status < 300, `${settled.status} ${JSON.stringify(settled.body)}`);
  return settled;
}
function problem(response: request.Response, status: number, type: string) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.type, `https://endpoint-quality.dev/problems/${type}`);
}
async function newProject(body: Record<string, unknown> = {}): Promise<{ id: string; base: string }> {
  const created = await ok(api().post(org()).set(as(owner.token)).send({ name: unique("p"), ...body }));
  return { id: created.body.projectId, base: `${org()}/${created.body.projectId}` };
}
async function serviceToken(): Promise<{ id: string; token: string }> {
  const issued = await ok(api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner.token)).send({ name: unique("ci") }));
  return { id: issued.body.id, token: issued.body.token };
}

before(async () => {
  context = await createTestApp();
  owner = await signUp("c100-proj@example.com");
});
after(async () => {
  await context?.close();
});

describe("un token de servicio actúa con su propio id", () => {
  test("importa un contrato y crea un rol, y los dos quedan firmados por el token", async () => {
    const project = await newProject();
    const ci = await serviceToken();
    const imported = await ok(
      api().post(`${project.base}/spec-versions`).set(as(ci.token)).send({ source: { kind: "inline", raw: OPENAPI } }),
    );
    assert.equal((await context.repositories.specs.findVersionById(imported.body.specVersionId))!.importedBy, ci.id);

    await ok(api().post(`${project.base}/roles`).set(as(ci.token)).send({ name: "lector" }));
    const access = await context.repositories.config.findSection(project.id, "access");
    assert.equal(access!.updatedBy, ci.id);
  });
});

describe("organizaciones y miembros", () => {
  test("una persona crea una organización y queda de propietaria; un token no puede", async () => {
    const created = await ok(api().post("/orgs").set(as(owner.token)).send({ name: "Segunda" }));
    const membership = await context.repositories.memberships.find(created.body.organizationId, owner.userId);
    assert.equal(membership?.role, "owner");

    const ci = await serviceToken();
    problem(await api().post("/orgs").set(as(ci.token)).send({ name: "Del token" }), 401, "user-session-required");
  });

  test("el propietario cambia el rol de un miembro invitado", async () => {
    const invited = await ok(
      api().post(`/orgs/${owner.organizationId}/invitations`).set(as(owner.token)).send({ email: "c100-miembro@example.com", role: "editor" }),
    );
    const member = await signUp("c100-miembro@example.com");
    await ok(api().post("/invitations/accept").set(as(member.token)).send({ token: invited.body.token }));

    const changed = await api()
      .patch(`/orgs/${owner.organizationId}/members/${member.userId}`)
      .set(as(owner.token))
      .send({ role: "viewer" });
    assert.equal(changed.status, 204, JSON.stringify(changed.body));
    assert.equal((await context.repositories.memberships.find(owner.organizationId, member.userId))?.role, "viewer");
  });
});

describe("la cookie de sesión con COOKIE_DOMAIN", () => {
  test("lleva el dominio configurado", async () => {
    const other = await createTestApp({ env: { COOKIE_DOMAIN: "eq.example.com" } });
    try {
      const email = "c100-cookie@example.com";
      await request(other.app.getHttpServer()).post("/auth/register").send({ email, password: PASSWORD, name: "x" });
      const login = await request(other.app.getHttpServer()).post("/auth/login").send({ email, password: PASSWORD });
      assert.equal(login.status, 200);
      const cookie = ([] as string[]).concat(login.headers["set-cookie"] ?? []).join("; ");
      assert.match(cookie, /Domain=eq\.example\.com/i);
    } finally {
      await other.close();
    }
  });
});

describe("roles", () => {
  test("el acceso por rol de un endpoint que no existe es un 404", async () => {
    const project = await newProject();
    problem(
      await api().get(`${project.base}/endpoints/00000000-0000-4000-8000-000000000000/role-access`).set(as(owner.token)),
      404,
      "endpoint-not-found",
    );
  });
});

describe("la lista de proyectos", () => {
  test("la última corrida se resume; un original de otra organización no se nombra", async () => {
    const parent = await newProject();
    const forked = await ok(api().post(`${parent.base}/fork`).set(as(owner.token)).send({ name: unique("bif") }));
    const forkId = forked.body.projectId as string;
    await context.repositories.runs.save({
      id: "c100-run",
      projectId: forkId,
      environmentId: null,
      specVersionId: null,
      status: "passed",
      plan: { cases: [] },
      totals: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
      triggeredByKind: "user",
      triggeredBy: owner.userId,
      startedAt: new Date("2026-03-01T09:00:00.000Z"),
      finishedAt: new Date("2026-03-01T09:01:00.000Z"),
      error: null,
    } as never);
    const stored = (await context.repositories.projects.findById(parent.id))!;
    await context.repositories.projects.save({ ...stored, organizationId: "otra-organizacion" });

    const list = await ok(api().get(org()).set(as(owner.token)));
    const rows = (Array.isArray(list.body) ? list.body : list.body.data) as {
      id: string;
      lastRun: { id: string; status: string } | null;
      fork: { parentProjectId: string; parentName: string | null } | null;
    }[];
    const row = rows.find((entry) => entry.id === forkId)!;
    assert.deepEqual([row.lastRun?.id, row.lastRun?.status], ["c100-run", "passed"]);
    assert.deepEqual(row.fork && [row.fork.parentProjectId, row.fork.parentName], [parent.id, null]);
  });
});

describe("bifurcar con datos colgando", () => {
  test("un entorno activo y un contrato que ya no están, y un dataset de un flujo que no existe, no se copian", async () => {
    const parent = await newProject();
    const template = await ok(
      api().post(`${parent.base}/request-templates`).set(as(owner.token)).send({ name: "Listar", operationId: "x", expectedStatus: 200 }),
    );
    await ok(
      api()
        .post(`${parent.base}/workflows`)
        .set(as(owner.token))
        .send({ name: "Pedidos", definition: { steps: [{ id: "a", requestTemplateId: template.body.requestTemplateId }] } }),
    );
    const stored = (await context.repositories.projects.findById(parent.id))!;
    await context.repositories.projects.save({ ...stored, activeEnvironmentId: "entorno-borrado", activeSpecVersionId: "version-borrada" });
    await context.repositories.workflows.saveDataset({
      id: "dataset-huerfano",
      projectId: parent.id,
      workflowId: "flujo-borrado",
      name: "filas",
      rows: [{ sku: "A" }],
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: owner.userId,
      archivedAt: null,
      deletedAt: null,
    });

    const forked = await ok(api().post(`${parent.base}/fork`).set(as(owner.token)).send({ name: unique("bif") }));
    const fork = (await context.repositories.projects.findById(forked.body.projectId))!;
    assert.equal(fork.activeEnvironmentId, null);
    assert.equal(fork.activeSpecVersionId, null);
    assert.equal((await context.repositories.workflows.listWorkflows(fork.id)).length, 1);
    assert.deepEqual(await context.repositories.workflows.listDatasets(fork.id), []);
  });
});

describe("importar elementos de otro proyecto", () => {
  test("de las peticiones del origen solo viajan las que usan los flujos elegidos", async () => {
    const source = await newProject();
    const target = await newProject();
    const used = await ok(
      api().post(`${source.base}/request-templates`).set(as(owner.token)).send({ name: "Usada", operationId: "x", expectedStatus: 200 }),
    );
    await ok(
      api().post(`${source.base}/request-templates`).set(as(owner.token)).send({ name: "Suelta", operationId: "y", expectedStatus: 200 }),
    );
    const flow = await ok(
      api()
        .post(`${source.base}/workflows`)
        .set(as(owner.token))
        .send({ name: "Flujo", definition: { steps: [{ id: "a", requestTemplateId: used.body.requestTemplateId }] } }),
    );
    await ok(
      api()
        .post(`${target.base}/import-elements`)
        .set(as(owner.token))
        .send({ sourceProjectId: source.id, workflowIds: [flow.body.workflowId] }),
    );
    const templates = await context.repositories.workflows.listTemplates(target.id);
    assert.deepEqual(templates.map((row) => row.name), ["Usada"]);
  });

  test("un paso que apunta a una petición que el origen ya no tiene llega apuntando a lo mismo", async () => {
    const source = await newProject();
    const target = await newProject();
    await context.repositories.workflows.saveWorkflow({
      id: "0b7c2d1e-1111-4a2b-8c3d-4e5f6a7b8c9d",
      projectId: source.id,
      name: "Colgado",
      description: null,
      status: "draft",
      definition: { steps: [{ id: "a", requestTemplateId: "peticion-fantasma" }] },
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: owner.userId,
    } as never);
    await ok(
      api()
        .post(`${target.base}/import-elements`)
        .set(as(owner.token))
        .send({ sourceProjectId: source.id, workflowIds: ["0b7c2d1e-1111-4a2b-8c3d-4e5f6a7b8c9d"] }),
    );
    const [flow] = await context.repositories.workflows.listWorkflows(target.id);
    assert.equal(flow!.name, "Colgado");
    assert.equal(flow!.definition.steps[0]!.requestTemplateId, "peticion-fantasma");
    assert.deepEqual(await context.repositories.workflows.listTemplates(target.id), []);
  });
});

describe("importar un fichero de proyecto", () => {
  test("solo reglas entre roles: se aplican sobre los roles que el proyecto ya tiene", async () => {
    const project = await newProject();
    const admin = await ok(api().post(`${project.base}/roles`).set(as(owner.token)).send({ name: "admin" }));
    const lector = await ok(api().post(`${project.base}/roles`).set(as(owner.token)).send({ name: "lector" }));
    const imported = await ok(
      api()
        .post(`${project.base}/import-bundle`)
        .set(as(owner.token))
        .send({
          bundle: {
            format: "endpoint-quality/project",
            version: 1,
            roleRules: [{ source: "admin", target: "lector", canRead: true, canWrite: false, canDelete: false }],
          },
        }),
    );
    assert.equal(imported.body.roles, 0);
    assert.deepEqual(
      (await context.repositories.roles.listRules(project.id)).map((rule) => [rule.sourceRoleId, rule.targetRoleId, rule.canRead]),
      [[admin.body.id, lector.body.id, true]],
    );
  });
});

describe("importar cualquier cosa", () => {
  test("una colección con un campo de fichero avisa de que hay que elegirlo", async () => {
    const project = await newProject();
    const collection = {
      info: { name: "Subidas", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        {
          name: "Subir",
          request: {
            method: "POST",
            url: "https://api.example.com/upload",
            body: { mode: "formdata", formdata: [{ key: "doc", type: "file", src: "a.pdf" }] },
          },
        },
      ],
    };
    const imported = await ok(
      api()
        .post(`${project.base}/import`)
        .set(as(owner.token))
        .send({ sources: [{ name: "subidas.json", text: JSON.stringify(collection) }] }),
    );
    const endpoints = (imported.body.items[0].results as { target: string; notes?: string[] }[]).find(
      (entry) => entry.target === "endpoints",
    )!;
    assert.deepEqual(endpoints.notes, ["POST /upload: el campo «doc» es un fichero — hay que elegir el fichero"]);
  });
});

describe("exportar con datos colgando", () => {
  test("un permiso sobre un endpoint borrado y una regla hacia un rol que no existe no salen; una petición sin operación sale sin método", async () => {
    const project = await newProject();
    await ok(api().post(`${project.base}/spec-versions`).set(as(owner.token)).send({ source: { kind: "inline", raw: OPENAPI } }));
    const endpoint = await ok(api().post(`${project.base}/endpoints`).set(as(owner.token)).send({ method: "GET", path: "/borrado" }));
    const endpointId = (endpoint.body.id ?? endpoint.body.endpointId) as string;
    const role = await ok(api().post(`${project.base}/roles`).set(as(owner.token)).send({ name: "lector" }));
    await ok(
      api()
        .put(`${project.base}/roles/${role.body.id}/permissions`)
        .set(as(owner.token))
        .send({ permissions: [{ endpointId, access: "allow" }] }),
    );
    await ok(api().delete(`${project.base}/endpoints/${endpointId}`).set(as(owner.token)));
    await context.repositories.roles.replaceRules(project.id, [
      { projectId: project.id, sourceRoleId: role.body.id, targetRoleId: "rol-fantasma", canRead: true, canWrite: false, canDelete: false },
    ]);
    await ok(
      api().post(`${project.base}/request-templates`).set(as(owner.token)).send({ name: "Suelta", operationId: "noEsta", expectedStatus: 200 }),
    );

    const exported = await ok(api().get(`${project.base}/export?parts=roles,flows`).set(as(owner.token)));
    const bundle = exported.body as {
      roles: { name: string; permissions: unknown[] }[];
      roleRules: unknown[];
      flows: { requestTemplates: Record<string, unknown>[] };
    };
    assert.deepEqual(bundle.roles.map((row) => [row.name, row.permissions]), [["lector", []]]);
    assert.deepEqual(bundle.roleRules, []);
    const [template] = bundle.flows.requestTemplates;
    assert.equal(template!.operationId, "noEsta");
    assert.equal("method" in template!, false);
    assert.equal("path" in template!, false);
  });
});
