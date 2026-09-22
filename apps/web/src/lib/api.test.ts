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
import {
  absoluteApiUrl,
  api,
  ApiError,
  getAccessToken,
  login,
  logout,
  onAccessTokenChange,
  openReport,
  refreshOnce,
  register,
  setAccessToken,
  streamRun,
} from "./api";

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
    const reply = (queue && (queue.length > 1 ? queue.shift()! : queue[0])) ?? {
      status: 404,
      body: { title: "sin stub", status: 404, detail: url, type: "" },
    };
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
    respond(
      "/api/projects",
      { status: 401, body: { title: "No autenticado", status: 401, detail: "", type: "" } },
      { status: 200, body: [{ id: "p1" }] },
    );
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
      respond(
        `/api${path}`,
        { status: 401, body: { title: "", status: 401, detail: "", type: "" } },
        { status: 200, body: { path } },
      );
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
    respond("/api/auth/login", {
      status: 401,
      body: { title: "No autenticado", status: 401, detail: "Credenciales inválidas", type: "" },
    });
    await expect(login("ada@example.com", "mal")).rejects.toThrow("Credenciales inválidas");
    expect(calls.filter((call) => call.url.endsWith("/auth/refresh"))).toHaveLength(0);
  });
});

describe("errores", () => {
  test("un Problem Details llega con sus campos", async () => {
    respond("/api/projects", {
      status: 422,
      body: {
        type: "https://x/problems/config-invalid",
        title: "Entidad no procesable",
        status: 422,
        detail: "La sección no es válida",
        errors: [{ field: "budgets.0.thresholdMs", detail: "debe ser positivo" }],
      },
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

describe("bordes de la petición", () => {
  test("un formulario viaja tal cual, sin Content-Type a mano", async () => {
    respond("/api/uploads", { status: 200, body: { ok: true } });
    const form = new FormData();
    form.append("file", "contenido");
    await api("/uploads", { method: "POST", body: form });
    const { init } = calls.at(-1)!;
    // The browser writes the multipart boundary itself; a hand-set header would lose it.
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("un JSON viaja serializado, con su señal y sus cabeceras extra", async () => {
    respond("/api/docs", { status: 200, body: { ok: true } });
    const controller = new AbortController();
    await api("/docs", { method: "PUT", body: { a: 1 }, signal: controller.signal, headers: { "x-api-key": "k" } });
    const { init } = calls.at(-1)!;
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "x-api-key": "k" });
  });

  test("un 200 sin cuerpo resuelve a null", async () => {
    respond("/api/empty", { status: 200 });
    await expect(api("/empty")).resolves.toBeNull();
  });

  test("un error sin cuerpo usa el texto del estado", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503, statusText: "Service Unavailable" }));
    const error = await api("/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Service Unavailable");
    expect((error as ApiError).fields).toEqual([]);
  });

  test("el mensaje del error cae al título y luego al estado HTTP", () => {
    expect(new ApiError(400, { type: "", title: "Petición mala", status: 400, detail: "" }).message).toBe(
      "Petición mala",
    );
    expect(new ApiError(418, { type: "", title: "", status: 418, detail: "" }).message).toBe("HTTP 418");
  });

  test("un 500 con traza la enseña para poder copiarla; un 4xx no, y sin traza tampoco", () => {
    const roto = { type: "", title: "Error interno", status: 500, detail: "La solicitud no pudo completarse" };
    expect(new ApiError(500, { ...roto, traceId: "a3f2-9c1" }).message).toBe(
      "La solicitud no pudo completarse · traza a3f2-9c1",
    );
    expect(new ApiError(500, roto).message).toBe("La solicitud no pudo completarse");
    expect(
      new ApiError(422, { type: "", title: "", status: 422, detail: "Falta el nombre", traceId: "a3f2-9c1" }).message,
    ).toBe("Falta el nombre");
  });

  test("una renovación cuya red falla deja la sesión anónima", async () => {
    setAccessToken("caducado");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("sin red");
    });
    await expect(refreshOnce()).resolves.toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  test("absoluteApiUrl compone la dirección sobre el origen de la pestaña", () => {
    expect(absoluteApiUrl("/mocks/m1")).toBe(`${window.location.origin}/api/mocks/m1`);
  });
});

describe("oyentes del token", () => {
  test("se avisa a cada oyente hasta que se da de baja", () => {
    const seen: (string | null)[] = [];
    const off = onAccessTokenChange((token) => seen.push(token));
    setAccessToken("t1");
    setAccessToken(null);
    off();
    setAccessToken("t2");
    expect(seen).toEqual(["t1", null]);
  });
});

describe("registro y cierre", () => {
  test("registrarse inicia la sesión con las mismas credenciales", async () => {
    respond("/api/auth/register", { status: 201, body: { id: "u1" } });
    respond("/api/auth/login", { status: 200, body: { userId: "u1", accessToken: "token-r", expiresIn: 900 } });
    await register({ email: "ada@example.com", password: "una-contraseña-larga", name: "Ada" });
    expect(calls.map((call) => call.url)).toEqual(["/api/auth/register", "/api/auth/login"]);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      email: "ada@example.com",
      password: "una-contraseña-larga",
    });
    expect(getAccessToken()).toBe("token-r");
  });

  test("un logout que sale bien también limpia el token", async () => {
    setAccessToken("token-a");
    respond("/api/auth/logout", { status: 204 });
    await logout();
    expect(getAccessToken()).toBeNull();
  });
});

