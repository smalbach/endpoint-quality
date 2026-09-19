/**
 * El escáner por HTTP, en lo que la prueba principal no pasa: la lista de escaneos, borrar el
 * conector, subir sin prefijo, un token de API como autor, y los 404/409/422 con su Problem Details.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

let organizationId: string;
let userToken: string;
let projectId: string;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const base = () => `/orgs/${organizationId}/projects/${projectId}/code-scan`;

before(async () => {
  context = await createTestApp();
  const email = `misc-scan-${Date.now()}@example.test`;
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  organizationId = registered.body.organizationId;
  userToken = (await api().post("/auth/login").send({ email, password })).body.accessToken;
  projectId = (await api().post(`/orgs/${organizationId}/projects`).set(as(userToken)).send({ name: "Escaneo" })).body
    .projectId;
});

after(async () => {
  await context?.close();
});

describe("el escáner por HTTP, por sus bordes", () => {
  test("con un token de API: subir sin prefijo, listar y el autor es el token", async () => {
    const issued = await api().post(`/orgs/${organizationId}/tokens`).set(as(userToken)).send({ name: "CI" });
    assert.equal(issued.status, 201);
    const scan = await api()
      .post(`${base()}/scans/upload`)
      .set(as(issued.body.token))
      .send({ files: [{ path: "a.controller.ts", content: `@Controller("pedidos") class A { @Get() x() {} }` }] });
    assert.equal(scan.status, 201, JSON.stringify(scan.body));
    const row = context.repositories.codeScans.rows.get(scan.body.scanId)!;
    assert.equal(row.createdBy, issued.body.tokenId ?? issued.body.id);
    // Sin prefijo, la ruta tal cual.
    assert.deepEqual(
      row.result.endpoints.map((endpoint) => endpoint.path),
      ["/pedidos"],
    );

    const list = await api().get(`${base()}/scans`).set(as(userToken));
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, scan.body.scanId);
    assert.deepEqual(list.body[0].counts, { added: 1, removed: 0, changed: 0, unchanged: 0 });
  });

  test("borrar el conector: 204 y ya no hay; escanear sin él es un 404", async () => {
    await api().put(`${base()}/connector`).set(as(userToken)).send({ repo: "acme/api" }).expect(200);
    await api().delete(`${base()}/connector`).set(as(userToken)).expect(204);
    const read = await api().get(`${base()}/connector`).set(as(userToken));
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, {});
    const scan = await api().post(`${base()}/scans`).set(as(userToken)).send({});
    assert.equal(scan.status, 404);
    assert.match(scan.body.type, /connector-not-found$/);
  });

  test("un escaneo de GitHub que falla se guarda con el motivo, y no se deja importar", async () => {
    await api().put(`${base()}/connector`).set(as(userToken)).send({ repo: "acme/privado", branch: "main" }).expect(200);
    context.http.reply("https://api.github.com/repos/acme/privado/git/trees/main?recursive=1", "{}", 404);
    const scan = await api().post(`${base()}/scans`).set(as(userToken)).send({});
    assert.equal(scan.status, 201);
    const detail = await api().get(`${base()}/scans/${scan.body.scanId}`).set(as(userToken));
    assert.equal(detail.body.status, "error");
    assert.match(detail.body.error, /GitHub respondió 404/);
    const imported = await api().post(`${base()}/scans/${scan.body.scanId}/import`).set(as(userToken)).send({});
    assert.equal(imported.status, 409);
    assert.match(imported.body.type, /scan-not-ok$/);
  });

  test("un repositorio mal escrito es un 422 con el campo, y un escaneo que no existe un 404", async () => {
    const saved = await api().put(`${base()}/connector`).set(as(userToken)).send({ repo: "no es un repo" });
    assert.equal(saved.status, 422);
    assert.match(saved.body.type, /connector-invalid$/);
    const missing = await api().get(`${base()}/scans/00000000-0000-4000-8000-000000000000`).set(as(userToken));
    assert.equal(missing.status, 404);
    assert.match(missing.body.type, /scan-not-found$/);
  });
});
