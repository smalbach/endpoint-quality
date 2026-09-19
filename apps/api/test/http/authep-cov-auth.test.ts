/**
 * Identidad por la API: lo que queda entre «el token es válido» y «la persona puede actuar».
 *
 * Una firma que verifica de una cuenta deshabilitada, un refresh de una cuenta que se deshabilitó
 * después, el cierre de sesión en todas partes, `/auth/context` con cada tipo de credencial, y un
 * token de servicio que intenta hacer de persona.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

const PASSWORD = "Una-contraseña-larga-1";
type Actor = { organizationId: string; userId: string; token: string; refreshToken: string };

async function signUp(email: string): Promise<Actor> {
  const registered = await api().post("/auth/register").send({ email, password: PASSWORD, name: "x" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const session = await api().post("/auth/login").send({ email, password: PASSWORD });
  assert.equal(session.status, 200);
  return {
    organizationId: registered.body.organizationId,
    userId: registered.body.userId,
    token: session.body.accessToken,
    refreshToken: session.body.refreshToken,
  };
}
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

async function disable(userId: string) {
  const user = await context.repositories.users.findById(userId);
  assert.ok(user);
  await context.repositories.users.save({ ...user, status: "disabled" });
}

const problem = (response: request.Response, status: number, type?: string) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.match(String(response.headers["content-type"]), /application\/problem\+json/);
  if (type) assert.equal(response.body.type, `https://endpoint-quality.dev/problems/${type}`);
};

before(async () => {
  context = await createTestApp();
});

after(async () => {
  await context?.close();
});

describe("el guardia y la sesión", () => {
  test("un access token bien firmado de una cuenta deshabilitada es un 401", async () => {
    const actor = await signUp("authep-disabled@example.com");
    assert.equal((await api().get("/auth/me").set(as(actor.token))).status, 200);
    await disable(actor.userId);
    const response = await api().get("/auth/me").set(as(actor.token));
    problem(response, 401);
    assert.equal(response.body.detail, "La credencial no es válida");
  });

  test("refrescar la sesión de una cuenta deshabilitada es un 401 y cierra esa sesión", async () => {
    const actor = await signUp("authep-refresh-disabled@example.com");
    const stored = await context.repositories.refreshTokens.findByHash(
      (await import("@/shared/crypto/opaque-token")).hashOpaqueToken(actor.refreshToken),
    );
    assert.ok(stored);
    await disable(actor.userId);
    const response = await api().post("/auth/refresh").send({ refreshToken: actor.refreshToken });
    problem(response, 401);
    assert.equal(response.body.detail, "La sesión no es válida");
    const after = await context.repositories.refreshTokens.findByHash(stored.tokenHash);
    assert.ok(after?.revokedAt, "la sesión queda revocada");
  });

  test("un refresh token que nunca existió es un 401, sin más", async () => {
    const response = await api().post("/auth/refresh").send({ refreshToken: "no-existe" });
    problem(response, 401);
    assert.equal(response.body.detail, "La sesión no es válida");
  });

  test("cerrar sesión en todas partes invalida cada refresh token, y sin token no rompe nada", async () => {
    const actor = await signUp("authep-everywhere@example.com");
    const second = await api().post("/auth/login").send({ email: "authep-everywhere@example.com", password: PASSWORD });
    const bare = await api().post("/auth/logout").set(as(actor.token)).send({});
    assert.equal(bare.status, 204);
    // Sin token ni «everywhere», nada se cerró.
    assert.equal((await api().post("/auth/refresh").send({ refreshToken: second.body.refreshToken })).status, 200);

    const everywhere = await api().post("/auth/logout").set(as(actor.token)).send({ everywhere: true });
    assert.equal(everywhere.status, 204);
    problem(await api().post("/auth/refresh").send({ refreshToken: actor.refreshToken }), 401);
  });

  test("cambiar la contraseña con la actual equivocada es un 401 y la contraseña no cambia", async () => {
    const actor = await signUp("authep-change@example.com");
    const response = await api()
      .post("/auth/change-password")
      .set(as(actor.token))
      .send({ currentPassword: "otra-cosa", newPassword: "Otra-contraseña-larga-2" });
    problem(response, 401);
    assert.equal(response.body.detail, "La contraseña actual no es correcta");
    assert.equal((await api().post("/auth/login").send({ email: "authep-change@example.com", password: PASSWORD })).status, 200);
  });
});

describe("tokens de servicio", () => {
  let owner: Actor;
  let serviceToken: string;

  before(async () => {
    owner = await signUp("authep-tokens@example.com");
    const issued = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner.token)).send({ name: "   " });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    serviceToken = issued.body.token;
  });

  test("un token sin nombre se llama «Token de CI»", async () => {
    const list = await api().get(`/orgs/${owner.organizationId}/tokens`).set(as(owner.token));
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body as { name: string }[]).map((row) => row.name),
      ["Token de CI"],
    );
  });

  test("/auth/context: una persona ve sus organizaciones; un token la suya, como editor", async () => {
    const person = await api().get("/auth/context").set(as(owner.token));
    assert.equal(person.status, 200);
    assert.equal(person.body.principal, "user");
    assert.equal(person.body.user.email, "authep-tokens@example.com");
    assert.deepEqual(
      person.body.organizations.map((row: { id: string; role: string }) => [row.id, row.role]),
      [[owner.organizationId, "owner"]],
    );

    const service = await api().get("/auth/context").set(as(serviceToken));
    assert.equal(service.status, 200);
    assert.equal(service.body.principal, "api-token");
    assert.equal(service.body.user, null);
    assert.deepEqual(
      service.body.organizations.map((row: { id: string; role: string }) => [row.id, row.role]),
      [[owner.organizationId, "editor"]],
    );
  });

  test("un token no es una persona: ni /me, ni cambiar contraseña, ni cerrar sesión", async () => {
    problem(await api().get("/auth/me").set(as(serviceToken)), 401);
    problem(
      await api()
        .post("/auth/change-password")
        .set(as(serviceToken))
        .send({ currentPassword: PASSWORD, newPassword: "Otra-contraseña-larga-2" }),
      401,
    );
    problem(await api().post("/auth/logout").set(as(serviceToken)).send({}), 401);
  });

  test("un token no sirve fuera de su organización ni para gestionar miembros", async () => {
    const stranger = await signUp("authep-tokens-otro@example.com");
    problem(await api().get(`/orgs/${stranger.organizationId}/members`).set(as(serviceToken)), 403);
    problem(await api().get(`/orgs/${owner.organizationId}/tokens`).set(as(serviceToken)), 403, "api-token-role");
  });

  test("revocarlo dos veces no es un error, y después ya no entra", async () => {
    const list = await api().get(`/orgs/${owner.organizationId}/tokens`).set(as(owner.token));
    const id = (list.body as { id: string }[])[0].id;
    assert.equal((await api().delete(`/orgs/${owner.organizationId}/tokens/${id}`).set(as(owner.token))).status, 204);
    assert.equal((await api().delete(`/orgs/${owner.organizationId}/tokens/${id}`).set(as(owner.token))).status, 204);
    problem(await api().get("/auth/context").set(as(serviceToken)), 401);
  });
});
