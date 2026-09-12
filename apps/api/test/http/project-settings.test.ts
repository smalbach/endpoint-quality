/**
 * What a project says about the API it points at — URL, tags, login — and deleting it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());
const MASK = "•".repeat(8);
// The key the test app's cipher uses.
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 9).toString("base64"));

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

before(async () => {
  context = await createTestApp();
  owner = await signUp("ajustes@example.com");
  outsider = await signUp("ajeno@example.com");
});
after(async () => {
  await context?.close();
});

const projects = () => `/orgs/${owner.organizationId}/projects`;

describe("ajustes del proyecto", () => {
  let projectId: string;

  test("se crea con URL base, etiquetas y un token que no vuelve a salir", async () => {
    const created = await api()
      .post(projects())
      .set(as(owner))
      .send({
        name: "Pagos",
        baseUrl: "https://api.pagos.example",
        tags: [" produccion ", "v2", "v2", ""],
        auth: { type: "bearer", token: "eyJ.muy.secreto", tokenPath: "data.token" },
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    projectId = created.body.projectId;

    const read = await api().get(`${projects()}/${projectId}`).set(as(owner));
    assert.equal(read.body.baseUrl, "https://api.pagos.example");
    assert.deepEqual(read.body.tags, ["produccion", "v2"]);
    assert.equal(read.body.auth.type, "bearer");
    assert.equal(read.body.auth.token, MASK);
    assert.equal(read.body.auth.tokenPath, "data.token");
    assert.equal(read.body.lastRun, null);
    assert.equal(JSON.stringify(read.body).includes("muy.secreto"), false);

    const row = context.repositories.projects.rows.get(projectId)!;
    assert.equal(row.auth.secretCiphertext?.includes("muy.secreto"), false);
  });

  test("guardar con la máscara conserva el token", async () => {
    const response = await api()
      .patch(`${projects()}/${projectId}`)
      .set(as(owner))
      .send({ auth: { type: "bearer", token: MASK, tokenPath: "data.accessToken" } });
    assert.equal(response.status, 204, JSON.stringify(response.body));
    const row = context.repositories.projects.rows.get(projectId)!;
    assert.deepEqual(JSON.parse(cipher.decrypt(row.auth.secretCiphertext!)), { token: "eyJ.muy.secreto" });
    assert.equal(row.auth.settings.tokenPath, "data.accessToken");
  });

  test("una URL que no es http, o un bearer sin token ni login, es 422 con el campo", async () => {
    const badUrl = await api().patch(`${projects()}/${projectId}`).set(as(owner)).send({ baseUrl: "ftp://x" });
    assert.equal(badUrl.status, 422);
    assert.equal(badUrl.body.errors[0].field, "baseUrl");

    const noToken = await api()
      .patch(`${projects()}/${projectId}`)
      .set(as(owner))
      .send({ auth: { type: "bearer", token: "" } });
    assert.equal(noToken.status, 422);
    assert.equal(noToken.body.errors[0].field, "auth.token");
  });

  test("un tipo que no existe lo para la validación", async () => {
    const response = await api()
      .patch(`${projects()}/${projectId}`)
      .set(as(owner))
      .send({ auth: { type: "oauth2" } });
    assert.equal(response.status, 422);
  });

  test("pasar a «none» borra los secretos", async () => {
    await api()
      .patch(`${projects()}/${projectId}`)
      .set(as(owner))
      .send({ auth: { type: "none" } });
    const row = context.repositories.projects.rows.get(projectId)!;
    assert.equal(row.auth.secretCiphertext, null);
  });
});

describe("eliminar un proyecto", () => {
  let projectId: string;
  before(async () => {
    projectId = (await api().post(projects()).set(as(owner)).send({ name: "Temporal" })).body.projectId;
  });

  test("alguien de otra organización recibe 404 y no borra nada", async () => {
    const response = await api().delete(`/orgs/${outsider.organizationId}/projects/${projectId}`).set(as(outsider));
    assert.equal(response.status, 404);
    assert.equal((await api().get(`${projects()}/${projectId}`).set(as(owner))).status, 200);
  });

  test("después de borrarlo no existe para nadie ni sale en la lista, archivados incluidos", async () => {
    assert.equal((await api().delete(`${projects()}/${projectId}`).set(as(owner))).status, 204);
    assert.equal((await api().get(`${projects()}/${projectId}`).set(as(owner))).status, 404);
    const list = await api().get(`${projects()}?includeArchived=true`).set(as(owner));
    assert.equal(
      list.body.some((project: { id: string }) => project.id === projectId),
      false,
    );
  });

  test("su slug sigue ocupado", async () => {
    // A CI job still pointing at the deleted one must not start hitting a new project of the same
    // name.
    const again = await api().post(projects()).set(as(owner)).send({ name: "Temporal" });
    assert.equal(again.body.slug, "temporal-2");
  });
});
