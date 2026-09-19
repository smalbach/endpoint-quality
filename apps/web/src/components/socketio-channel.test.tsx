/**
 * Los ajustes y el envío de un canal Socket.IO, sueltos de la pantalla de canales.
 *
 * Lo que se comprueba: que la carga de `auth` se valida como objeto JSON (y que con `{{variables}}`
 * sin comillas no se da por mala), que ruta, espacio de nombres, versión, parámetros de la query,
 * eventos y transportes escriben lo que dicen —el orden de los transportes es el del servidor—, que
 * los problemas del servidor salen en su sitio, y que el evento que se emite avisa de los reservados
 * y lleva sus argumentos de más.
 */
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  authPayloadHint,
  BLANK_EMIT,
  DEFAULT_SOCKETIO,
  emitBody,
  eventNameHint,
  EventRoute,
  SocketIoEmitFields,
  SocketIoSettingsForm,
  type SocketIoEmitDraft,
} from "@/components/socketio-channel";
import type { ChannelMessageView, SocketIoSettingsView } from "@/lib/types";

function settings(
  initial: Partial<SocketIoSettingsView> = {},
  options: { variables?: string[]; problems?: Record<string, string>; disabled?: boolean } = {},
) {
  let latest: SocketIoSettingsView = { ...DEFAULT_SOCKETIO, ...initial };
  function Harness() {
    const [value, setValue] = useState(latest);
    return (
      <SocketIoSettingsForm
        value={value}
        disabled={options.disabled}
        variables={options.variables ?? []}
        problemOf={(field) => options.problems?.[field]}
        onChange={(next) => {
          latest = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { saved: () => latest };
}

describe("la carga de auth", () => {
  test("vacía no es un problema; un objeto sí vale; una lista o un número no", () => {
    expect(authPayloadHint("  ")).toBeNull();
    expect(authPayloadHint('{"token":"x"}')).toBeNull();
    expect(authPayloadHint("[1]")).toBe('Un objeto JSON: {"token": "…"}');
    expect(authPayloadHint("3")).toBe('Un objeto JSON: {"token": "…"}');
  });

  test("lo que no es JSON lo dice, salvo si lleva variables que aún no se han resuelto", () => {
    expect(authPayloadHint("{roto")).toBe("No es JSON");
    expect(authPayloadHint('{"n": {{numero}}}')).toBeNull();
  });

  test("en el formulario, el problema del servidor gana al de la comprobación local", () => {
    settings({ auth: "{roto" }, { problems: { "socketio.auth": "Carga rechazada" } });
    expect(screen.getByText("Carga rechazada")).toBeDefined();
    expect(screen.queryByText("No es JSON")).toBeNull();
  });

  test("la pista nombra hasta tres variables del entorno", () => {
    settings({}, { variables: ["token", "user", "tenant", "otra"] });
    expect(screen.getByText(/\(token, user, tenant…\)/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Carga de auth"), { target: { value: "roto" } });
    expect(screen.getByText("No es JSON")).toBeDefined();
  });
});

describe("los ajustes", () => {
  test("ruta, espacio de nombres y versión", () => {
    const form = settings();
    fireEvent.change(screen.getByLabelText(/^Ruta/), { target: { value: "/ws" } });
    fireEvent.change(screen.getByLabelText(/^Espacio de nombres/), { target: { value: "/admin" } });
    fireEvent.change(screen.getByLabelText(/^Versión del servidor/), { target: { value: "3" } });
    expect(form.saved()).toMatchObject({ path: "/ws", namespace: "/admin", version: 3 });
  });

  test("los parámetros de la query se añaden, se editan uno a uno, se apagan y se quitan", () => {
    const form = settings({ query: [{ name: "a", value: "1", enabled: true }] });
    fireEvent.click(screen.getByRole("button", { name: "Añadir parámetro" }));
    fireEvent.change(screen.getByLabelText("Nombre del parámetro 2"), { target: { value: "b" } });
    fireEvent.change(screen.getByLabelText("Valor del parámetro 2"), { target: { value: "{{b}}" } });
    fireEvent.click(screen.getByLabelText("Parámetro 2 activo"));
    expect(form.saved().query).toEqual([
      { name: "a", value: "1", enabled: true },
      { name: "b", value: "{{b}}", enabled: false },
    ]);

    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[0]!);
    expect(form.saved().query).toEqual([{ name: "b", value: "{{b}}", enabled: false }]);
  });

  test("sin «Todos los eventos» se escriben los que se oyen, separados por comas", () => {
    const form = settings();
    expect(screen.queryByLabelText("Eventos que se oyen")).toBeNull();
    fireEvent.click(screen.getByLabelText("Todos los eventos"));
    fireEvent.change(screen.getByLabelText("Eventos que se oyen"), { target: { value: "chat, estado" } });
    expect(form.saved()).toMatchObject({ listenAll: false, events: ["chat", "estado"] });
  });

  test("los transportes: encender el sondeo lo pone primero, y apagar WebSocket lo quita", () => {
    const form = settings();
    fireEvent.click(screen.getByLabelText("Sondeo largo (HTTP)"));
    expect(form.saved().transports).toEqual(["polling", "websocket"]);
    fireEvent.click(screen.getByLabelText("WebSocket"));
    expect(form.saved().transports).toEqual(["polling"]);
  });

  test("los problemas de query, eventos y transportes salen debajo de cada uno", () => {
    settings(
      {},
      {
        problems: {
          "socketio.query": "Query repetida",
          "socketio.events": "Evento reservado",
          "socketio.transports": "Hace falta uno",
        },
      },
    );
    expect(screen.getByText("Query repetida")).toBeDefined();
    expect(screen.getByText("Evento reservado")).toBeDefined();
    expect(screen.getByText("Hace falta uno")).toBeDefined();
  });

  test("bloqueado no ofrece añadir ni quitar", () => {
    settings({ query: [{ name: "a", value: "1", enabled: true }] }, { disabled: true });
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Añadir parámetro" })).toBeNull();
  });
});

describe("emitir", () => {
  function emit(initial: SocketIoEmitDraft = BLANK_EMIT) {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState(initial);
      return (
        <SocketIoEmitFields
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    return { last: () => onChange.mock.lastCall![0] as SocketIoEmitDraft };
  }

  test("un evento reservado se señala; uno en blanco no se valida hasta escribirlo", () => {
    expect(eventNameHint(" ")).toBe("Falta el evento");
    // Con un solo argumento no hace falta `args`: el servidor usa `text`.
    expect(emitBody("hola", { event: " chat ", ack: false, extraArgs: [] })).toEqual({
      text: "hola",
      event: "chat",
      ack: false,
    });
    emit();
    fireEvent.change(screen.getByPlaceholderText("chat:mensaje"), { target: { value: "connect" } });
    expect(screen.getByText("«connect» lo emite Socket.IO")).toBeDefined();
  });

  test("los argumentos de más se añaden, se editan uno a uno y se quitan", () => {
    const fields = emit({ event: "chat", ack: false, extraArgs: [] });
    fireEvent.click(screen.getByLabelText("Esperar acuse"));
    fireEvent.click(screen.getByRole("button", { name: "Añadir argumento" }));
    fireEvent.click(screen.getByRole("button", { name: "Añadir argumento" }));
    fireEvent.change(screen.getByLabelText("Argumento 3"), { target: { value: "{}" } });
    expect(fields.last()).toEqual({ event: "chat", ack: true, extraArgs: ["", "{}"] });
    expect(emitBody("hola", fields.last())).toEqual({ text: "hola", event: "chat", ack: true, args: ["hola", "", "{}"] });

    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[0]!);
    expect(fields.last().extraArgs).toEqual(["{}"]);
  });
});

describe("el evento en la burbuja", () => {
  const message = (patch: Partial<ChannelMessageView>) => ({ direction: "in", ...patch }) as ChannelMessageView;

  test("un mensaje sin evento (de otro protocolo) no enseña nada", () => {
    const { container } = render(<EventRoute message={message({})} />);
    expect(container.textContent).toBe("");
  });

  test("dice si es un acuse o si lo pide", () => {
    const { rerender, container } = render(<EventRoute message={message({ event: "chat", ack: true })} />);
    expect(container.textContent).toBe("chat · acuse");
    rerender(<EventRoute message={message({ event: "chat", ack: true, direction: "out" })} />);
    expect(container.textContent).toBe("chat · pide acuse");
  });
});
