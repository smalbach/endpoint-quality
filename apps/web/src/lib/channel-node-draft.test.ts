import { describe, expect, test } from "vitest";

import {
  MAX_SCRIPT_STEPS,
  channelNodeProblems,
  channelSampleBody,
  defaultChannelNode,
  effectiveScript,
  newScriptStep,
  untilText,
  type ScriptStepView,
} from "./channel-node-draft";
import type { ChannelView, WorkflowStepView } from "./types";

const channel = (protocol: ChannelView["protocol"], overrides: Partial<ChannelView> = {}): ChannelView =>
  ({ id: "c1", name: "Canal", protocol, messages: [], expectations: {}, ...overrides }) as unknown as ChannelView;

const step = (node: WorkflowStepView["channel"], extra: Partial<WorkflowStepView> = {}): WorkflowStepView =>
  ({ id: "chat", channel: node, ...extra }) as WorkflowStepView;

describe("acciones nuevas del guion", () => {
  test("un nodo recién soltado no tiene canal, que es lo primero que se pide", () => {
    expect(defaultChannelNode()).toEqual({ channelId: "" });
    expect(channelNodeProblems(step(defaultChannelNode()))).toHaveLength(1);
  });

  test("cada acción nace válida para su protocolo", () => {
    expect(newScriptStep("wait", "ws")).toEqual({ action: "wait", messages: 1, timeoutMs: 5_000 });
    expect(newScriptStep("end", "ws")).toEqual({ action: "end" });
    expect(newScriptStep("send", "socketio")).toEqual({ action: "send", body: "", event: "" });
    expect(newScriptStep("send", "mqtt")).toEqual({ action: "send", body: "", topic: "", qos: 0 });
    expect(newScriptStep("send", "ws")).toEqual({ action: "send", body: "" });
    expect(newScriptStep("send", undefined)).toEqual({ action: "send", body: "" });
  });
});

describe("el guion que corre", () => {
  test("el escrito manda sobre el del canal", () => {
    const messages: ScriptStepView[] = [{ action: "end" }];
    expect(effectiveScript({ channelId: "c1", messages }, channel("ws"))).toBe(messages);
  });

  test("sin canal, o en gRPC, no hay nada que mandar", () => {
    expect(effectiveScript({ channelId: "c1" }, undefined)).toEqual([]);
    expect(effectiveScript({ channelId: "c1" }, channel("grpc", { messages: [{ body: "x" }] } as never))).toEqual([]);
  });

  test("sin guion, los mensajes guardados en orden y solo con los campos que tienen", () => {
    const saved = channel("mqtt", {
      messages: [{ body: "a", topic: "t/1", qos: 1, retain: true, event: "e" }, { body: "b" }],
    } as never);
    expect(effectiveScript({ channelId: "c1" }, saved)).toEqual([
      { action: "send", body: "a", topic: "t/1", qos: 1, retain: true, event: "e" },
      { action: "send", body: "b" },
    ]);
  });
});

describe("cuándo cierra", () => {
  test("lo dice el nodo, o si no las expectativas del canal, en singular o plural", () => {
    expect(untilText({ channelId: "c1", untilMessages: 1 }, undefined)).toBe("cierra al recibir 1 mensaje");
    expect(untilText({ channelId: "c1" }, channel("ws", { expectations: { minMessages: 3 } } as never))).toBe(
      "cierra al recibir 3 mensajes",
    );
  });

  test("sin número, gRPC cierra con la llamada y lo demás por inactividad", () => {
    expect(untilText({ channelId: "c1" }, channel("grpc"))).toBe("cierra cuando termina la llamada");
    expect(untilText({ channelId: "c1" }, channel("ws"))).toBe("cierra por inactividad o al cerrar el otro lado");
    expect(untilText({ channelId: "c1" }, undefined)).toBe("cierra por inactividad o al cerrar el otro lado");
  });
});

