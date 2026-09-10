/**
 * The session client, which is where the security properties of the front end actually live.
 *
 * Two of these are not style preferences. The single-flight refresh is the difference between a
 * page load and a forced logout: the API treats a replayed refresh token as theft and closes the
 * session, so six concurrent 401s must produce one refresh and not six. And the access token
 * living in a module variable is what makes the httpOnly cookie worth having — storing it where
 * script can read it would hand an XSS the thing the cookie was protecting.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, ApiError, getAccessToken, login, logout, refreshOnce, setAccessToken } from "./api";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

let calls: { url: string; init: RequestInit }[] = [];
let replies: Map<string, Reply[]>;

function respond(url: string, ...queue: Reply[]) {
  replies.set(url, queue);
}

beforeEach(() => {
  calls = [];
  replies = new Map();
  setAccessToken(null);
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const queue = replies.get(url);
    const reply = (queue && (queue.length > 1 ? queue.shift()! : queue[0])) ?? { status: 404, body: { title: "sin stub", status: 404, detail: url, type: "" } };
    const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(reply.status === 204 ? null : text, {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("dónde vive la sesión", () => {
  test("el access token no toca localStorage ni sessionStorage", async () => {
    respond("/api/auth/login", { status: 200, body: { userId: "u1", accessToken: "token-a", expiresIn: 900 } });
    await login("ada@example.com", "una-contraseña-larga");

    expect(getAccessToken()).toBe("token-a");
    // The refresh token is an httpOnly cookie precisely so script cannot reach it. Putting the
    // access token somewhere script *can* reach gives back what that was protecting.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  test("cada petición viaja con la cookie", async () => {
    respond("/api/auth/me", { status: 200, body: { id: "u1" } });
    await api("/auth/me");
    // Without it the request cannot renew, and the session ends at the first expiry.
    expect(calls.at(-1)!.init.credentials).toBe("include");
  });

  test("el token se envía como cabecera, nunca en la URL", async () => {
    setAccessToken("token-a");
    respond("/api/projects", { status: 200, body: [] });
    await api("/projects");
    const { url, init } = calls.at(-1)!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-a");
    // A token in a query string lands in every access log and every proxy along the way.
    expect(url).not.toContain("token-a");
  });
});

describe("renovación", () => {
  test("un 401 renueva una vez y reintenta la petición original", async () => {
    setAccessToken("caducado");
    respond("/api/projects", { status: 401, body: { title: "No autenticado", status: 401, detail: "", type: "" } }, { status: 200, body: [{ id: "p1" }] });
    respond("/api/auth/refresh", { status: 200, body: { userId: "u1", accessToken: "token-nuevo", expiresIn: 900 } });

    await expect(api("/projects")).resolves.toEqual([{ id: "p1" }]);
    expect(getAccessToken()).toBe("token-nuevo");
    expect(calls.filter((call) => call.url.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  test("seis peticiones que caducan a la vez producen una sola renovación", async () => {
    // This is the case that matters. The API treats a replayed refresh token as evidence that two
    // parties hold the chain and closes the whole session — so six refreshes would log the user
    // out on every page load where the token happened to expire.
    setAccessToken("caducado");
    for (const path of ["/a", "/b", "/c", "/d", "/e", "/f"]) {
      respond(`/api${path}`, { status: 401, body: { title: "", status: 401, detail: "", type: "" } }, { status: 200, body: { path } });
    }
    respond("/api/auth/refresh", { status: 200, body: { userId: "u1", accessToken: "token-nuevo", expiresIn: 900 } });

    await Promise.all(["/a", "/b", "/c", "/d", "/e", "/f"].map((path) => api(path)));
    expect(calls.filter((call) => call.url.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  test("no se reintenta dos veces: un 401 tras renovar se propaga", async () => {
    setAccessToken("caducado");
    respond("/api/projects", { status: 401, body: { title: "No autenticado", status: 401, detail: "", type: "" } });
    respond("/api/auth/refresh", { status: 200, body: { userId: "u1", accessToken: "token-nuevo", expiresIn: 900 } });

    await expect(api("/projects")).rejects.toBeInstanceOf(ApiError);
    // One refresh, two attempts at the resource. An unbounded loop here would hammer the API on
    // any endpoint the user genuinely cannot reach.
    expect(calls.filter((call) => call.url.endsWith("/projects"))).toHaveLength(2);
  });

  test("una renovación fallida deja la sesión anónima en vez de reintentar", async () => {
    setAccessToken("caducado");
    respond("/api/auth/refresh", { status: 401, body: { title: "", status: 401, detail: "", type: "" } });
    await expect(refreshOnce()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  test("el login no reintenta con renovación", async () => {
    // A wrong password is not an expired session, and refreshing over it would turn one 401 into
    // two requests and a confusing message.
    respond("/api/auth/login", { status: 401, body: { title: "No autenticado", status: 401, detail: "Credenciales inválidas", type: "" } });
    await expect(login("ada@example.com", "mal")).rejects.toThrow("Credenciales inválidas");
    expect(calls.filter((call) => call.url.endsWith("/auth/refresh"))).toHaveLength(0);
  });
});

describe("errores", () => {
  test("un Problem Details llega con sus campos", async () => {
    respond("/api/projects", {
      status: 422,
      body: { type: "https://x/problems/config-invalid", title: "Entidad no procesable", status: 422, detail: "La sección no es válida", errors: [{ field: "budgets.0.thresholdMs", detail: "debe ser positivo" }] },
    });
    // A form needs the field path to put the message next to the input that caused it.
    await expect(api("/projects")).rejects.toMatchObject({
      status: 422,
      fields: [{ field: "budgets.0.thresholdMs", detail: "debe ser positivo" }],
    });
  });

  test("un 204 no intenta parsear un cuerpo vacío", async () => {
    respond("/api/runs/r1/cancel", { status: 204 });
    await expect(api("/runs/r1/cancel", { method: "POST" })).resolves.toBeUndefined();
  });

  test("el logout limpia el token aunque la llamada falle", async () => {
    // Keeping a token the server has revoked only produces confusing 401s on the next action.
    setAccessToken("token-a");
    respond("/api/auth/logout", { status: 500, body: { title: "Error interno", status: 500, detail: "", type: "" } });
    await expect(logout()).rejects.toBeTruthy();
    expect(getAccessToken()).toBeNull();
  });
});
