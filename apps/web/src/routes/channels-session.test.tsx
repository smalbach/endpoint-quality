/**
 * La pantalla de canales: la lista, la sesión y su ciclo de vida, y los botones de la conversación.
 *
 * Lo que decide algo:
 *
 * - **Se sigue la sesión que toca**: la de `?s=`, o la que sigue viva en el canal; cambiar de sesión
 *   a mitad de lectura no pinta la vieja ni avisa de su fallo.
 * - **El stream cierra con el veredicto**: al terminar se relee la sesión.
 * - **Cada botón manda lo suyo** —conectar sin entorno, terminar el envío de gRPC, cancelar,
 *   desconectar, Ctrl+Enter— y un fallo se dice.
 * - **Las sesiones anteriores dicen cómo acabaron**, en palabras.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChannelsPage } from "@/routes/channels";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import type { ChannelDetailView, ChannelMessageView, ChannelSessionView, ChannelView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const stream = vi.hoisted(() => vi.fn());
const can = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<object>()),
  api: call,
  streamRun: stream,
}));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => can.edit }));

const ROOT = "/orgs/o/projects/p1";

const channel = (patch: Partial<ChannelView> = {}): ChannelView => ({
  id: "c1",
  protocol: "ws",
  name: "eco",
  url: "wss://eco.example.test/socket",
  subprotocols: [],
  headers: [],
  auth: null,
  limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
  expectations: {},
  messages: [],
  mqtt: null,
  grpc: null,
  orderIndex: 0,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...patch,
});

const msg = (seq: number, patch: Partial<ChannelMessageView> = {}): ChannelMessageView => ({
  seq,
  direction: "in",
  atMs: seq * 100,
  kind: "text",
  body: "",
  bytes: 2,
  truncated: false,
  ...patch,
});

const session = (patch: Partial<ChannelSessionView> = {}): ChannelSessionView => ({
  id: "s1",
  channelId: "c1",
  environmentId: "env-1",
  status: "open",
  handshake: { status: 101, headers: {} },
  counters: { sent: 0, received: 0, bytesIn: 0, bytesOut: 0 },
  closeCode: null,
  closeReason: "",
  trailers: null,
  stopReason: null,
  verdict: null,
  openedAt: "2026-03-01T10:00:00.000Z",
  closedAt: null,
  live: true,
  messages: [],
  ...patch,
});

type Options = { method?: string; body?: unknown };
/** Lo que contesta la API; `undefined` cae en la respuesta de siempre. */
type Override = (path: string, method: string, options?: Options) => unknown;

function serve({
  channels = [channel()],
  detail,
  environments = [{ id: "env-1", name: "staging", variables: {} }],
  override = () => undefined,
}: {
  channels?: ChannelView[];
  detail?: ChannelDetailView;
  environments?: unknown[];
  override?: Override;
} = {}) {
  call.mockReset();
  stream.mockReset();
  stream.mockImplementation(async () => undefined);
  call.mockImplementation(async (path: string, options?: Options) => {
    const method = options?.method ?? "GET";
    const answer = override(path, method, options);
    if (answer !== undefined) return answer;
    if (path.endsWith("/environments")) return environments;
    if (path.endsWith("/channels") && method === "GET") return { channels };
    if (/\/channels\/[a-z]\d$/.test(path) && method === "GET")
      return detail ?? { ...channels.find((entry) => path.endsWith(entry.id))!, sessions: [] };
    if (/\/channels\/sessions\/s\d$/.test(path)) return session();
    return {};
  });
}

