/**
 * Un canal Socket.IO en la pantalla de canales.
 *
 * Lo que decide algo:
 *
 * - **Crear pide el protocolo**, y lo manda.
 * - **La configuración es la de Socket.IO**: ruta, espacio de nombres, versión, carga de `auth`,
 *   query, eventos y transportes, en lugar de los subprotocolos y el código de cierre.
 * - **Emitir pide un evento**; el acuse y los argumentos de más viajan con el cuerpo.
 * - **La transcripción enseña el evento** de cada mensaje, y si es o pide un acuse.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChannelsPage } from "@/routes/channels";
import { ToastProvider } from "@/components/toast";
import { emitBody } from "@/components/socketio-channel";
import type { ChannelMessageView, ChannelSessionView, ChannelView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const stream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call, streamRun: stream }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const channel = (patch: Partial<ChannelView> = {}): ChannelView => ({
  id: "c1",
  protocol: "socketio",
  name: "chat",
  url: "https://chat.example.test",
  subprotocols: [],
  headers: [],
  auth: null,
  limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
  expectations: {},
  messages: [{ name: "saludo", body: '{"texto":"hola"}', event: "chat:mensaje" }],
  mqtt: null,
  grpc: null,
  socketio: {
    version: 4,
    path: "/socket.io",
    namespace: "/",
    auth: '{"token":"{{token}}"}',
    query: [],
    listenAll: true,
    events: [],
    transports: ["websocket"],
  },
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
  handshake: null,
  counters: { sent: 1, received: 2, bytesIn: 8, bytesOut: 4 },
  closeCode: null,
  closeReason: "",
  trailers: null,
  stopReason: null,
  verdict: null,
  openedAt: "2026-03-01T10:00:00.000Z",
  closedAt: null,
  live: true,
  messages: [
    msg(0, { direction: "event", event: "connect", body: "conectado a /" }),
    msg(1, { body: '{"hola":"mundo"}', event: "bienvenida" }),
    msg(2, { direction: "out", body: '{"a":2}', event: "sumar", ack: true }),
    msg(3, { body: '{"total":5}', event: "sumar", ack: true }),
  ],
  ...patch,
});

function answers(channels: ChannelView[] = [channel()]) {
  call.mockReset();
  stream.mockReset();
  stream.mockImplementation(async () => undefined);
  call.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? "GET";
    if (path.endsWith("/environments")) return [{ id: "env-1", name: "staging", active: true, variables: {} }];
    if (path.endsWith("/channels") && method === "GET") return { channels };
    if (path.endsWith("/channels") && method === "POST") return channel({ id: "c2", ...(options?.body as object) });
    if (/\/channels\/c\d$/.test(path) && method === "GET") return { ...channels[0], sessions: [] };
    if (/\/channels\/c\d$/.test(path) && method === "PATCH") return channels[0];
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
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("un canal Socket.IO en la pantalla", () => {
  test("se crea eligiendo Socket.IO, y el protocolo viaja en el cuerpo", async () => {
    answers([]);
    show("/p/p1/channels");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo canal" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Protocolo"), { target: { value: "socketio" } });
    fireEvent.change(dialog.getByLabelText("Nombre"), { target: { value: "chat" } });
    fireEvent.change(dialog.getByLabelText("URL"), { target: { value: "{{sioBase}}" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels", {
        method: "POST",
        body: { protocol: "socketio", name: "chat", url: "{{sioBase}}" },
      }),
    );
  });

  test("la configuración es la de Socket.IO, y guarda ajustes y el evento de cada trama", async () => {
    answers();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    expect(await screen.findByLabelText("Carga de auth")).toBeTruthy();
    expect(screen.queryByText("Subprotocolos")).toBeNull();
    expect(screen.queryByText("Código de cierre esperado")).toBeNull();

    fireEvent.change(screen.getByLabelText("Carga de auth"), { target: { value: "[1]" } });
    expect(screen.getByText(/Un objeto JSON/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Carga de auth"), { target: { value: '{"token":"{{token}}"}' } });
    fireEvent.click(screen.getByLabelText("Todos los eventos"));
    fireEvent.change(screen.getByLabelText("Eventos que se oyen"), { target: { value: "chat, estado," } });
    fireEvent.click(screen.getByLabelText("Sondeo largo (HTTP)"));
    fireEvent.click(screen.getByRole("button", { name: "Añadir parámetro" }));
    fireEvent.change(screen.getByLabelText("Nombre del parámetro 1"), { target: { value: "sala" } });
    fireEvent.change(screen.getByLabelText("Valor del parámetro 1"), { target: { value: "general" } });
    fireEvent.change(screen.getByLabelText("Evento de la trama 1"), { target: { value: "chat:saludo" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(call.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
    const [, options] = call.mock.calls.find(([, options]) => options?.method === "PATCH")!;
    const body = options.body as Record<string, unknown>;
    expect(body.subprotocols).toEqual([]);
    expect(body.expectations).not.toHaveProperty("closeCode");
    expect(body.messages).toEqual([{ name: "saludo", body: '{"texto":"hola"}', event: "chat:saludo" }]);
    expect(body.socketio).toEqual({
      version: 4,
      path: "/socket.io",
      namespace: "/",
      auth: '{"token":"{{token}}"}',
      query: [{ name: "sala", value: "general", enabled: true }],
      listenAll: false,
      events: ["chat", "estado"],
      transports: ["polling", "websocket"],
    });
  });

  test("la transcripción enseña el evento y el acuse, y emitir pide un evento", async () => {
    answers();
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("bienvenida")).toBeTruthy();
    expect(screen.getByText("sumar · pide acuse")).toBeTruthy();
    expect(screen.getByText("sumar · acuse")).toBeTruthy();
    expect(screen.getByText("conectado a /")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Mensaje"), { target: { value: '{"a":1}' } });
    const emitir = screen.getByRole("button", { name: "Emitir" });
    expect(emitir.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Evento"), { target: { value: "connect" } });
    expect(screen.getByText(/lo emite Socket.IO/)).toBeTruthy();
    expect(emitir.hasAttribute("disabled")).toBe(true);

    // Una trama guardada trae su evento.
    fireEvent.click(screen.getByRole("button", { name: "saludo" }));
    expect((screen.getByLabelText("Evento") as HTMLInputElement).value).toBe("chat:mensaje");
    fireEvent.click(screen.getByLabelText("Esperar acuse"));
    fireEvent.click(screen.getByRole("button", { name: "Añadir argumento" }));
    fireEvent.change(screen.getByLabelText("Argumento 2"), { target: { value: "extra" } });
    fireEvent.click(emitir);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/sessions/s1/messages", {
        method: "POST",
        body: {
          text: '{"texto":"hola"}',
          event: "chat:mensaje",
          ack: true,
          args: ['{"texto":"hola"}', "extra"],
        },
      }),
    );
  });

  test("con un solo argumento no viajan `args`; sin cuerpo, el evento va sin argumentos", () => {
    expect(emitBody("hola", { event: " chat ", ack: false, extraArgs: [] })).toEqual({
      text: "hola",
      event: "chat",
      ack: false,
    });
  });
});
