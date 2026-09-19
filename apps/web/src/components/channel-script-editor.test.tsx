/**
 * El guion de un nodo canal, suelto del inspector.
 *
 * Lo que se comprueba: que las flechas cambian el orden (y en los extremos no hacen nada), que
 * quitar borra solo esa acción, que cada protocolo enseña sus campos —tema, QoS y retener en MQTT;
 * evento y acuse en Socket.IO; «Terminar envío» solo en gRPC— y escriben lo que dicen, que una
 * casilla apagada o una pausa vaciada desaparecen del paso en vez de quedarse como `false` o `0`, y
 * que quien solo lee no puede tocar nada.
 */
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChannelScriptEditor } from "@/components/channel-script-editor";
import { MAX_SCRIPT_STEPS, type ScriptStepView } from "@/lib/channel-node-draft";
import type { ChannelView } from "@/lib/types";

function mount(
  initial: ScriptStepView[],
  options: { protocol?: ChannelView["protocol"]; variables?: string[]; canEdit?: boolean } = {},
) {
  const onChange = vi.fn<(steps: ScriptStepView[]) => void>();
  function Harness() {
    const [steps, setSteps] = useState(initial);
    return (
      <ChannelScriptEditor
        steps={steps}
        protocol={options.protocol}
        variables={options.variables ?? []}
        canEdit={options.canEdit ?? true}
        onChange={(next) => {
          onChange(next);
          setSteps(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { onChange, last: () => onChange.mock.lastCall![0] };
}

const send = (body: string): ScriptStepView => ({ action: "send", body });

describe("el orden del guion", () => {
  test("subir y bajar intercambian con la vecina; en los extremos no pasa nada", () => {
    const script = mount([send("a"), send("b")]);
    fireEvent.click(screen.getAllByRole("button", { name: "Subir" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Bajar" })[1]!);
    expect(script.onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Bajar" })[0]!);
    expect(script.last().map((step) => step.action === "send" && step.body)).toEqual(["b", "a"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Subir" })[1]!);
    expect(script.last().map((step) => step.action === "send" && step.body)).toEqual(["a", "b"]);
  });

  test("editar una acción deja las demás como estaban", () => {
    const script = mount([send("a"), send("b")]);
    fireEvent.change(screen.getByLabelText("Mensaje 2"), { target: { value: "c" } });
    expect(script.last()).toEqual([send("a"), send("c")]);
  });

  test("quitar borra solo esa acción, y sin acciones se explica qué hace la sesión", () => {
    const script = mount([send("a"), send("b")]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar la acción 1" }));
    expect(script.last()).toEqual([send("b")]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar la acción 1" }));
    expect(screen.getByText(/Sin acciones: la sesión solo escucha/)).toBeDefined();
  });

  test("con el máximo de acciones ya no se ofrece añadir más", () => {
    mount(Array.from({ length: MAX_SCRIPT_STEPS }, () => send("")));
    expect(screen.queryByRole("button", { name: "+ Enviar" })).toBeNull();
  });
});

describe("los campos de cada protocolo", () => {
  test("las variables se nombran, ocho como mucho", () => {
    mount([], { variables: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] });
    expect(screen.getByText("a, b, c, d, e, f, g, h")).toBeDefined();
    expect(screen.getByText(/…/)).toBeDefined();
  });

  test("MQTT: tema, QoS y retener; retener apagado desaparece del paso", () => {
    const script = mount([], { protocol: "mqtt" });
    expect(screen.queryByRole("button", { name: "+ Terminar envío" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Enviar" }));
    fireEvent.change(screen.getByLabelText("Mensaje 1"), { target: { value: "21" } });
    fireEvent.change(screen.getByLabelText("Tema 1"), { target: { value: "casa/temp" } });
    fireEvent.change(screen.getByLabelText("QoS 1"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Retener"));
    expect(script.last()).toEqual([{ action: "send", body: "21", topic: "casa/temp", qos: 2, retain: true }]);
    fireEvent.click(screen.getByLabelText("Retener"));
    expect(script.last()).toEqual([{ action: "send", body: "21", topic: "casa/temp", qos: 2, retain: undefined }]);
  });

  test("MQTT: un paso guardado sin tema ni QoS sale vacío y con QoS 0", () => {
    mount([send("x")], { protocol: "mqtt" });
    expect(screen.getByLabelText<HTMLInputElement>("Tema 1").value).toBe("");
    expect(screen.getByLabelText<HTMLSelectElement>("QoS 1").value).toBe("0");
  });

  test("Socket.IO: evento y acuse; el acuse apagado desaparece del paso", () => {
    const script = mount([send("hola")], { protocol: "socketio" });
    expect(screen.getByLabelText<HTMLInputElement>("Evento 1").value).toBe("");
    fireEvent.change(screen.getByLabelText("Evento 1"), { target: { value: "chat" } });
    fireEvent.click(screen.getByLabelText("Esperar acuse"));
    expect(script.last()).toEqual([{ action: "send", body: "hola", event: "chat", ack: true }]);
    fireEvent.click(screen.getByLabelText("Esperar acuse"));
    expect(script.last()).toEqual([{ action: "send", body: "hola", event: "chat", ack: undefined }]);
  });

  test("la pausa antes de mandar: un número, y vaciada deja de haberla", () => {
    const script = mount([send("x")]);
    fireEvent.change(screen.getByLabelText("Pausa 1"), { target: { value: "250" } });
    expect(script.last()).toEqual([{ action: "send", body: "x", delayMs: 250 }]);
    fireEvent.change(screen.getByLabelText("Pausa 1"), { target: { value: "" } });
    expect(script.last()).toEqual([{ action: "send", body: "x", delayMs: undefined }]);
  });

  test("esperar mensajes: cuántos y hasta cuándo", () => {
    const script = mount([]);
    fireEvent.click(screen.getByRole("button", { name: "+ Esperar mensajes" }));
    fireEvent.change(screen.getByLabelText("Mensajes a esperar 1"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Tiempo máximo 1"), { target: { value: "9000" } });
    expect(script.last()).toEqual([{ action: "wait", messages: 3, timeoutMs: 9000 }]);
  });

  test("gRPC: el mensaje se escribe en JSON y el guion puede terminar el envío", () => {
    const script = mount([send("")], { protocol: "grpc" });
    expect(screen.getByLabelText("Mensaje 1").getAttribute("placeholder")).toBe('{"name": "{{nombre}}"}');
    fireEvent.click(screen.getByRole("button", { name: "+ Terminar envío" }));
    expect(script.last()[1]).toEqual({ action: "end" });
    expect(screen.getByText(/Termina el envío del stream de cliente/)).toBeDefined();
  });

  test("quien solo lee lo ve todo apagado y sin botones", () => {
    mount([send("x")], { canEdit: false });
    expect(screen.getByLabelText<HTMLTextAreaElement>("Mensaje 1").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Subir" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Enviar" })).toBeNull();
  });
});
