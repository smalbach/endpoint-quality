/**
 * El nodo canal con un canal Socket.IO: una acción nueva nace con evento, el guion por defecto trae
 * el evento de cada trama guardada, y el inspector dice lo que falta antes de guardar.
 */
import { describe, expect, test } from "vitest";

import { channelNodeProblems, effectiveScript, newScriptStep, PROTOCOL_LABEL } from "@/lib/channel-node-draft";
import type { ChannelView, WorkflowStepView } from "@/lib/types";

const sio = {
  id: "c1",
  protocol: "socketio",
  name: "chat",
  messages: [{ name: "saludo", body: "hola", event: "chat" }],
  expectations: {},
} as unknown as ChannelView;
const ws = { ...sio, id: "c2", protocol: "ws", messages: [] } as unknown as ChannelView;

const step = (channelId: string, messages: unknown[]): WorkflowStepView =>
  ({ id: "canal", kind: "channel", channel: { channelId, messages } }) as unknown as WorkflowStepView;

describe("el nodo canal con Socket.IO", () => {
  test("una acción nueva nace con evento, y la etiqueta lo nombra", () => {
    expect(newScriptStep("send", "socketio")).toEqual({ action: "send", body: "", event: "" });
    expect(PROTOCOL_LABEL.socketio).toBe("Socket.IO");
  });

  test("sin guion, las tramas guardadas con su evento", () => {
    expect(effectiveScript({ channelId: "c1" }, sio)).toEqual([{ action: "send", body: "hola", event: "chat" }]);
  });

  test("un envío sin evento en Socket.IO, o con evento en otro protocolo, se dice", () => {
    expect(channelNodeProblems(step("c1", [{ action: "send", body: "x" }]), [sio, ws])).toEqual([
      "La acción 1 de «canal» no tiene evento: en Socket.IO se emite uno.",
    ]);
    expect(channelNodeProblems(step("c2", [{ action: "send", body: "x", event: "chat" }]), [sio, ws])).toEqual([
      "La acción 1 de «canal» emite un evento, y solo Socket.IO los emite.",
    ]);
    expect(channelNodeProblems(step("c1", [{ action: "send", body: "x", event: "chat", ack: true }]), [sio])).toEqual(
      [],
    );
  });
});
