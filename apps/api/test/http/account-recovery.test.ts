/**
 * Recovering an account: the lock after five wrong passwords, the reset link, and the mails.
 *
 * The reset link only exists inside a mail, so the tests read it from the recording mailer — the
 * same way a person reads it from their inbox.
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
const PASSWORD = "Una-contraseña-larga-1";

async function register(email: string) {
  const response = await api().post("/auth/register").send({ email, password: PASSWORD, name: "Ana" });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}
const login = (email: string, password = PASSWORD) => api().post("/auth/login").send({ email, password });

/** Mails are sent after the answer leaves, so a test waits for them rather than assuming. */
async function mailTo(email: string, subject: RegExp) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = [...context.mailer.sent].reverse().find((mail) => mail.to === email && subject.test(mail.subject));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`no llegó ningún correo «${subject}» a ${email}`);
}
const tokenIn = (text: string) => decodeURIComponent(/token=([^\s&]+)/.exec(text)?.[1] ?? "");

describe("registro", () => {
  test("rechaza una contraseña sin mayúscula, número ni símbolo y dice qué falta", async () => {
    const response = await api()
      .post("/auth/register")
      .send({ email: "debil@example.com", password: "contraseñalarga", name: "D" });
    assert.equal(response.status, 422);
    const details = response.body.errors.map((error: { detail: string }) => error.detail);
    assert.deepEqual(details, ["Debe incluir una mayúscula", "Debe incluir un número", "Debe incluir un símbolo"]);
  });

  test("manda el correo de bienvenida", async () => {
    await register("bienvenida@example.com");
    const mail = await mailTo("bienvenida@example.com", /Bienvenida/);
    assert.match(mail.text, /\/login/);
  });
});

describe("bloqueo tras cinco intentos", () => {
  const email = "bloqueo@example.com";
  before(() => register(email));

  test("el quinto fallo bloquea, y la contraseña buena deja de servir con el mismo mensaje", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1)
      assert.equal((await login(email, "Mala-contraseña-9")).status, 401);
    const locked = await login(email);
    assert.equal(locked.status, 401);
    // The same answer as a wrong password: «bloqueada» would confirm the address exists.
    assert.equal(locked.body.detail, (await login("nadie@example.com")).body.detail);
  });

  test("pasados quince minutos vuelve a entrar", async () => {
    context.clock.advance(15 * 60 * 1000 + 1);
    assert.equal((await login(email)).status, 200);
  });

  test("un acierto pone el contador a cero", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await login(email, "Mala-contraseña-9");
    assert.equal((await login(email)).status, 200);
    for (let attempt = 0; attempt < 4; attempt += 1) await login(email, "Mala-contraseña-9");
    assert.equal((await login(email)).status, 200);
  });
});

describe("olvidé mi contraseña", () => {
  const email = "olvido@example.com";
  const NEW_PASSWORD = "Otra-contraseña-nueva-2";
  before(() => register(email));

  test("contesta 204 igual para una cuenta que no existe, y no manda nada", async () => {
    const before = context.mailer.sent.length;
    const response = await api().post("/auth/forgot-password").send({ email: "fantasma@example.com" });
    assert.equal(response.status, 204);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(context.mailer.sent.length, before);
  });

  test("una contraseña débil no gasta el enlace", async () => {
    assert.equal((await api().post("/auth/forgot-password").send({ email })).status, 204);
    const token = tokenIn((await mailTo(email, /Restablecer/)).text);
    assert.ok(token);
    const weak = await api().post("/auth/reset-password").send({ token, newPassword: "sololetraslargas" });
    assert.equal(weak.status, 422);
    const good = await api().post("/auth/reset-password").send({ token, newPassword: NEW_PASSWORD });
    assert.equal(good.status, 204);
  });

  test("después entra la nueva y no la vieja, y las sesiones anteriores están cerradas", async () => {
    assert.equal((await login(email)).status, 401);
    const session = await login(email, NEW_PASSWORD);
    assert.equal(session.status, 200);

    await api().post("/auth/forgot-password").send({ email });
    const token = tokenIn((await mailTo(email, /Restablecer/)).text);
    assert.equal(
      (await api().post("/auth/reset-password").send({ token, newPassword: "Tercera-contraseña-3" })).status,
      204,
    );
    const refreshed = await api().post("/auth/refresh").send({ refreshToken: session.body.refreshToken });
    assert.equal(refreshed.status, 401);
  });

  test("un enlace usado no sirve dos veces", async () => {
    await api().post("/auth/forgot-password").send({ email });
    const token = tokenIn((await mailTo(email, /Restablecer/)).text);
    assert.equal(
      (await api().post("/auth/reset-password").send({ token, newPassword: "Cuarta-contraseña-4" })).status,
      204,
    );
    const again = await api().post("/auth/reset-password").send({ token, newPassword: "Quinta-contraseña-5" });
    assert.equal(again.status, 422);
    assert.equal(again.body.errors[0].field, "token");
  });

  test("usar un enlace gasta también los que se pidieron antes", async () => {
    await api().post("/auth/forgot-password").send({ email });
    const first = tokenIn((await mailTo(email, /Restablecer/)).text);
    context.mailer.sent.length = 0;
    await api().post("/auth/forgot-password").send({ email });
    const second = tokenIn((await mailTo(email, /Restablecer/)).text);
    assert.notEqual(first, second);
    assert.equal(
      (await api().post("/auth/reset-password").send({ token: second, newPassword: "Sexta-contraseña-6" })).status,
      204,
    );
    assert.equal(
      (await api().post("/auth/reset-password").send({ token: first, newPassword: "Septima-contraseña-7" })).status,
      422,
    );
  });

  test("un enlace caduca a la hora", async () => {
    await api().post("/auth/forgot-password").send({ email });
    const token = tokenIn((await mailTo(email, /Restablecer/)).text);
    context.clock.advance(60 * 60 * 1000 + 1);
    assert.equal(
      (await api().post("/auth/reset-password").send({ token, newPassword: "Octava-contraseña-8" })).status,
      422,
    );
  });

  test("restablecer levanta el bloqueo", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await login(email, "Mala-contraseña-9");
    assert.equal((await login(email, "Sexta-contraseña-6")).status, 401);
    await api().post("/auth/forgot-password").send({ email });
    const token = tokenIn((await mailTo(email, /Restablecer/)).text);
    assert.equal(
      (await api().post("/auth/reset-password").send({ token, newPassword: "Novena-contraseña-9" })).status,
      204,
    );
    assert.equal((await login(email, "Novena-contraseña-9")).status, 200);
  });
});
