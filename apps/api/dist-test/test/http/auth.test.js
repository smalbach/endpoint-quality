"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * The session, end to end over HTTP.
 *
 * Driven through supertest against the real controllers, guards, pipe and filter — so a route
 * that forgot `@Public()`, a guard that runs after the pipe, or an error that escapes as a Nest
 * default fails here rather than in production.
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const supertest_1 = __importDefault(require("supertest"));
const test_app_1 = require("../support/test-app");
let context;
(0, node_test_1.before)(async () => {
    context = await (0, test_app_1.createTestApp)();
});
(0, node_test_1.after)(async () => {
    await context?.close();
});
const api = () => (0, supertest_1.default)(context.app.getHttpServer());
const credentials = { email: "ada@example.com", password: "una-contraseña-larga", name: "Ada" };
async function register(overrides = {}) {
    return api().post("/auth/register").send({ ...credentials, ...overrides });
}
async function login(overrides = {}) {
    const { email, password } = { ...credentials, ...overrides };
    return api().post("/auth/login").send({ email, password });
}
(0, node_test_1.describe)("registro", () => {
    (0, node_test_1.test)("crea la cuenta y su organización en una sola llamada", async () => {
        const response = await register();
        strict_1.default.equal(response.status, 201);
        strict_1.default.ok(response.body.userId);
        // An account with no organization cannot do anything, so registration is not allowed to
        // leave one in that state.
        strict_1.default.ok(response.body.organizationId);
        const membership = await context.repositories.memberships.find(response.body.organizationId, response.body.userId);
        strict_1.default.equal(membership?.role, "owner");
    });
    (0, node_test_1.test)("rechaza una contraseña corta con 422 y nombra el campo", async () => {
        const response = await register({ email: "corta@example.com", password: "corta" });
        strict_1.default.equal(response.status, 422);
        strict_1.default.equal(response.headers["content-type"]?.split(";")[0], "application/problem+json");
        strict_1.default.ok(response.body.errors.some((error) => error.field === "password"));
    });
    (0, node_test_1.test)("un correo repetido es 409 y no crea una segunda cuenta", async () => {
        const response = await register();
        strict_1.default.equal(response.status, 409);
        strict_1.default.equal(response.body.status, 409);
        strict_1.default.equal([...context.repositories.users.rows.values()].filter((user) => user.email === credentials.email).length, 1);
    });
    (0, node_test_1.test)("un campo no declarado se rechaza en vez de ignorarse", async () => {
        // Silently dropping `role: "owner"` would hide an attempt to send it.
        const response = await api().post("/auth/register").send({ ...credentials, email: "x@example.com", role: "owner" });
        strict_1.default.equal(response.status, 422);
    });
});
(0, node_test_1.describe)("login", () => {
    (0, node_test_1.test)("devuelve el access token en el cuerpo y el refresh en una cookie httpOnly", async () => {
        const response = await login();
        strict_1.default.equal(response.status, 200);
        strict_1.default.ok(response.body.accessToken);
        strict_1.default.equal(typeof response.body.expiresIn, "number");
        const cookie = response.headers["set-cookie"][0];
        // httpOnly is what keeps an XSS on the dashboard from reading a thirty-day credential;
        // SameSite=Strict is what keeps a cross-site request from spending it.
        strict_1.default.match(cookie, /^eq_refresh=/);
        strict_1.default.match(cookie, /HttpOnly/i);
        strict_1.default.match(cookie, /SameSite=Strict/i);
    });
    (0, node_test_1.test)("una contraseña incorrecta y un correo inexistente dan la misma respuesta", async () => {
        // Any difference here — status, body or wording — is a free way to enumerate valid accounts.
        const wrongPassword = await login({ password: "esta-no-es-la-buena" });
        const unknownEmail = await login({ email: "nadie@example.com", password: "esta-no-es-la-buena" });
        strict_1.default.equal(wrongPassword.status, 401);
        strict_1.default.equal(unknownEmail.status, 401);
        strict_1.default.deepEqual({ ...wrongPassword.body, instance: null }, { ...unknownEmail.body, instance: null });
    });
    (0, node_test_1.test)("una cuenta deshabilitada falla igual que una contraseña incorrecta", async () => {
        const user = await context.repositories.users.findByEmail(credentials.email);
        await context.repositories.users.save({ ...user, status: "disabled" });
        const response = await login();
        strict_1.default.equal(response.status, 401);
        strict_1.default.equal(response.body.detail, "Credenciales inválidas");
        await context.repositories.users.save({ ...user, status: "active" });
    });
});
(0, node_test_1.describe)("rotación del refresh token", () => {
    (0, node_test_1.test)("el token rotado deja de servir y el nuevo funciona", async () => {
        const session = (await login()).body;
        const rotated = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
        strict_1.default.equal(rotated.status, 200);
        strict_1.default.notEqual(rotated.body.refreshToken, session.refreshToken);
        const again = await api().post("/auth/refresh").send({ refreshToken: rotated.body.refreshToken });
        strict_1.default.equal(again.status, 200);
    });
    (0, node_test_1.test)("reusar un token gastado revoca toda la sesión, no solo ese token", async () => {
        // This is the case rotation exists for. The thief refreshes and keeps going; the theft only
        // surfaces when the legitimate holder presents the token that was already spent. At that
        // point there is no way to tell from here which of the two is asking, so the whole chain
        // closes: both are logged out, and the account is not left in the attacker's hands.
        const session = (await login()).body;
        const first = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
        const second = await api().post("/auth/refresh").send({ refreshToken: first.body.refreshToken });
        strict_1.default.equal(second.status, 200);
        const reuse = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
        strict_1.default.equal(reuse.status, 401);
        // The newest token of that chain — whoever holds it — is now dead too.
        const afterBreach = await api().post("/auth/refresh").send({ refreshToken: second.body.refreshToken });
        strict_1.default.equal(afterBreach.status, 401, "el token vivo de la cadena debía quedar revocado");
    });
    (0, node_test_1.test)("un refresh token caducado no se acepta", async () => {
        const session = (await login()).body;
        context.clock.advance(31 * 24 * 60 * 60 * 1000);
        const response = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
        strict_1.default.equal(response.status, 401);
        context.clock.set(new Date("2026-03-01T10:00:00.000Z"));
    });
    (0, node_test_1.test)("sin token la respuesta es 401 y no 500", async () => {
        const response = await api().post("/auth/refresh").send({});
        strict_1.default.equal(response.status, 401);
        strict_1.default.equal(response.body.title, "No autenticado");
    });
});
(0, node_test_1.describe)("rutas protegidas", () => {
    (0, node_test_1.test)("/auth/me sin credencial es 401 en Problem Details", async () => {
        const response = await api().get("/auth/me");
        strict_1.default.equal(response.status, 401);
        strict_1.default.equal(response.headers["content-type"]?.split(";")[0], "application/problem+json");
        strict_1.default.ok(response.body.type.startsWith("https://"));
        strict_1.default.equal(response.body.instance, "/auth/me");
    });
    (0, node_test_1.test)("un token con firma inválida es 401", async () => {
        const session = (await login()).body;
        const tampered = `${session.accessToken.slice(0, -3)}aaa`;
        const response = await api().get("/auth/me").set("Authorization", `Bearer ${tampered}`);
        strict_1.default.equal(response.status, 401);
    });
    (0, node_test_1.test)("/auth/me devuelve la identidad y las organizaciones donde puede actuar", async () => {
        const session = (await login()).body;
        const response = await api().get("/auth/me").set("Authorization", `Bearer ${session.accessToken}`);
        strict_1.default.equal(response.status, 200);
        strict_1.default.equal(response.body.email, credentials.email);
        strict_1.default.equal(response.body.organizations.length, 1);
        strict_1.default.equal(response.body.organizations[0].role, "owner");
    });
    (0, node_test_1.test)("ninguna respuesta de error incluye traza", async () => {
        const response = await api().get("/auth/me");
        strict_1.default.equal(JSON.stringify(response.body).includes("at "), false);
        strict_1.default.equal("stack" in response.body, false);
    });
});
(0, node_test_1.describe)("cierre de sesión y cambio de contraseña", () => {
    (0, node_test_1.test)("el logout revoca la sesión y limpia la cookie", async () => {
        const session = (await login()).body;
        const response = await api().post("/auth/logout").set("Authorization", `Bearer ${session.accessToken}`).send({ refreshToken: session.refreshToken });
        strict_1.default.equal(response.status, 204);
        strict_1.default.match(response.headers["set-cookie"][0], /^eq_refresh=;/);
        const afterLogout = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
        strict_1.default.equal(afterLogout.status, 401);
    });
    (0, node_test_1.test)("cambiar la contraseña cierra todas las sesiones abiertas", async () => {
        // Somebody changes their password because they think another party has it. A change that
        // leaves that party's session alive does the one thing they were trying to prevent.
        const first = (await login()).body;
        const second = (await login()).body;
        const changed = await api()
            .post("/auth/change-password")
            .set("Authorization", `Bearer ${first.accessToken}`)
            .send({ currentPassword: credentials.password, newPassword: "otra-contraseña-larga" });
        strict_1.default.equal(changed.status, 204);
        for (const session of [first, second]) {
            const response = await api().post("/auth/refresh").send({ refreshToken: session.refreshToken });
            strict_1.default.equal(response.status, 401, "una sesión anterior sobrevivió al cambio de contraseña");
        }
        strict_1.default.equal((await login({ password: "otra-contraseña-larga" })).status, 200);
    });
});
//# sourceMappingURL=auth.test.js.map