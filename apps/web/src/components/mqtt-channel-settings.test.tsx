/**
 * La configuración de un canal MQTT, montada sola.
 *
 * Lo que decide algo:
 *
 * - **Guardar manda lo que hay en pantalla, limpio**: sin suscripciones, propiedades ni mensajes a
 *   medio escribir; sin propiedades en 3.1.1; sin credencial cuando es «ninguna»; y sin mínimo de
 *   mensajes cuando está vacío.
 * - **Un broker sin cifrar fuera de esta máquina se avisa**, porque la contraseña viaja en claro.
 * - **Los errores de «Guardar» salen junto a su campo**, y uno sin campo, debajo del botón.
 * - **Eliminar pide confirmación**, y un fallo se cuenta.
 * - **Quien solo lee no tiene botones.**
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MqttChannelSettings, plaintextBroker } from "@/components/mqtt-channel-settings";
import { ToastProvider } from "@/components/toast";
import { ApiError } from "@/lib/api";
import type { ChannelView } from "@/lib/types";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));

const channel = (patch: Partial<ChannelView> = {}): ChannelView =>
  ({
    id: "c1",
    protocol: "mqtt",
    name: "sensores",
    url: "mqtts://broker.example.test:8883",
    subprotocols: [],
    headers: [],
    auth: null,
    limits: { maxMessages: 200, maxBytes: 1000, maxMessageBytes: 100, maxDurationMs: 30_000, idleMs: 10_000 },
    expectations: {},
    messages: [],
    mqtt: null,
    grpc: null,
    orderIndex: 0,
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    ...patch,
  }) as ChannelView;

function mount(value: ChannelView = channel(), canEdit = true) {
  const onRemoved = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <ToastProvider>
        <MqttChannelSettings
          base="/orgs/o/projects/p1"
          projectId="p1"
          channel={value}
          variables={["mqttPass"]}
          canEdit={canEdit}
          onRemoved={onRemoved}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onRemoved;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const field = (label: string) =>
  screen.getByText(label, { selector: "span" }).closest("label")!.querySelector("input, select, textarea")!;
const lastBody = () => call.mock.calls.at(-1)![1].body;

describe("la configuración de un canal MQTT", () => {
  test("sin credencial ni ajustes MQTT parte de los valores por omisión, y guarda sin credencial", async () => {
    call.mockReset();
    call.mockResolvedValue(channel());
    mount();
    expect((field("Versión") as HTMLSelectElement).value).toBe("4");
    expect((field("Keepalive (s)") as HTMLInputElement).value).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Canal guardado")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1", expect.objectContaining({ method: "PATCH" }));
    expect(lastBody()).toMatchObject({
      name: "sensores",
      auth: null,
      mqtt: { version: 4, subscriptions: [], userProperties: [], will: null },
      expectations: { minMessages: undefined },
      messages: [],
    });
  });

  test("un broker sin cifrar fuera de esta máquina se avisa; uno local no", () => {
    call.mockReset();
    mount();
    fireEvent.change(field("Broker"), { target: { value: "mqtt://broker.lejano.com" } });
    expect(screen.getByText(/va sin cifrar/)).toBeTruthy();
    fireEvent.change(field("Broker"), { target: { value: "mqtt://localhost:1883" } });
    expect(screen.queryByText(/va sin cifrar/)).toBeNull();
    expect(plaintextBroker("ws://10.0.0.1")).toBe(true);
    expect(plaintextBroker("wss://10.0.0.1")).toBe(false);
  });

  test("todo lo que se toca viaja al guardar, y lo que está a medio escribir se queda fuera", async () => {
    call.mockReset();
    call.mockResolvedValue(channel());
    mount(
      channel({
        auth: { type: "basic", params: { username: "u", password: "{{mqttPass}}" } },
        expectations: { minMessages: 3 },
        messages: [{ name: "encender", body: "on" } as ChannelView["messages"][number]],
      }),
    );
    expect((field("Mensajes que tienen que llegar") as HTMLInputElement).value).toBe("3");
    expect(input("Tema del mensaje 1").value).toBe("");

    fireEvent.change(field("Nombre"), { target: { value: "sala" } });
    fireEvent.change(field("Versión"), { target: { value: "5" } });
    fireEvent.change(field("Id de cliente"), { target: { value: "eq-1" } });
    fireEvent.change(field("Keepalive (s)"), { target: { value: "30" } });
    fireEvent.click(screen.getByLabelText("Sesión limpia"));

    // Dos suscripciones: la primera se rellena, la segunda se deja en blanco y luego se quita otra.
    fireEvent.click(screen.getByRole("button", { name: "Añadir suscripción" }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir suscripción" }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir suscripción" }));
    fireEvent.change(input("Tema de la suscripción 1"), { target: { value: "casa/#" } });
    fireEvent.change(screen.getByLabelText("QoS de la suscripción 1"), { target: { value: "2" } });
    fireEvent.change(input("Tema de la suscripción 3"), { target: { value: "  " } });
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[1]!);
    expect(screen.queryByLabelText("Tema de la suscripción 3")).toBeNull();

    // El testamento: se enciende, se rellena entero.
    fireEvent.click(screen.getByLabelText("Testamento (Last Will)"));
    fireEvent.change(field("Tema"), { target: { value: "dispositivos/1/estado" } });
    fireEvent.change(field("QoS"), { target: { value: "1" } });
    fireEvent.click(screen.getByLabelText("Retener"));
    fireEvent.change(field("Cuerpo"), { target: { value: "offline" } });

    // Propiedades de MQTT 5: una buena y una a medio escribir.
    fireEvent.click(screen.getByRole("button", { name: "Añadir propiedad" }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir propiedad" }));
    fireEvent.change(input("Nombre de la propiedad 1"), { target: { value: "origen" } });
    fireEvent.change(input("Valor de la propiedad 1"), { target: { value: "eq" } });

    fireEvent.change(field("Mensajes"), { target: { value: "50" } });
    fireEvent.change(field("Mensajes que tienen que llegar"), { target: { value: "" } });

    // Mensajes guardados: el primero se edita, uno nuevo se deja sin nombre, otro se quita.
    fireEvent.change(input("Nombre del mensaje 1"), { target: { value: "apagar" } });
    fireEvent.change(input("Tema del mensaje 1"), { target: { value: "luces/sala" } });
    fireEvent.change(input("Cuerpo del mensaje 1"), { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir mensaje" }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir mensaje" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" }).at(-1)!);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(lastBody()).toEqual({
      name: "sala",
      url: "mqtts://broker.example.test:8883",
      mqtt: {
        version: 5,
        clientId: "eq-1",
        keepaliveSec: 30,
        cleanSession: false,
        subscriptions: [{ topic: "casa/#", qos: 2 }],
        will: { topic: "dispositivos/1/estado", payload: "offline", qos: 1, retain: true },
        userProperties: [{ name: "origen", value: "eq" }],
      },
      auth: { type: "basic", params: { username: "u", password: "{{mqttPass}}" } },
      limits: { maxMessages: 50, maxBytes: 1000, maxMessageBytes: 100, maxDurationMs: 30_000, idleMs: 10_000 },
      expectations: { minMessages: undefined },
      messages: [{ name: "apagar", body: "off", topic: "luces/sala" }],
    });
  });

  test("editar un mensaje guardado no toca los demás, y el mínimo de mensajes viaja como número", async () => {
    call.mockReset();
    call.mockResolvedValue(channel());
    mount(
      channel({
        messages: [
          { name: "encender", body: "on", topic: "luces" },
          { name: "apagar", body: "off", topic: "luces" },
        ],
      }),
    );
    fireEvent.change(input("Nombre del mensaje 1"), { target: { value: "prender" } });
    fireEvent.change(input("Tema del mensaje 1"), { target: { value: "luces/sala" } });
    fireEvent.change(input("Cuerpo del mensaje 1"), { target: { value: "ON" } });
    fireEvent.change(field("Mensajes que tienen que llegar"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(lastBody().messages).toEqual([
      { name: "prender", body: "ON", topic: "luces/sala" },
      { name: "apagar", body: "off", topic: "luces" },
    ]);
    expect(lastBody().expectations).toEqual({ minMessages: 7 });
  });

  test("apagar el testamento lo quita", async () => {
    call.mockReset();
    call.mockResolvedValue(channel());
    mount(
      channel({
        mqtt: {
          version: 4,
          clientId: "",
          keepaliveSec: 60,
          cleanSession: true,
          subscriptions: [],
          will: { topic: "t", payload: "", qos: 0, retain: false },
          userProperties: [],
        },
      }),
    );
    fireEvent.click(screen.getByLabelText("Testamento (Last Will)"));
    expect(screen.queryByText("Retener")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(lastBody().mqtt.will).toBeNull();
  });

  test("los errores de «Guardar» salen junto a su campo", async () => {
    call.mockReset();
    call.mockRejectedValue(
      new ApiError(422, {
        type: "about:blank",
        title: "No válido",
        status: 422,
        detail: "Revisa los campos",
        errors: [
          { field: "name", detail: "Falta el nombre" },
          { field: "auth.params.password", detail: "Escríbela como {{variable}}" },
          { field: "mqtt.subscriptions.0.topic", detail: "# va al final" },
          { field: "mqtt.userProperties.0", detail: "Nombre vacío" },
        ],
      }),
    );
    mount(
      channel({
        mqtt: {
          version: 5,
          clientId: "",
          keepaliveSec: 60,
          cleanSession: true,
          subscriptions: [{ topic: "a/#/b", qos: 0 }],
          will: null,
          userProperties: [],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Falta el nombre")).toBeTruthy();
    expect(screen.getByText("Escríbela como {{variable}}")).toBeTruthy();
    expect(screen.getByText("# va al final")).toBeTruthy();
    expect(screen.getByText("Nombre vacío")).toBeTruthy();
    // Con campos, el mensaje general no se repite debajo.
    expect(screen.queryByText("Revisa los campos")).toBeNull();
  });

  test("un error sin campos sale debajo del botón", async () => {
    call.mockReset();
    call.mockRejectedValue(new Error("Sin conexión"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Sin conexión")).toBeTruthy();
  });
});

describe("eliminar el canal", () => {
  test("pide confirmación; cancelar no borra, confirmar borra y avisa", async () => {
    call.mockReset();
    call.mockResolvedValue(undefined);
    const onRemoved = mount();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar canal" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar canal" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith("/orgs/o/projects/p1/channels/c1", { method: "DELETE" });
  });

  test("un fallo al borrar se cuenta, venga como error o como texto", async () => {
    call.mockReset();
    call.mockRejectedValueOnce(new Error("Tiene sesiones abiertas")).mockRejectedValueOnce("prohibido");
    const onRemoved = mount();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar canal" }));
    const confirm = () => within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" });
    fireEvent.click(confirm());
    expect(await screen.findByText("Tiene sesiones abiertas")).toBeTruthy();
    await waitFor(() => expect((confirm() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm());
    expect(await screen.findByText("prohibido")).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe("quien solo lee", () => {
  test("ve la configuración sin poder tocarla ni guardar", () => {
    call.mockReset();
    mount(
      channel({
        mqtt: {
          version: 5,
          clientId: "",
          keepaliveSec: 60,
          cleanSession: true,
          subscriptions: [{ topic: "casa/#", qos: 1 }],
          will: null,
          userProperties: [{ name: "origen", value: "eq" }],
        },
        messages: [{ name: "encender", body: "on", topic: "luces" }],
      }),
      false,
    );
    expect((field("Nombre") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Añadir propiedad" })).toBeNull();
  });
});