describe("openReport", () => {
  test("abre el informe como blob en otra pestaña, con la sesión en la cabecera", async () => {
    vi.useFakeTimers();
    setAccessToken("token-a");
    const fetchMock = vi.fn(async () => new Response("<html></html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // jsdom does not implement blob URLs, so the two statics are stood in for the test.
    const create = vi.fn(() => "blob:informe");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      await openReport("/runs/r1/report.html");
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/report.html", {
        headers: { Authorization: "Bearer token-a" },
        credentials: "include",
      });
      expect(create).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith("blob:informe", "_blank", "noopener");
      expect(revoke).not.toHaveBeenCalled();
      // Revoked later, not at once: the new tab still has to read the blob.
      vi.advanceTimersByTime(60_000);
      expect(revoke).toHaveBeenCalledWith("blob:informe");
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
      open.mockRestore();
      vi.useRealTimers();
    }
  });

  test("sin sesión no manda Authorization, y un fallo se nota", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(openReport("/runs/r1/report.html")).rejects.toThrow("No se pudo abrir el informe");
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/report.html", { headers: {}, credentials: "include" });
  });
});

describe("streamRun", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  test("parsea SSE aunque un evento llegue partido, y salta lo que no es JSON", async () => {
    setAccessToken("token-a");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          streamOf([
            'event: step\ndata: {"a":',
            "1}\n\n",
            "data: 2\n\n: ping\n\ndata: {roto\n\n",
            "event: fin\ndata: {}\n\ncola sin terminar",
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const events: { type: string; data: unknown }[] = [];
    const controller = new AbortController();
    await streamRun("/runs/r1/stream", { onEvent: (event) => events.push(event), signal: controller.signal });

    expect(events).toEqual([
      { type: "step", data: { a: 1 } },
      { type: "message", data: 2 },
      { type: "fin", data: {} },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/stream", {
      headers: { Accept: "text/event-stream", Authorization: "Bearer token-a" },
      credentials: "include",
      signal: controller.signal,
    });
  });

  test("un stream que no abre es un ApiError", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 403 }));
    const signal = new AbortController().signal;
    await expect(streamRun("/runs/r1/stream", { onEvent: () => {}, signal })).rejects.toMatchObject({
      status: 403,
      message: "No se pudo abrir el stream",
    });
  });

  test("una respuesta sin cuerpo tampoco abre el stream", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await expect(streamRun("/s", { onEvent: () => {}, signal })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledWith("/api/s", {
      headers: { Accept: "text/event-stream" },
      credentials: "include",
      signal,
    });
  });
});