function show(url = "/p/p1/channels?c=c1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/p/:projectId/channels" element={<ChannelsPage />} />
            <Route path="/channels" element={<ChannelsPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const posted = (suffix: string) =>
  call.mock.calls.filter(([path, options]) => options?.method === "POST" && String(path).endsWith(suffix));

/** Una promesa que se resuelve o se rechaza desde fuera. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  can.edit = true;
});

describe("la lista", () => {
  test("marca el abierto, lleva el protocolo en la fila, y elegir otro lo abre", async () => {
    serve({
      channels: [
        channel(),
        channel({ id: "g1", protocol: "grpc", name: "tienda", url: "grpcs://api.x:443" }),
        channel({ id: "x1", protocol: "socketio", name: "chat", url: "https://chat.x" }),
      ],
    });
    show();
    expect(await screen.findByText("eco", { selector: "h2" })).toBeTruthy();
    const list = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(list).toEqual([
      "ecowss://eco.example.test/socket",
      "gRPCtiendagrpcs://api.x:443",
      "Socket.IOchathttps://chat.x",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /tienda/ }));
    expect(await screen.findByText("tienda", { selector: "h2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /tienda/ }).className).toContain("bg-slate-900");
    expect(screen.getByRole("button", { name: /eco/ }).className).not.toContain("bg-slate-900");
  });

  test("fuera de un proyecto no pinta nada", () => {
    serve();
    const { container } = show("/channels");
    expect(container.innerHTML).toBe("");
    expect(call).not.toHaveBeenCalled();
  });

  test("un canal que no se puede leer lo dice", async () => {
    serve({
      override: (path) => {
        if (path.endsWith("/channels/c1")) throw new Error("No encontrado");
        return undefined;
      },
    });
    show();
    expect(await screen.findByText("No se pudo leer el canal.")).toBeTruthy();
  });
});

describe("crear", () => {
  test("los fallos por campo salen en su campo; uno general, debajo; cancelar cierra", async () => {
    let attempt = 0;
    serve({
      channels: [],
      override: (path, method) => {
        if (!path.endsWith("/channels") || method !== "POST") return undefined;
        attempt += 1;
        if (attempt === 1)
          throw new ApiError(422, {
            type: "about:blank",
            title: "Inválido",
            status: 422,
            detail: "Revisa los campos",
            errors: [{ field: "url", detail: "Tiene que empezar por ws:// o wss://" }],
          });
        throw new Error("Sin conexión con la API");
      },
    });
    show("/p/p1/channels");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo canal" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getAllByRole("textbox")[0]!, { target: { value: "chat" } });
    fireEvent.change(dialog.getAllByRole("textbox")[1]!, { target: { value: "http://x" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    expect(await dialog.findByText("Tiene que empezar por ws:// o wss://")).toBeTruthy();
    expect(dialog.queryByText("Revisa los campos")).toBeNull();

    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    expect(await dialog.findByText("Sin conexión con la API")).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("la sesión que se sigue", () => {
  test("sin ?s= se sigue la que sigue viva; las anteriores dicen cómo acabaron y se abren", async () => {
    const past = [
      session({ id: "s1" }),
      session({ id: "s2", status: "closed", verdict: { ok: true, failure: null, assertions: [] } }),
      session({ id: "s3", status: "error" }),
      session({ id: "s4", status: "closed", verdict: { ok: false, failure: "check", assertions: [] } }),
      session({ id: "s5", status: "closed", verdict: null }),
    ];
    serve({
      detail: { ...channel(), sessions: past },
      override: (path) => {
        if (path.endsWith("/sessions/s4"))
          return session({ id: "s4", status: "closed", live: false, messages: [msg(1, { body: "de la cuarta" })] });
        return undefined;
      },
    });
    show();
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s1`));
    expect(await screen.findByText("Sesiones anteriores (5)")).toBeTruthy();
    const rows = screen.getAllByRole("button", { name: /·/ }).map((button) => button.textContent!.split(" · ")[1]);
    expect(rows).toEqual(["abierta", "en verde", "no llegó a abrir", "en rojo", "en rojo"]);
    expect(screen.getAllByRole("button", { name: /· abierta$/ })[0]!.className).toContain("font-semibold");

    fireEvent.click(screen.getByRole("button", { name: /· no llegó a abrir$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /· en rojo$/ })[0]!);
    expect(await screen.findByText("de la cuarta")).toBeTruthy();
  });

  test("cambiar de sesión a mitad de lectura no pinta la vieja ni avisa de su fallo", async () => {
    const first = deferred<ChannelSessionView>();
    const second = deferred<ChannelSessionView>();
    serve({
      detail: {
        ...channel(),
        sessions: [
          session({ id: "s1", status: "closed" }),
          session({ id: "s2", status: "closed" }),
          session({ id: "s3", status: "closed" }),
        ],
      },
      override: (path) => {
        if (path.endsWith("/sessions/s1")) return first.promise;
        if (path.endsWith("/sessions/s2")) return second.promise;
        if (path.endsWith("/sessions/s3"))
          return session({ id: "s3", status: "closed", live: false, messages: [msg(1, { body: "la buena" })] });
        return undefined;
      },
    });
    show("/p/p1/channels?c=c1&s=s1");
    const buttons = await screen.findAllByRole("button", { name: /· en rojo$/ });
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s2`));
    fireEvent.click(buttons[2]!);
    expect(await screen.findByText("la buena")).toBeTruthy();

    first.resolve(session({ id: "s1", status: "closed", messages: [msg(1, { body: "la vieja" })] }));
    second.reject(new Error("La lectura de la segunda falló"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("la vieja")).toBeNull();
    expect(screen.queryByText("La lectura de la segunda falló")).toBeNull();
  });

  test("un fallo al leer la sesión se dice, y también uno que no es un Error", async () => {
    serve({
      override: (path) => {
        if (path.endsWith("/sessions/s1")) throw new Error("Esa sesión no existe");
        return undefined;
      },
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("Esa sesión no existe")).toBeTruthy();
  });

  test("un stream que se corta con algo que no es un Error se dice tal cual", async () => {
    serve();
    stream.mockImplementation(() => Promise.reject("se cortó el stream"));
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("se cortó el stream")).toBeTruthy();
  });

  test("sin mensajes en la lectura ni en la instantánea; al terminar se relee con el veredicto", async () => {
    let reads = 0;
    serve({
      override: (path) => {
        if (!path.endsWith("/sessions/s1")) return undefined;
        reads += 1;
        if (reads === 1) return { ...session(), messages: undefined };
        return session({
          status: "closed",
          live: false,
          verdict: { ok: true, failure: null, assertions: [{ label: "Conexión", pass: true, detail: "abierta" }] },
          messages: [msg(1, { body: "la última" })],
        });
      },
    });
    let finish = () => {};
    stream.mockImplementation(
      async (_path: string, handlers: { onEvent: (event: { type: string; data: unknown }) => void }) => {
        handlers.onEvent({ type: "snapshot", data: { ...session(), messages: undefined } });
        handlers.onEvent({ type: "ping", data: null });
        finish = () => handlers.onEvent({ type: "finished", data: null });
      },
    );
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("Sin mensajes todavía.")).toBeTruthy();
    finish();
    expect(await screen.findByText("la última")).toBeTruthy();
    expect(screen.getByText("Conexión")).toBeTruthy();
    expect(reads).toBe(2);
  });

  test("una relectura final sin mensajes deja la conversación vacía", async () => {
    let reads = 0;
    serve({
      override: (path) => {
        if (!path.endsWith("/sessions/s1")) return undefined;
        reads += 1;
        if (reads === 1) return session({ messages: [msg(1, { body: "de paso" })] });
        return { ...session({ status: "closed", live: false }), messages: undefined };
      },
    });
    let finish = () => {};
    stream.mockImplementation(
      async (_path: string, handlers: { onEvent: (event: { type: string; data: unknown }) => void }) => {
        finish = () => handlers.onEvent({ type: "finished", data: null });
      },
    );
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("de paso")).toBeTruthy();
    finish();
    expect(await screen.findByText("Sin mensajes todavía.")).toBeTruthy();
    expect(screen.queryByText("de paso")).toBeNull();
  });

  test("al final de la conversación se desplaza, donde el navegador sabe hacerlo", async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
    try {
      serve({
        override: (path) =>
          path.endsWith("/sessions/s1") ? session({ messages: [msg(1, { body: "hola" })] }) : undefined,
      });
      show("/p/p1/channels?c=c1&s=s1");
      expect(await screen.findByText("hola")).toBeTruthy();
      expect(scroll).toHaveBeenCalledWith({ block: "end" });
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("los botones de la conversación", () => {
  test("sin entorno conecta sin él, y lo dice; un fallo al conectar se dice; mientras conecta también", async () => {
    let attempt = 0;
    serve({
      environments: [],
      override: (path, method) => {
        if (!path.endsWith("/c1/sessions") || method !== "POST") return undefined;
        attempt += 1;
        if (attempt === 1) throw new Error("No se pudo abrir");
        return new Promise(() => {});
      },
    });
    show();
    expect(await screen.findByText(/sin entorno: una URL con \{\{variables\}\}/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    expect(await screen.findByText("No se pudo abrir")).toBeTruthy();
    expect(call).toHaveBeenCalledWith(`${ROOT}/channels/c1/sessions`, { method: "POST", body: {} });
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    expect(await screen.findByRole("button", { name: "Conectando…" })).toBeTruthy();
  });

  test("gRPC: invocar dice «Invocando…» mientras tanto", async () => {
    serve({
      channels: [channel({ protocol: "grpc", name: "tienda" })],
      override: (path, method) =>
        path.endsWith("/c1/sessions") && method === "POST" ? new Promise(() => {}) : undefined,
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Invocar" }));
    expect(await screen.findByRole("button", { name: "Invocando…" })).toBeTruthy();
  });

  test("gRPC en curso: Ctrl+Enter manda, terminar el envío y cancelar la llamada, y sus fallos", async () => {
    let fail = false;
    serve({
      channels: [channel({ protocol: "grpc", name: "tienda" })],
      override: (path, method) => {
        if (method !== "POST") return undefined;
        if (fail) throw new Error(`Falló ${path.split("/").pop()}`);
        return {};
      },
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("En curso")).toBeTruthy();
    const box = screen.getByLabelText("Mensaje") as HTMLTextAreaElement;
    expect(box.placeholder).toMatch(/JSON del tipo de entrada/);

    fireEvent.change(box, { target: { value: '{"id":1}' } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "a", ctrlKey: true });
    expect(posted("/messages")).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s1/messages`, {
        method: "POST",
        body: { text: '{"id":1}' },
      }),
    );
    await waitFor(() => expect(box.value).toBe(""));
    // Sin borrador, Ctrl+Enter no manda nada.
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(posted("/messages")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Terminar envío" }));
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar llamada" }));
    await waitFor(() => expect(posted("/close")).toHaveLength(1));

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Terminar envío" }));
    expect(await screen.findByText("Falló end")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar llamada" }));
    expect(await screen.findByText("Falló close")).toBeTruthy();
    fireEvent.change(box, { target: { value: "otra" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(await screen.findByText("Falló messages")).toBeTruthy();
  });

  test("una sesión abierta en otra instancia se lee pero no se usa", async () => {
    serve({ override: (path) => (path.endsWith("/sessions/s1") ? session({ live: false }) : undefined) });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText(/no contesta: se puede leer, pero no seguir ni usar/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(screen.queryByLabelText("Mensaje")).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  test("WebSocket: texto a secas, desconectar, y sus fallos", async () => {
    let fail = false;
    serve({
      override: (path, method) => {
        if (method !== "POST") return undefined;
        if (fail) throw new Error(`Falló ${path.split("/").pop()}`);
        return {};
      },
    });
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Mensaje"), { target: { value: "hola" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s1/messages`, {
        method: "POST",
        body: { text: "hola" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(posted("/close")).toHaveLength(1));
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    expect(await screen.findByText("Falló close")).toBeTruthy();
  });

  test("base64: lo que no es base64 no se manda; con {{variables}} no se mira", async () => {
    serve();
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Tipo de trama"), { target: { value: "base64" } });
    const box = screen.getByLabelText("Mensaje");
    const enviar = screen.getByRole("button", { name: "Enviar" });
    fireEvent.change(box, { target: { value: "a" } });
    expect(screen.getByText("No es base64")).toBeTruthy();
    expect(enviar.hasAttribute("disabled")).toBe(true);
    fireEvent.change(box, { target: { value: "no es!" } });
    expect(screen.getByText("No es base64")).toBeTruthy();
    fireEvent.change(box, { target: { value: "{{bytes}}" } });
    expect(screen.queryByText("No es base64")).toBeNull();
    fireEvent.change(box, { target: { value: "AAEC/w==" } });
    expect(screen.queryByText("No es base64")).toBeNull();
    fireEvent.click(enviar);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s1/messages`, {
        method: "POST",
        body: { text: "AAEC/w==", encoding: "base64" },
      }),
    );
  });

  test("MQTT sin ajustes guardados publica como 3.1.1", async () => {
    serve({
      channels: [
        channel({ protocol: "mqtt", name: "sensores", messages: [{ name: "sin tema", body: "1" }], mqtt: null }),
      ],
    });
    show("/p/p1/channels?c=c1&s=s1");
    // Una trama guardada sin tema deja el tema como estaba.
    fireEvent.click(await screen.findByRole("button", { name: "sin tema" }));
    fireEvent.change(screen.getByLabelText("Tema"), { target: { value: "casa/luz" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s1/messages`, {
        method: "POST",
        body: expect.objectContaining({ text: "1", topic: "casa/luz" }),
      }),
    );
  });

  test("MQTT: un fallo al suscribirse se dice", async () => {
    serve({
      channels: [channel({ protocol: "mqtt", name: "sensores", mqtt: null })],
      override: (path, method) => {
        if (method === "POST" && path.endsWith("/subscribe")) throw new Error("Filtro rechazado");
        return undefined;
      },
    });
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Filtro"), { target: { value: "casa/#" } });
    fireEvent.click(screen.getByRole("button", { name: "Suscribir" }));
    expect(await screen.findByText("Filtro rechazado")).toBeTruthy();
    expect(call).toHaveBeenCalledWith(`${ROOT}/channels/sessions/s1/subscribe`, {
      method: "POST",
      body: expect.objectContaining({ topic: "casa/#" }),
    });
  });

  test("Socket.IO: una trama guardada sin evento deja el evento como estaba", async () => {
    serve({ channels: [channel({ protocol: "socketio", name: "chat", messages: [{ name: "hola", body: "hola" }] })] });
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Evento"), { target: { value: "saludo" } });
    fireEvent.click(screen.getByRole("button", { name: "hola" }));
    expect((screen.getByLabelText("Evento") as HTMLInputElement).value).toBe("saludo");
    expect((screen.getByLabelText("Mensaje") as HTMLTextAreaElement).value).toBe("hola");
  });
});

describe("la conversación", () => {
  test("cada fila dice qué es: error, evento, binario, recortado; y un filtro sin nada lo dice", async () => {
    serve({
      override: (path) =>
        path.endsWith("/sessions/s1")
          ? session({
              status: "closed",
              live: false,
              messages: [
                msg(1, { direction: "error", body: "reventó" }),
                msg(2, { direction: "event", body: "suscrito" }),
                msg(3, { kind: "binary", bytes: 4, body: "AAEC/w==" }),
                msg(4, { truncated: true, bytes: 70_000, body: "largo" }),
              ],
            })
          : undefined,
    });
    show("/p/p1/channels?c=c1&s=s1");
    const failed = (await screen.findByText("reventó")).closest("li")!;
    expect(failed.className).toContain("bg-rose-50");
    expect(within(failed).getByText("error")).toBeTruthy();
    expect(within(screen.getByText("suscrito").closest("li")!).getByText("evento")).toBeTruthy();
    expect(screen.getByText("binario · 4 B")).toBeTruthy();
    expect(screen.getByText(/recortado: llegaron 70.000 bytes/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Buscar en la conversación"), { target: { value: "nada de esto" } });
    expect(screen.getByText("Ningún mensaje pasa el filtro.")).toBeTruthy();
  });

  test("la cabecera de una sesión cerrada: el código de cierre, y en gRPC un estado desconocido", async () => {
    serve({
      override: (path) =>
        path.endsWith("/sessions/s1") ? session({ status: "closed", live: false, closeCode: 1006 }) : undefined,
    });
    const { unmount } = show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText(/· cierre 1006$/)).toBeTruthy();
    unmount();

    serve({
      override: (path) =>
        path.endsWith("/sessions/s1")
          ? session({ status: "closed", live: false, closeCode: 1000, closeReason: "adiós" })
          : undefined,
    });
    const again = show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText(/· cierre 1000 «adiós»$/)).toBeTruthy();
    again.unmount();

    serve({
      channels: [channel({ protocol: "grpc", name: "tienda" })],
      override: (path) =>
        path.endsWith("/sessions/s1")
          ? session({ status: "closed", live: false, closeCode: 99, trailers: {} })
          : undefined,
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText(/estado desconocido \(99\)$/)).toBeTruthy();
    expect(screen.queryByLabelText("Trailers")).toBeNull();
  });

  test("la biblioteca: sustituye la del mismo nombre, se cancela, y llena no deja guardar", async () => {
    const full = Array.from({ length: 30 }, (_, index) => ({ name: `t${index}`, body: String(index) }));
    serve({
      detail: { ...channel({ messages: full }), sessions: [] },
      override: (path, method) => {
        if (method === "PATCH") throw new Error("No se pudo guardar la trama");
        return undefined;
      },
    });
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Mensaje"), { target: { value: "nuevo" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar en la biblioteca" }));
    fireEvent.change(screen.getByLabelText("Nombre de la trama"), { target: { value: "otra" } });
    expect(screen.getByText(/La biblioteca ya tiene 30 tramas/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar" }).hasAttribute("disabled")).toBe(true);

    // Con el nombre de una que ya está, se sustituye: cabe.
    fireEvent.change(screen.getByLabelText("Nombre de la trama"), { target: { value: " t3 " } });
    fireEvent.click(screen.getByRole("button", { name: "Sustituir" }));
    expect(await screen.findByText("No se pudo guardar la trama")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByLabelText("Nombre de la trama")).toBeNull();
  });
});

describe("la configuración", () => {
  const patched = () => call.mock.calls.filter(([, options]) => options?.method === "PATCH");

  test("WebSocket: cada campo viaja en el PATCH; los fallos por campo y el general se dicen", async () => {
    let attempt = 0;
    serve({
      channels: [
        channel({
          url: "ws://localhost:8080/eco",
          subprotocols: ["v1"],
          auth: { type: "bearer", params: { token: "{{token}}" } },
          expectations: { minMessages: 2, closeCode: 1000 },
          messages: [{ name: "auth", body: "x" }],
        }),
      ],
      override: (_path, method) => {
        if (method !== "PATCH") return undefined;
        attempt += 1;
        if (attempt === 1)
          throw new ApiError(422, {
            type: "about:blank",
            title: "Inválido",
            status: 422,
            detail: "Revisa los campos",
            errors: [{ field: "auth.token", detail: "Una credencial va como {{variable}}" }],
          });
        if (attempt === 2) throw new Error("Sin conexión con la API");
        return channel();
      },
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    // Contra localhost un ws:// no avisa.
    expect(screen.queryByText(/va sin cifrar/)).toBeNull();
    expect((screen.getByLabelText(/^Mensajes que tienen que llegar/) as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText(/^Código de cierre esperado/) as HTMLInputElement).value).toBe("1000");

    fireEvent.change(screen.getByLabelText(/^Nombre$/), { target: { value: "eco2" } });
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: "wss://eco.example.test" } });
    fireEvent.change(screen.getByLabelText(/^Subprotocolos/), { target: { value: "graphql-ws, , v1" } });
    fireEvent.change(screen.getByLabelText(/^Mensajes$/), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/^Mensajes que tienen que llegar/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/^Código de cierre esperado/), { target: { value: "1001" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir trama" }));
    fireEvent.change(screen.getByLabelText("Nombre de la trama 2"), { target: { value: "sobra" } });
    // Editar una no toca la otra.
    fireEvent.change(screen.getByLabelText("Nombre de la trama 1"), { target: { value: "login" } });
    fireEvent.change(screen.getByLabelText("Cuerpo de la trama 1"), { target: { value: '{"u":1}' } });
    expect((screen.getByLabelText("Nombre de la trama 2") as HTMLInputElement).value).toBe("sobra");
    expect((screen.getByLabelText("Cuerpo de la trama 2") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[1]!);
    expect(screen.queryByLabelText("Nombre de la trama 2")).toBeNull();
    // Una trama sin nombre no se guarda.
    fireEvent.click(screen.getByRole("button", { name: "Añadir trama" }));

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Una credencial va como {{variable}}")).toBeTruthy();
    expect(screen.queryByText("Revisa los campos")).toBeNull();
    expect(patched()[0]).toEqual([
      `${ROOT}/channels/c1`,
      {
        method: "PATCH",
        body: expect.objectContaining({
          name: "eco2",
          url: "wss://eco.example.test",
          subprotocols: ["graphql-ws", "v1"],
          auth: { type: "bearer", params: { token: "{{token}}" } },
          limits: expect.objectContaining({ maxMessages: 50 }),
          expectations: { minMessages: undefined, closeCode: 1001 },
          messages: [{ name: "login", body: '{"u":1}' }],
        }),
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Sin conexión con la API")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Canal guardado")).toBeTruthy();
  });

  test("eliminar pide confirmación; cancelar no borra, un fallo se dice, y al borrar se vuelve a la lista", async () => {
    let attempt = 0;
    serve({
      override: (_path, method) => {
        if (method !== "DELETE") return undefined;
        attempt += 1;
        if (attempt === 1) throw new Error("No se pudo eliminar");
        return {};
      },
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    fireEvent.click(await screen.findByRole("button", { name: "Eliminar canal" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(call).not.toHaveBeenCalledWith(`${ROOT}/channels/c1`, { method: "DELETE" });

    fireEvent.click(screen.getByRole("button", { name: "Eliminar canal" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("No se pudo eliminar")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("Elige un canal para conectarte a él")).toBeTruthy();
    expect(call).toHaveBeenCalledWith(`${ROOT}/channels/c1`, { method: "DELETE" });
  });

  test("Socket.IO: una trama sin evento lo deja vacío, y editar el de una no toca el de otra", async () => {
    serve({
      channels: [
        channel({
          protocol: "socketio",
          name: "chat",
          url: "https://chat.example.test",
          messages: [
            { name: "hola", body: "1" },
            { name: "adiós", body: "2", event: "bye" },
          ],
        }),
      ],
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    const first = (await screen.findByLabelText("Evento de la trama 1")) as HTMLInputElement;
    expect(first.value).toBe("");
    fireEvent.change(first, { target: { value: "saludo" } });
    expect((screen.getByLabelText("Evento de la trama 2") as HTMLInputElement).value).toBe("bye");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(patched()[0]?.[1]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            messages: [
              { name: "hola", body: "1", event: "saludo" },
              { name: "adiós", body: "2", event: "bye" },
            ],
          }),
        }),
      ),
    );
  });

  test("MQTT sin entorno: la configuración se abre igual", async () => {
    serve({
      environments: [],
      channels: [channel({ protocol: "mqtt", name: "sensores", url: "mqtts://broker.example.test" })],
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    expect(await screen.findByLabelText("Broker")).toBeTruthy();
  });

  test("gRPC: un grpc:// ajeno avisa con su esquema, y el estado esperado se edita", async () => {
    serve({
      channels: [
        channel({
          protocol: "grpc",
          name: "tienda",
          url: "grpc://api.ejemplo.com:50051",
          grpc: { source: "proto", service: "demo.v1.Shop", method: "GetItem", message: "{}", deadlineMs: null },
        }),
      ],
      override: (path) => (path.endsWith("/grpc") ? { files: [], services: [], problem: null } : undefined),
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    const warning = await screen.findByText(/va sin cifrar/);
    expect(within(warning).getByText("grpc://")).toBeTruthy();
    expect(within(warning).getByText("grpcs://")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Estado esperado/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(patched()[0]?.[1]).toEqual(
        expect.objectContaining({
          body: expect.objectContaining({ expectations: { minMessages: undefined, status: 5 } }),
        }),
      ),
    );
  });
});
