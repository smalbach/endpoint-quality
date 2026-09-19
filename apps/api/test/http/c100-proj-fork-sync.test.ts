/**
 * Traer del original a una bifurcación, en los casos que las otras pruebas de bifurcaciones no
 * pisan: una cabecera con valor que viaja tal cual, una petición nueva, un paso que apunta a una
 * petición que no existe, un rol renombrado, un rol que se borra con la bifurcación sin sección
 * `access`, una regla hacia un rol que no existe y una sección `access` que no valida.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

let token: string;
let organizationId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
const org = () => `/orgs/${organizationId}/projects`;
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

before(async () => {
  context = await createTestApp();
  const email = "c100-proj-fork@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  organizationId = registered.body.organizationId;
  token = (await api().post("/auth/login").send({ email, password })).body.accessToken;
});
after(async () => {
  await context?.close();
});

async function ok(response: request.Response | Promise<request.Response>): Promise<request.Response> {
  const settled = await response;
  assert.ok(settled.status < 300, `${settled.status} ${JSON.stringify(settled.body)}`);
  return settled;
}
async function newProject(): Promise<{ id: string; base: string }> {
  const created = await ok(api().post(org()).set(auth()).send({ name: unique("original") }));
  return { id: created.body.projectId, base: `${org()}/${created.body.projectId}` };
}
async function forkOf(parentId: string): Promise<{ id: string; base: string }> {
  const forked = await ok(api().post(`${org()}/${parentId}/fork`).set(auth()).send({ name: unique("bif") }));
  return { id: forked.body.projectId, base: `${org()}/${forked.body.projectId}` };
}
type Skip = { what: string; detail: string };
async function pull(base: string, pick: "source" | "target" = "source") {
  const diff = await ok(api().get(`${base}/fork/pull`).set(auth()));
  const resolutions = Object.fromEntries(
    (diff.body.entries as { kind: string; key: string; status: string }[])
      .filter((entry) => entry.status === "conflict")
      .map((entry) => [`${entry.kind}:${entry.key}`, pick]),
  );
  const applied = await ok(api().post(`${base}/fork/pull`).set(auth()).send({ token: diff.body.token, resolutions }));
  return applied.body as { applied: Record<string, number>; skipped: Skip[] };
}
async function accessOf(projectId: string) {
  return (await context.repositories.config.findSection(projectId, "access"))?.data as
    | { access: { roles: string[]; crossRole: { source: string; target: string }[] } }
    | undefined;
}

describe("canales y peticiones", () => {
  test("una cabecera con valor viaja tal cual y una petición nueva llega con la fecha de ahora", async () => {
    const parent = await newProject();
    const channel = await ok(
      api()
        .post(`${parent.base}/channels`)
        .set(auth())
        .send({ name: "eco", url: "wss://eco.example.com", headers: [{ name: "Accept", value: "application/json", enabled: true }] }),
    );
    const fork = await forkOf(parent.id);

    await ok(api().patch(`${parent.base}/channels/${channel.body.id}`).set(auth()).send({ name: "eco-2" }));
    await ok(
      api().post(`${parent.base}/request-templates`).set(auth()).send({ name: "Nueva", operationId: "x", expectedStatus: 200 }),
    );
    await pull(fork.base);

    const [copied] = await context.repositories.channels.listByProject(fork.id);
    assert.equal(copied!.name, "eco-2");
    assert.deepEqual(
      copied!.headers.map((header) => [header.name, header.value]),
      [["Accept", "application/json"]],
    );
    const [template] = await context.repositories.workflows.listTemplates(fork.id);
    assert.equal(template!.name, "Nueva");
    assert.equal(template!.createdAt.getTime(), context.clock.now().getTime());
  });

  test("un paso que apunta a una petición que no existe en el original llega apuntando a lo mismo", async () => {
    const parent = await newProject();
    const fork = await forkOf(parent.id);
    await context.repositories.workflows.saveWorkflow({
      id: "c100-flujo-colgado",
      projectId: parent.id,
      name: "Colgado",
      description: null,
      status: "draft",
      definition: { steps: [{ id: "a", requestTemplateId: "peticion-fantasma" }] },
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: "u",
    } as never);
    await pull(fork.base);
    const [flow] = await context.repositories.workflows.listWorkflows(fork.id);
    assert.equal(flow!.name, "Colgado");
    assert.equal(flow!.definition.steps[0]!.requestTemplateId, "peticion-fantasma");
  });
});

describe("roles", () => {
  test("un rol renombrado en el original se renombra también en la sección access de la bifurcación", async () => {
    const parent = await newProject();
    const admin = await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "admin" }));
    await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "lector" }));
    const fork = await forkOf(parent.id);

    await ok(api().patch(`${parent.base}/roles/${admin.body.id}`).set(auth()).send({ name: "jefe" }));
    await pull(fork.base);
    assert.deepEqual((await context.repositories.roles.list(fork.id)).map((role) => role.name), ["jefe", "lector"]);
    assert.deepEqual((await accessOf(fork.id))!.access.roles, ["jefe", "lector"]);
  });

  test("sin sección access y sin roles que queden, no se escribe una", async () => {
    const parent = await newProject();
    const solo = await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "solo" }));
    const fork = await forkOf(parent.id);
    await context.repositories.config.deleteSection(fork.id, "access");

    await ok(api().delete(`${parent.base}/roles/${solo.body.id}`).set(auth()));
    await pull(fork.base);
    assert.deepEqual(await context.repositories.roles.list(fork.id), []);
    assert.equal(await accessOf(fork.id), undefined);
  });

  test("una regla del original hacia un rol que no existe se cae y se dice", async () => {
    const parent = await newProject();
    const admin = await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "admin" }));
    const fork = await forkOf(parent.id);

    await context.repositories.roles.replaceRules(parent.id, [
      { projectId: parent.id, sourceRoleId: admin.body.id, targetRoleId: "rol-fantasma", canRead: true, canWrite: false, canDelete: false },
    ]);
    await ok(api().patch(`${parent.base}/roles/${admin.body.id}`).set(auth()).send({ color: "#10b981" }));
    const result = await pull(fork.base);
    assert.ok(
      result.skipped.some((entry) => entry.detail === "admin: una regla hacia un rol que el destino no tiene"),
      JSON.stringify(result.skipped),
    );
    assert.deepEqual(await context.repositories.roles.listRules(fork.id), []);
  });

  test("una regla de la bifurcación hacia un rol que el original borra se va con él", async () => {
    const parent = await newProject();
    await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "admin" }));
    const lector = await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "lector" }));
    const fork = await forkOf(parent.id);
    const forkRoles = await context.repositories.roles.list(fork.id);
    const [forkAdmin, forkLector] = [forkRoles.find((row) => row.name === "admin")!, forkRoles.find((row) => row.name === "lector")!];
    await context.repositories.roles.replaceRules(fork.id, [
      { projectId: fork.id, sourceRoleId: forkAdmin.id, targetRoleId: forkLector.id, canRead: true, canWrite: false, canDelete: false },
    ]);

    await ok(api().delete(`${parent.base}/roles/${lector.body.id}`).set(auth()));
    await pull(fork.base);
    assert.deepEqual((await context.repositories.roles.list(fork.id)).map((role) => role.name), ["admin"]);
    assert.deepEqual(await context.repositories.roles.listRules(fork.id), []);
  });

  test("una sección access que no valida no se reescribe y se dice que hay que revisarla", async () => {
    const parent = await newProject();
    const admin = await ok(api().post(`${parent.base}/roles`).set(auth()).send({ name: "admin" }));
    const fork = await forkOf(parent.id);
    const invalid = { access: { roles: ["admin"], deniedStatuses: [200], rules: [], crossRole: [] } };
    await context.repositories.config.saveSection({
      projectId: fork.id,
      section: "access",
      data: invalid,
      updatedAt: new Date(),
      updatedBy: "u",
    });

    await ok(api().patch(`${parent.base}/roles/${admin.body.id}`).set(auth()).send({ color: "#10b981" }));
    const result = await pull(fork.base);
    assert.ok(
      result.skipped.some((entry) => entry.detail === "access: no se pudo derivar de los roles; revísala en Roles"),
      JSON.stringify(result.skipped),
    );
    assert.deepEqual(await accessOf(fork.id), invalid);
  });
});
