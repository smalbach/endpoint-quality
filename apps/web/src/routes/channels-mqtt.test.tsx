/**
 * Un canal MQTT en la pantalla de canales.
 *
 * Lo que decide algo:
 *
 * - **Crear pide el protocolo**, y solo entonces lo manda: un WebSocket se sigue creando igual.
 * - **La configuración es la de MQTT**: broker, versión, id de cliente, keepalive, sesión limpia,
 *   usuario y contraseña, y las suscripciones con su QoS — sin subprotocolos ni cabeceras.
 * - **Publicar pide un tema** sin comodines, y manda tema, QoS y retain con el cuerpo.
 * - **La transcripción enseña el tema** de cada mensaje, y si venía retenido.
 * - **Suscribirse a mitad de sesión** es una barra aparte, y lo que contesta el broker llega como
 *   evento a la conversación; las propiedades de MQTT 5 se ven debajo del cuerpo.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChannelsPage } from "@/routes/channels";
import { ToastProvider } from "@/components/toast";
import type { ChannelMessageView, ChannelSessionView, ChannelView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
const stream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call, streamRun: stream }));
vi.mock("@/lib/auth", () => ({ useOrganization: () => ({ id: "o", name: "Org" }), useCan: () => true }));

const channel = (patch: Partial<ChannelView> = {}): ChannelView => ({
  id: "c1",
  protocol: "mqtt",
  name: "sensores",
  url: "mqtts://broker.example.test:8883",
  subprotocols: [],
  headers: [],
  auth: { type: "basic", params: { username: "sensor", password: "{{mqttPass}}" } },
  limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
  expectations: {},
  messages: [{ name: "encender", body: '{"on":true}', topic: "luces/sala" }],
  mqtt: {
    version: 4,
    clientId: "",
    keepaliveSec: 60,
    cleanSession: true,
    subscriptions: [{ topic: "casa/#", qos: 1 }],
    will: null,
    userProperties: [],
  },
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
  handshake: { status: 0, headers: {}, via: "CONNACK" },
  counters: { sent: 0, received: 1, bytesIn: 8, bytesOut: 0 },
  closeCode: null,
  closeReason: "",
  trailers: null,
  stopReason: null,
  verdict: null,
  openedAt: "2026-03-01T10:00:00.000Z",
  closedAt: null,
  live: true,
  messages: [msg(0, { body: '{"t":21}', topic: "casa/sala/temp", qos: 1, retain: true })],
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

describe("un canal MQTT en la pantalla", () => {
  test("se crea eligiendo MQTT, y el protocolo viaja en el cuerpo", async () => {
    answers([]);
    show("/p/p1/channels");
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo canal" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Protocolo"), { target: { value: "mqtt" } });
    fireEvent.change(dialog.getByLabelText("Nombre"), { target: { value: "sensores" } });
    fireEvent.change(dialog.getByLabelText("URL"), { target: { value: "{{broker}}" } });
    fireEvent.click(dialog.getByRole("button", { name: "Crear" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels", {
        method: "POST",
        body: { protocol: "mqtt", name: "sensores", url: "{{broker}}" },
      }),
    );
  });

  test("la configuración es la de MQTT, y guarda suscripciones, versión y credencial", async () => {
    answers();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    expect(await screen.findByLabelText("Broker")).toBeTruthy();
    // Nada del upgrade de un WebSocket.
    expect(screen.queryByText("Subprotocolos")).toBeNull();
    expect(screen.queryByText("Código de cierre esperado")).toBeNull();

    fireEvent.change(screen.getByLabelText("Versión"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/^Id de cliente/), { target: { value: "panel-{{env}}" } });
    fireEvent.click(screen.getByLabelText("Sesión limpia"));
    fireEvent.click(screen.getByRole("button", { name: "Añadir suscripción" }));
    fireEvent.change(screen.getByLabelText("Tema de la suscripción 2"), { target: { value: "alarmas/#" } });
    fireEvent.change(screen.getByLabelText("QoS de la suscripción 2"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(call.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
    const [, options] = call.mock.calls.find(([, options]) => options?.method === "PATCH")!;
    expect(options.body.mqtt).toEqual({
      version: 5,
      clientId: "panel-{{env}}",
      keepaliveSec: 60,
      cleanSession: false,
      subscriptions: [
        { topic: "casa/#", qos: 1 },
        { topic: "alarmas/#", qos: 2 },
      ],
      will: null,
      userProperties: [],
    });
    expect(options.body.auth).toEqual({ type: "basic", params: { username: "sensor", password: "{{mqttPass}}" } });
    expect(options.body).not.toHaveProperty("subprotocols");
  });

  test("un mqtt:// contra un broker ajeno avisa de que va en claro", async () => {
    answers([channel({ url: "mqtt://broker.example.test" })]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    expect(await screen.findByText(/va sin cifrar/)).toBeTruthy();
  });

  test("la transcripción enseña el tema, y publicar pide uno sin comodines", async () => {
    answers();
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("casa/sala/temp · QoS 1 · retenido")).toBeTruthy();
    expect(screen.getByText(/CONNACK 0/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Mensaje"), { target: { value: '{"on":false}' } });
    const enviar = screen.getByRole("button", { name: "Enviar" });
    expect(enviar.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Tema"), { target: { value: "luces/+" } });
    expect(screen.getByText(/sin comodines/)).toBeTruthy();
    expect(enviar.hasAttribute("disabled")).toBe(true);

    // Un mensaje guardado trae su tema.
    fireEvent.click(screen.getByRole("button", { name: "encender" }));
    expect((screen.getByLabelText("Tema") as HTMLInputElement).value).toBe("luces/sala");
    fireEvent.change(screen.getByLabelText("QoS"), { target: { value: "1" } });
    fireEvent.click(screen.getByLabelText("Retener"));
    fireEvent.click(enviar);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/sessions/s1/messages", {
        method: "POST",
        body: { text: '{"on":true}', topic: "luces/sala", qos: 1, retain: true },
      }),
    );
  });

  test("suscribirse a mitad de sesión pide un filtro válido, y el evento sale en la conversación", async () => {
    answers();
    call.mockImplementation(async (path: string) => {
      if (path.endsWith("/environments")) return [{ id: "env-1", name: "staging", active: true, variables: {} }];
      if (path.endsWith("/channels")) return { channels: [channel()] };
      if (/\/channels\/c\d$/.test(path)) return { ...channel(), sessions: [] };
      if (/\/channels\/sessions\/s\d$/.test(path))
        return session({
          messages: [
            msg(0, { direction: "event", body: "suscrito a jardin/# (QoS 1)", topic: "jardin/#", qos: 1 }),
            msg(1, {
              body: "hola",
              topic: "jardin/riego",
              properties: {
                userProperties: [["traza", "abc"]],
                correlationData: "00ff",
                correlationEncoding: "hex",
              },
            }),
          ],
        });
      return {};
    });
    show("/p/p1/channels?c=c1&s=s1");
    expect(await screen.findByText("suscrito a jardin/# (QoS 1)")).toBeTruthy();
    expect(screen.getByText("evento")).toBeTruthy();
    const properties = within(screen.getByLabelText("Propiedades"));
    expect(properties.getByText("traza")).toBeTruthy();
    expect(properties.getByText("correlación (hex)")).toBeTruthy();
    expect(properties.getByText("00ff")).toBeTruthy();

    const suscribir = screen.getByRole("button", { name: "Suscribir" });
    fireEvent.change(screen.getByLabelText("Filtro"), { target: { value: "alarmas/#/x" } });
    expect(screen.getByText(/# va solo/)).toBeTruthy();
    expect(suscribir.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Filtro"), { target: { value: "alarmas/#" } });
    fireEvent.change(screen.getByLabelText("QoS de la suscripción"), { target: { value: "2" } });
    fireEvent.click(suscribir);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/sessions/s1/subscribe", {
        method: "POST",
        body: { topic: "alarmas/#", qos: 2 },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/sessions/s1/unsubscribe", {
        method: "POST",
        body: { topic: "alarmas/#", qos: undefined },
      }),
    );
  });

  test("en 5.0 se publica con propiedades de usuario, y en 3.1.1 ni se enseñan", async () => {
    const five = channel({ mqtt: { ...channel().mqtt!, version: 5 } });
    answers([five]);
    show("/p/p1/channels?c=c1&s=s1");
    fireEvent.click(await screen.findByRole("button", { name: "Añadir propiedad" }));
    fireEvent.change(screen.getByLabelText("Nombre de la propiedad 1"), { target: { value: "traza" } });
    fireEvent.change(screen.getByLabelText("Valor de la propiedad 1"), { target: { value: "{{id}}" } });
    fireEvent.change(screen.getByLabelText("Tema"), { target: { value: "luces/sala" } });
    fireEvent.change(screen.getByLabelText("Mensaje"), { target: { value: "on" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/sessions/s1/messages", {
        method: "POST",
        body: {
          text: "on",
          topic: "luces/sala",
          qos: 0,
          retain: false,
          userProperties: [{ name: "traza", value: "{{id}}" }],
        },
      }),
    );
  });

  test("el testamento se configura con su tema, cuerpo, QoS y retain", async () => {
    answers();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Configuración" }));
    // En 3.1.1 no hay propiedades de usuario que poner.
    expect(screen.queryByText("Propiedades de usuario al conectar")).toBeNull();
    fireEvent.click(await screen.findByLabelText("Testamento (Last Will)"));
    fireEvent.change(screen.getByPlaceholderText("dispositivos/{{id}}/estado"), {
      target: { value: "estado/panel" },
    });
    fireEvent.change(screen.getByLabelText("Cuerpo"), { target: { value: "caído" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(call.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
    const [, options] = call.mock.calls.find(([, options]) => options?.method === "PATCH")!;
    expect(options.body.mqtt.will).toEqual({ topic: "estado/panel", payload: "caído", qos: 0, retain: false });
  });
});
