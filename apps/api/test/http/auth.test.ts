/**
 * The session, end to end over HTTP.
 *
 * Driven through supertest against the real controllers, guards, pipe and filter — so a route
 * that forgot `@Public()`, a guard that runs after the pipe, or an error that escapes as a Nest
 * default fails here rather than in production.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
before(async () => {
  context = await createTestApp();
});
after(async () => {
  await context?.close();
});

const api = () => request(context.app.getHttpServer());
const credentials = { email: "ada@example.com", password: "Una-contraseña-larga-1", name: "Ada" };

async function register(overrides: Partial<typeof credentials> = {}) {
  return api()
    .post("/auth/register")
    .send({ ...credentials, ...overrides });
}
async function login(overrides: Partial<typeof credentials> = {}) {
  const { email, password } = { ...credentials, ...overrides };
  return api().post("/auth/login").send({ email, password });
}

describe("registro", () => {
  test("crea la cuenta y su organización en una sola llamada", async () => {
    const response = await register();
    assert.equal(response.status, 201);
    assert.ok(response.body.userId);
    // An account with no organization cannot do anything, so registration is not allowed to
    // leave one in that state.
    assert.ok(response.body.organizationId);
    const membership = await context.repositories.memberships.find(response.body.organizationId, response.body.userId);
    assert.equal(membership?.role, "owner");
  });

  test("rechaza una contraseña corta con 422 y nombra el campo", async () => {
    const response = await register({ email: "corta@example.com", password: "corta" });
    assert.equal(response.status, 422);
    assert.equal(response.headers["content-type"]?.split(";")[0], "application/problem+json");
    assert.ok(response.body.errors.some((error: { field: string }) => error.field === "password"));
  });

  test("un correo repetido es 409 y no crea una segunda cuenta", async () => {
    const response = await register();
    assert.equal(response.status, 409);
    assert.equal(response.body.status, 409);
    assert.equal(
      [...context.repositories.users.rows.values()].filter((user) => user.email === credentials.email).length,
      1,
    );
  });

  test("un campo no declarado se rechaza en vez de ignorarse", async () => {
    // Silently dropping `role: "owner"` would hide an attempt to send it.
    const response = await api()
      .post("/auth/register")
      .send({ ...credentials, email: "x@example.com", role: "owner" });
    assert.equal(response.status, 422);
  });
});

describe("login", () => {
  test("devuelve el access token en el cuerpo y el refresh en una cookie httpOnly", async () => {
    const response = await login();
    assert.equal(response.status, 200);
    assert.ok(response.body.accessToken);
    assert.equal(typeof response.body.expiresIn, "number");

    const cookie = (response.headers["set-cookie"] as unknown as string[])[0];
    // httpOnly is what keeps an XSS on the dashboard from reading a thirty-day credential;
    // SameSite=Strict is what keeps a cross-site request from spending it.
    assert.match(cookie, /^eq_refresh=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });

  test("una contraseña incorrecta y un correo inexistente dan la misma respuesta", async () => {
    // Any difference here — status, body or wording — is a free way to enumerate valid accounts.
    const wrongPassword = await login({ password: "esta-no-es-la-buena" });
    const unknownEmail = await login({ email: "nadie@example.com", password: "esta-no-es-la-buena" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.deepEqual({ ...wrongPassword.body, instance: null }, { ...unknownEmail.body, instance: null });
  });

  test("una cuenta deshabilitada falla igual que una contraseña incorrecta", async () => {
    const user = await context.repositories.users.findByEmail(credentials.email);
    await context.repositories.users.save({ ...user!, status: "disabled" });
    const response = await login();
    assert.equal(response.status, 401);
    assert.equal(response.body.detail, "Credenciales inválidas");
    await context.repositories.users.save({ ...user!, status: "active" });
  });
});

describe("rotación del refresh token", () => {
  test("el token rotado deja de servir y el nuevo funciona", async () => {
    const session = (await login()).body;
    const rotated = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refreshToken, session.refreshToken);

    const again = await api().post("/auth/refresh").send({ refreshToken: rotated.body.refreshToken });
    assert.equal(again.status, 200);
  });

  test("reusar un token gastado revoca toda la sesión, no solo ese token", async () => {
    // This is the case rotation exists for. The thief refreshes and keeps going; the theft only
    // surfaces when the legitimate holder presents the token that was already spent. At that
    // point there is no way to tell from here which of the two is asking, so the whole chain
    // closes: both are logged out, and the account is not left in the attacker's hands.
    const session = (await login()).body;
    const first = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
    const second = await api().post("/auth/refresh").send({ refreshToken: first.body.refreshToken });
    assert.equal(second.status, 200);

    const reuse = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
    assert.equal(reuse.status, 401);

    // The newest token of that chain — whoever holds it — is now dead too.
    const afterBreach = await api().post("/auth/refresh").send({ refreshToken: second.body.refreshToken });
    assert.equal(afterBreach.status, 401, "el token vivo de la cadena debía quedar revocado");
  });

  test("un refresh token caducado no se acepta", async () => {
    const session = (await login()).body;
    context.clock.advance(31 * 24 * 60 * 60 * 1000);
    const response = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
    assert.equal(response.status, 401);
    context.clock.set(new Date("2026-03-01T10:00:00.000Z"));
  });

  test("sin token la respuesta es 401 y no 500", async () => {
    const response = await api().post("/auth/refresh").send({});
    assert.equal(response.status, 401);
    assert.equal(response.body.title, "No autenticado");
  });
});

describe("rutas protegidas", () => {
  test("/auth/me sin credencial es 401 en Problem Details", async () => {
    const response = await api().get("/auth/me");
    assert.equal(response.status, 401);
    assert.equal(response.headers["content-type"]?.split(";")[0], "application/problem+json");
    assert.ok(response.body.type.startsWith("https://"));
    assert.equal(response.body.instance, "/auth/me");
  });

  test("un token con firma inválida es 401", async () => {
    const session = (await login()).body;
    const tampered = `${session.accessToken.slice(0, -3)}aaa`;
    const response = await api().get("/auth/me").set("Authorization", `Bearer ${tampered}`);
    assert.equal(response.status, 401);
  });

  test("/auth/me devuelve la identidad y las organizaciones donde puede actuar", async () => {
    const session = (await login()).body;
    const response = await api().get("/auth/me").set("Authorization", `Bearer ${session.accessToken}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.email, credentials.email);
    assert.equal(response.body.organizations.length, 1);
    assert.equal(response.body.organizations[0].role, "owner");
  });

  test("ninguna respuesta de error incluye traza", async () => {
    const response = await api().get("/auth/me");
    assert.equal(JSON.stringify(response.body).includes("at "), false);
    assert.equal("stack" in response.body, false);
  });
});

describe("cierre de sesión y cambio de contraseña", () => {
  test("el logout revoca la sesión y limpia la cookie", async () => {
    const session = (await login()).body;
    const response = await api()
      .post("/auth/logout")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({ refreshToken: session.refreshToken });
    assert.equal(response.status, 204);
    assert.match((response.headers["set-cookie"] as unknown as string[])[0], /^eq_refresh=;/);

    const afterLogout = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
    assert.equal(afterLogout.status, 401);
  });

  test("cambiar la contraseña cierra todas las sesiones abiertas", async () => {
    // Somebody changes their password because they think another party has it. A change that
    // leaves that party's session alive does the one thing they were trying to prevent.
    const first = (await login()).body;
    const second = (await login()).body;

    const changed = await api()
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${first.accessToken}`)
      .send({ currentPassword: credentials.password, newPassword: "Otra-contraseña-larga-2" });
    assert.equal(changed.status, 204);

    for (const session of [first, second]) {
      const response = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
      assert.equal(response.status, 401, "una sesión anterior sobrevivió al cambio de contraseña");
    }
    assert.equal((await login({ password: "Otra-contraseña-larga-2" })).status, 200);
  });
});