describe("lo que el servidor rechazaría", () => {
  test("sin canal elegido, eso y nada más", () => {
    expect(channelNodeProblems(step({ channelId: "" }))).toEqual([
      "El nodo canal «chat» no tiene elegido el canal que ejecuta.",
    ]);
    expect(channelNodeProblems(step(undefined))).toHaveLength(1);
  });

  test("un canal que ya no existe, y comprobaciones propias", () => {
    const problems = channelNodeProblems(step({ channelId: "borrado" }, { checks: [{} as never] }), [channel("ws")]);
    expect(problems).toEqual([
      "El nodo canal «chat» apunta a un canal que ya no existe.",
      "El nodo canal «chat» usa las comprobaciones del propio canal: escríbelas en el canal.",
    ]);
  });

  test("sin la lista de canales no se puede decir que falte", () => {
    expect(channelNodeProblems(step({ channelId: "c1" }))).toEqual([]);
  });

  test("un guion demasiado largo", () => {
    const messages = Array.from({ length: MAX_SCRIPT_STEPS + 1 }, () => ({ action: "end" }) as ScriptStepView);
    expect(channelNodeProblems(step({ channelId: "c1", messages }), [channel("ws")])).toEqual([
      `El guion de «chat» tiene más de ${MAX_SCRIPT_STEPS} acciones.`,
    ]);
  });

  test("MQTT pide tema y sin comodines; los demás no llevan tema", () => {
    const mqtt = channelNodeProblems(
      step({
        channelId: "c1",
        messages: [
          { action: "send", body: "", topic: " " },
          { action: "send", body: "", topic: "sensores/+" },
          { action: "send", body: "", topic: "ok" },
        ],
      }),
      [channel("mqtt")],
    );
    expect(mqtt).toEqual([
      "La acción 1 de «chat» no tiene tema: en MQTT se publica en uno.",
      "La acción 2 de «chat» publica en un tema con comodines.",
    ]);
    expect(
      channelNodeProblems(step({ channelId: "c1", messages: [{ action: "send", body: "", topic: "t" }] }), [
        channel("ws"),
      ]),
    ).toEqual(["La acción 1 de «chat» lleva tema, y solo MQTT publica en uno."]);
  });

  test("Socket.IO pide evento; los demás no emiten eventos ni esperan ack", () => {
    expect(
      channelNodeProblems(step({ channelId: "c1", messages: [{ action: "send", body: "", event: "" }] }), [
        channel("socketio"),
      ]),
    ).toEqual(["La acción 1 de «chat» no tiene evento: en Socket.IO se emite uno."]);
    expect(
      channelNodeProblems(
        step({
          channelId: "c1",
          messages: [
            { action: "send", body: "", event: "x" },
            { action: "send", body: "", ack: true } as ScriptStepView,
          ],
        }),
        [channel("ws")],
      ),
    ).toEqual([
      "La acción 1 de «chat» emite un evento, y solo Socket.IO los emite.",
      "La acción 2 de «chat» emite un evento, y solo Socket.IO los emite.",
    ]);
  });

  test("la espera antes de mandar va de 0 a 30 000 ms", () => {
    const problems = channelNodeProblems(
      step({
        channelId: "c1",
        messages: [
          { action: "send", body: "", delayMs: -1 },
          { action: "send", body: "", delayMs: 30_001 },
          { action: "send", body: "", delayMs: 30_000 },
        ],
      }),
      [channel("ws")],
    );
    expect(problems).toEqual([
      "La acción 1 de «chat» espera más de 30 000 ms antes de mandar.",
      "La acción 2 de «chat» espera más de 30 000 ms antes de mandar.",
    ]);
  });

  test("esperar pide al menos un mensaje y un tope entre 1 y 60 000 ms", () => {
    const problems = channelNodeProblems(
      step({
        channelId: "c1",
        messages: [
          { action: "wait", messages: 0, timeoutMs: 0 },
          { action: "wait", messages: 1, timeoutMs: 60_001 },
          { action: "wait", messages: 2, timeoutMs: 60_000 },
        ],
      }),
      [channel("ws")],
    );
    expect(problems).toEqual([
      "La acción 1 de «chat» espera a cero mensajes.",
      "La acción 1 de «chat» espera entre 1 y 60 000 ms.",
      "La acción 2 de «chat» espera entre 1 y 60 000 ms.",
    ]);
  });

  test("una petición gRPC solo en un canal gRPC, y la inactividad entre 100 y 60 000 ms", () => {
    expect(channelNodeProblems(step({ channelId: "c1", request: "{}", idleMs: 50 } as never), [channel("ws")])).toEqual(
      ["«chat» lleva una petición gRPC, y el canal no es gRPC.", "La inactividad de «chat» va de 100 a 60 000 ms."],
    );
    expect(
      channelNodeProblems(step({ channelId: "c1", request: "{}", idleMs: 60_001 } as never), [channel("grpc")]),
    ).toEqual(["La inactividad de «chat» va de 100 a 60 000 ms."]);
    expect(channelNodeProblems(step({ channelId: "c1", idleMs: 100 }), [channel("ws")])).toEqual([]);
  });
});

describe("la conversación de ejemplo", () => {
  test("el último mensaje guardado, si es JSON", () => {
    const withJson = channel("ws", { messages: [{ body: "x" }, { body: '{"id":1}' }] } as never);
    expect(channelSampleBody(withJson)).toEqual({ messages: [{ id: 1 }], last: { id: 1 }, count: 1, closeCode: null });
  });

  test("sin canal, sin mensajes o con uno que no es JSON, la forma vacía", () => {
    const empty = { messages: [], last: null, count: 0, closeCode: null };
    expect(channelSampleBody(undefined)).toEqual(empty);
    expect(channelSampleBody(channel("ws"))).toEqual(empty);
    expect(channelSampleBody(channel("ws", { messages: [{ body: "hola" }] } as never))).toEqual(empty);
  });
});
