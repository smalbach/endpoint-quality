/**
 * Editar, archivar y leer un proyecto, y las solicitudes de fusión en sus bordes: un comentario en
 * blanco, una solicitud sin descripción, un original o una bifurcación que desaparecen, y quién
 * firma cuando el autor ya no existe.
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
  const email = "proj-cov-admin@example.com";
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
async function newProject(body: Record<string, unknown> = {}): Promise<{ id: string; base: string }> {
  const created = await ok(api().post(org()).set(auth()).send({ name: unique("p"), ...body }));
  return { id: created.body.projectId, base: `${org()}/${created.body.projectId}` };
}

describe("editar y archivar", () => {
  test("un proyecto archivado no se edita; al desarchivarlo, sí", async () => {
    const project = await newProject({ description: "antes", baseUrl: "https://a.test", tags: ["x"] });
    await ok(api().patch(`${project.base}/archived`).set(auth()).send({ archived: true }));
    const refused = await api().patch(project.base).set(auth()).send({ name: "Nuevo" });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(String(refused.body.type), /project-archived$/);

    await ok(api().patch(`${project.base}/archived`).set(auth()).send({ archived: false }));
    assert.equal((await context.repositories.projects.findById(project.id))!.archivedAt, null);

    // Solo el nombre: lo demás se queda como estaba.
    await ok(api().patch(project.base).set(auth()).send({ name: "  Nuevo  " }));
    const renamed = (await context.repositories.projects.findById(project.id))!;
    assert.deepEqual([renamed.name, renamed.description, renamed.baseUrl, renamed.tags], ["Nuevo", "antes", "https://a.test", ["x"]]);

    // Un nombre en blanco no borra el nombre; las etiquetas se normalizan; la URL se recorta.
    await ok(api().patch(project.base).set(auth()).send({ name: "   ", tags: [" a ", "a", "b"], baseUrl: " https://b.test " }));
    const edited = (await context.repositories.projects.findById(project.id))!;
    assert.deepEqual([edited.name, edited.tags, edited.baseUrl], ["Nuevo", ["a", "b"], "https://b.test"]);

    await ok(api().patch(project.base).set(auth()).send({ description: "  después  " }));
    assert.equal((await context.repositories.projects.findById(project.id))!.description, "después");
  });

  test("una baseUrl inválida al editar o al crear es un 422 con su campo", async () => {
    const project = await newProject();
    const edit = await api().patch(project.base).set(auth()).send({ baseUrl: "ftp://x.test" });
    assert.equal(edit.status, 422);
    assert.deepEqual(edit.body.errors, [{ field: "baseUrl", detail: "Solo http o https" }]);
    const create = await api().post(org()).set(auth()).send({ name: unique("p"), baseUrl: "no es url" });
    assert.equal(create.status, 422);
    assert.deepEqual(create.body.errors, [{ field: "baseUrl", detail: "No es una URL válida" }]);
  });

  test("leer un proyecto; un contrato subido sin texto es un 422", async () => {
    const project = await newProject({ description: "hola" });
    const read = await ok(api().get(project.base).set(auth()));
    assert.equal(read.body.id, project.id);
    assert.equal(read.body.description, "hola");
    assert.equal(read.body.fork, null);
    const upload = await api().post(`${project.base}/spec-versions`).set(auth()).send({ source: { kind: "upload" } });
    assert.equal(upload.status, 422, JSON.stringify(upload.body));
    assert.deepEqual(upload.body.errors, [{ field: "source.raw", detail: "Requerido cuando kind es upload" }]);
  });
});

describe("solicitudes de fusión en sus bordes", () => {
  async function forkWithChange() {
    const parent = await newProject();
    await ok(api().post(`${parent.base}/endpoints`).set(auth()).send({ method: "GET", path: "/orders" }));
    const forked = await ok(api().post(`${parent.base}/fork`).set(auth()).send({ name: unique("bif") }));
    const fork = { id: forked.body.projectId as string, base: `${org()}/${forked.body.projectId}` };
    await ok(api().post(`${fork.base}/endpoints`).set(auth()).send({ method: "POST", path: "/orders" }));
    return { parent, fork };
  }

  test("sin descripción se guarda vacía; un comentario en blanco es un 422", async () => {
    const { parent, fork } = await forkWithChange();
    const created = await ok(api().post(`${fork.base}/merge-requests`).set(auth()).send({ title: "  Llevar  " }));
    const requestId = (created.body.id ?? created.body.requestId) as string;
    const stored = await ok(api().get(`${parent.base}/merge-requests/${requestId}`).set(auth()));
    assert.equal(stored.body.title ?? stored.body.request?.title, "Llevar");
    assert.equal(stored.body.description ?? stored.body.request?.description, "");

    const blank = await api()
      .post(`${parent.base}/merge-requests/${requestId}/comments`)
      .set(auth())
      .send({ body: "   " });
    assert.equal(blank.status, 422, JSON.stringify(blank.body));
    assert.deepEqual(blank.body.errors, [{ field: "body", detail: "Escribe algo" }]);
  });

  test("con la bifurcación borrada, la solicitud se lee con la comparación no disponible y su nombre dice que no está", async () => {
    const { parent, fork } = await forkWithChange();
    const created = await ok(api().post(`${fork.base}/merge-requests`).set(auth()).send({ title: "Llevar" }));
    const requestId = (created.body.id ?? created.body.requestId) as string;
    await ok(api().delete(fork.base).set(auth()));

    const read = await ok(api().get(`${parent.base}/merge-requests/${requestId}`).set(auth()));
    const body = read.body as { current: unknown; unavailable: string | null; fork?: { name: string } };
    assert.equal(body.current, null);
    assert.equal(typeof body.unavailable, "string");
    assert.ok(body.unavailable!.length > 0);
    assert.match(JSON.stringify(read.body), /\(proyecto borrado\)/);
  });

  test("una solicitud creada por un token de API firma como «Token de API»", async () => {
    const { parent, fork } = await forkWithChange();
    const created = await ok(api().post(`${fork.base}/merge-requests`).set(auth()).send({ title: "Llevar" }));
    const requestId = (created.body.id ?? created.body.requestId) as string;
    const stored = (await context.repositories.mergeRequests.findById(organizationId, requestId))!;
    await context.repositories.mergeRequests.save({ ...stored, createdBy: "token-sin-usuario" });

    const list = await ok(api().get(`${parent.base}/merge-requests`).set(auth()));
    assert.match(JSON.stringify(list.body), /Token de API/);
  });
});
