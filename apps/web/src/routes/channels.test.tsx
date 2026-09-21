/**
 * La pantalla de canales.
 *
 * Lo que decide algo:
 *
 * - **Conectar abre contra el entorno activo**, el mismo que usa el editor de peticiones, y lo dice.
 * - **Recargar no cierra la conversación**: con `?s=` se lee la sesión entera y, si terminó, se
 *   enseña su veredicto y por qué se paró —en palabras—.
 * - **Cada mensaje una vez**: lo que llega por el stream y ya estaba en la instantánea no se repite.
 * - **Quien solo lee no conecta ni manda**, y un `ws://` contra un servidor ajeno avisa de que va en
 *   claro.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChannelsPage } from "@/routes/channels";
import { ToastProvider } from "@/components/toast";
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
  archivedAt: null,
  deletedAt: null,
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

type Answers = { channels?: ChannelView[]; detail?: ChannelDetailView; session?: ChannelSessionView };

function answers({ channels = [channel()], detail, session: current }: Answers = {}) {
  call.mockReset();
  stream.mockReset();
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? "GET";
    if (path.endsWith("/environments")) return [{ id: "env-1", name: "staging", active: true, variables: {} }];
    if (path.endsWith("/channels") && method === "GET") return { channels };
    if (path.endsWith("/channels") && method === "POST") return channel({ id: "c2", ...(options?.body as object) });
    if (/\/channels\/c\d$/.test(path) && method === "GET") return detail ?? { ...channels[0], sessions: [] };
    if (path.endsWith("/sessions") && method === "POST") return session();
    if (/\/channels\/sessions\/s\d$/.test(path)) return current ?? session();
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
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("la pantalla de canales", () => {
  test("un canal nuevo se crea con nombre y URL, y queda abierto", async () => {
    can.edit = true;
    answers({ channels: [] });
    show("/p/p1/channels");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo canal" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getAllByRole("textbox")[0], { target: { value: "chat" } });
    fireEvent.change(dialog.getAllByRole("textbox")[1], { target: { value: "{{wsBase}}/chat" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels", {
        method: "POST",
        body: { name: "chat", url: "{{wsBase}}/chat" },
      }),
    );
  });

  test("conectar abre contra el entorno activo, y lo dice", async () => {
    can.edit = true;
    answers();
    show();
    expect(await screen.findByText("staging")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Conectar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1/sessions", {
        method: "POST",
        body: { environmentId: "env-1" },
      }),
    );
  });

  test("una sesión terminada se lee entera, con su veredicto y el motivo en palabras", async () => {
    can.edit = true;
    answers({
      session: session({
        status: "closed",
        live: false,
        stopReason: "idle-cap",
        closeCode: 1000,
        verdict: {
          ok: false,
          failure: "check",
          assertions: [
            { label: "Conexión", pass: true, detail: "abierta (101 en el upgrade)" },
            { label: "Al menos 2 mensaje(s)", pass: false, detail: "llegaron 1" },
          ],
        },
        messages: [msg(0, { direction: "open" }), msg(1, { body: '{"type":"welcome"}' })],
      }),
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText(/demasiado tiempo sin mensajes/)).toBeTruthy();
    expect(screen.getByText("Al menos 2 mensaje(s)")).toBeTruthy();
    // El JSON sangrado, y la apertura fuera de la conversación.
    expect(screen.getByText(/"type": "welcome"/)).toBeTruthy();
    // Terminada: no se sigue en vivo.
    expect(stream).not.toHaveBeenCalled();
  });

  test("lo que llega por el stream y ya estaba en la instantánea no se repite", async () => {
    can.edit = true;
    answers({ session: session({ messages: [msg(0, { body: "primero" })] }) });
    stream.mockImplementation(
      async (_path: string, handlers: { onEvent: (event: { type: string; data: unknown }) => void }) => {
        handlers.onEvent({ type: "snapshot", data: session({ messages: [msg(0, { body: "primero" })] }) });
        handlers.onEvent({ type: "message", data: { message: msg(0, { body: "primero" }) } });
        handlers.onEvent({ type: "message", data: { message: msg(1, { body: "segundo" }) } });
      },
    );
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("segundo")).toBeTruthy();
    expect(screen.getAllByText("primero")).toHaveLength(1);
  });

  test("buscar en la conversación deja las filas que casan, y dice cuántas de cuántas", async () => {
    can.edit = true;
    answers({
      session: session({
        status: "closed",
        live: false,
        messages: [
          msg(1, { body: "hola" }),
          msg(2, { direction: "out", body: "suscribir precios" }),
          msg(3, { body: "precio: 12" }),
        ],
      }),
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("hola")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Buscar en la conversación"), { target: { value: "precio" } });
    expect(screen.queryByText("hola")).toBeNull();
    expect(screen.getByText("2 de 3")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Qué mensajes"), { target: { value: "in" } });
    expect(screen.queryByText("suscribir precios")).toBeNull();
    expect(screen.getByText("precio: 12")).toBeTruthy();
  });

  test("el borrador se guarda en la biblioteca con un nombre, por el PATCH del canal", async () => {
    can.edit = true;
    answers({
      detail: { ...channel({ messages: [{ name: "ping", body: '{"type":"ping"}' }] }), sessions: [] },
      session: session(),
    });
    stream.mockImplementation(async () => {});
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Mensaje"), {
      target: { value: '{"type":"auth","token":"{{token}}"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar en la biblioteca" }));
    fireEvent.change(screen.getByLabelText("Nombre de la trama"), { target: { value: "auth" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1", {
        method: "PATCH",
        body: {
          messages: [
            { name: "ping", body: '{"type":"ping"}' },
            { name: "auth", body: '{"type":"auth","token":"{{token}}"}' },
          ],
        },
      }),
    );
  });

  test("una trama binaria se escribe en hexadecimal o base64, y se manda diciendo cuál", async () => {
    can.edit = true;
    answers({ session: session() });
    stream.mockImplementation(async () => {});
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.change(await screen.findByLabelText("Tipo de trama"), { target: { value: "hex" } });
    fireEvent.change(screen.getByLabelText("Mensaje"), { target: { value: "00 0g" } });
    expect(screen.getByText(/pares de 0-9 y a-f/)).toBeTruthy();
    const enviar = screen.getByRole("button", { name: "Enviar" });
    expect(enviar.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Mensaje"), { target: { value: "00 ff" } });
    fireEvent.click(enviar);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/sessions/s1/messages", {
        method: "POST",
        body: { text: "00 ff", encoding: "hex" },
      }),
    );
  });

  test("quien solo lee no conecta ni crea", async () => {
    can.edit = false;
    answers();
    show();
    expect(await screen.findByText("eco", { selector: "h2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nuevo canal" })).toBeNull();
  });

  test("un ws:// contra un servidor ajeno avisa de que va en claro", async () => {
    can.edit = true;
    answers({ channels: [channel({ url: "ws://api.ejemplo.com/socket" })] });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    expect(await screen.findByText(/va sin cifrar/)).toBeTruthy();
  });
});

describe("un canal gRPC", () => {
  const grpcChannel = channel({
    protocol: "grpc",
    name: "tienda",
    url: "grpcs://api.ejemplo.com:443",
    expectations: { status: 0 },
    grpc: { source: "proto", service: "demo.v1.Shop", method: "GetItem", message: "{}", deadlineMs: null },
  });

  test("se crea eligiendo el protocolo, y la URL es la de gRPC", async () => {
    can.edit = true;
    answers({ channels: [] });
    show("/p/p1/channels");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo canal" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByRole("combobox"), { target: { value: "grpc" } });
    fireEvent.change(dialog.getAllByRole("textbox")[0], { target: { value: "tienda" } });
    fireEvent.change(dialog.getAllByRole("textbox")[1], { target: { value: "{{grpcBase}}" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels", {
        method: "POST",
        body: { protocol: "grpc", name: "tienda", url: "{{grpcBase}}" },
      }),
    );
  });

  test("se invoca, y una llamada terminada dice su estado por el nombre y sus trailers", async () => {
    can.edit = true;
    answers({
      channels: [grpcChannel],
      session: session({
        status: "closed",
        closeCode: 5,
        closeReason: "no existe",
        trailers: { "x-region": "eu", "x-session-token": "••••••••", "x-trace-bin": "AAEC/w==" },
        stopReason: "closed-by-peer",
        handshake: { status: 200, headers: {} },
      }),
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText(/estado NOT_FOUND \(5\) «no existe»/)).toBeTruthy();
    expect(screen.queryByText(/upgrade 200/)).toBeNull();
    const trailers = within(screen.getByLabelText("Trailers"));
    expect(trailers.getByText("x-session-token")).toBeTruthy();
    expect(trailers.getByText("x-trace-bin (base64)")).toBeTruthy();
    expect(trailers.getByText("••••••••")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invocar" })).toBeTruthy();
  });

  test("la configuración enseña el método en vez de los subprotocolos, y afirma el estado", async () => {
    can.edit = true;
    answers({ channels: [grpcChannel] });
    call.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path.endsWith("/environments")) return [];
      if (path.endsWith("/channels") && !options?.method) return { channels: [grpcChannel] };
      if (path.endsWith("/channels/c1")) return { ...grpcChannel, sessions: [] };
      if (path.endsWith("/grpc")) return { files: [], services: [], problem: null };
      return grpcChannel;
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    expect(await screen.findByText("Metadata")).toBeTruthy();
    expect(screen.queryByText("Subprotocolos")).toBeNull();
    expect((screen.getByLabelText(/^Estado esperado/) as HTMLInputElement).value).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "/orgs/o/projects/p1/channels/c1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.objectContaining({ expectations: { status: 0 }, grpc: grpcChannel.grpc, subprotocols: [] }),
        }),
      ),
    );
  });
});
