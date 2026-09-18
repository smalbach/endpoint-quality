import { describe, expect, test } from "vitest";
import { addControlStep, CONTROL_PALETTE, problemsWith, toNodes } from "@/lib/workflow-draft";
import {
  channelNodeProblems,
  channelSampleBody,
  effectiveScript,
  newScriptStep,
  untilText,
} from "@/lib/channel-node-draft";
import type { ChannelView, WorkflowStepView } from "@/lib/types";

const CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

const channelView = (patch: Partial<ChannelView> = {}): ChannelView => ({
  id: CHANNEL_ID,
  protocol: "ws",
  name: "chat",
  url: "{{wsBase}}/chat",
  subprotocols: [],
  headers: [],
  auth: null,
  limits: { maxMessages: 200, maxBytes: 1_048_576, maxMessageBytes: 65_536, maxDurationMs: 30_000, idleMs: 10_000 },
  expectations: { minMessages: 2 },
  messages: [
    { name: "auth", body: '{"auth":"{{token}}"}' },
    { name: "join", body: '{"join":"sala","sessionId":"s-1"}' },
  ],
  mqtt: null,
  grpc: null,
  orderIndex: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...patch,
});

describe("el nodo canal en el borrador", () => {
  const base: WorkflowStepView[] = [{ id: "login", requestTemplateId: "t1", position: { x: 40, y: 60 } }];

  test("cae de la paleta sin canal, y el aviso lo pide hasta que se elige", () => {
    expect(CONTROL_PALETTE.find((entry) => entry.kind === "channel")).toMatchObject({ label: "Canal" });
    const { steps, id } = addControlStep(base, "channel");
    expect(id).toBe("canal");
    const node = steps.find((step) => step.id === id)!;
    expect(node).toMatchObject({ kind: "channel", channel: { channelId: "" } });
    expect(problemsWith(steps).some((message) => message.includes("no tiene elegido el canal"))).toBe(true);

    const chosen = steps.map((step) => (step.id === id ? { ...step, channel: { channelId: CHANNEL_ID } } : step));
    expect(problemsWith(chosen)).toEqual([]);
    expect(toNodes(chosen, [], []).find((item) => item.id === id)).toMatchObject({
      type: "channel",
      data: { name: "canal", chosen: true, scripted: null, captures: 0 },
    });
  });

  test("en el lienzo el nodo dice el nombre y el protocolo del canal, y avisa si ya no existe", () => {
    const steps: WorkflowStepView[] = [{ id: "canal", kind: "channel", channel: { channelId: CHANNEL_ID } }];
    const data = (channels?: ChannelView[]) =>
      toNodes(steps, [], [], undefined, undefined, undefined, channels)[0]!.data;

    expect(data([channelView({ protocol: "mqtt", name: "sensores" })])).toMatchObject({
      channelName: "sensores",
      protocol: "MQTT",
      missing: false,
    });
    // Borrado: la lista llegó y no está.
    expect(data([])).toMatchObject({ channelName: null, missing: true });
    // Mientras la lista carga no se sabe, y no se avisa.
    expect(data(undefined)).toMatchObject({ channelName: null, missing: false });
  });

  test("avisa de lo que el servidor rechazaría: tema en MQTT, tema con comodines, comprobaciones en el nodo", () => {
    const mqtt = channelView({ protocol: "mqtt" });
    const step = (channel: WorkflowStepView["channel"], extra: Partial<WorkflowStepView> = {}): WorkflowStepView => ({
      id: "c",
      kind: "channel",
      channel,
      ...extra,
    });
    const problems = (s: WorkflowStepView, channels: ChannelView[]) => channelNodeProblems(s, channels).join("\n");

    expect(problems(step({ channelId: CHANNEL_ID, messages: [{ action: "send", body: "x" }] }), [mqtt])).toMatch(
      /no tiene tema/,
    );
    expect(
      problems(step({ channelId: CHANNEL_ID, messages: [{ action: "send", body: "x", topic: "a/#" }] }), [mqtt]),
    ).toMatch(/comodines/);
    expect(
      problems(step({ channelId: CHANNEL_ID, messages: [{ action: "send", body: "x", topic: "a" }] }), [channelView()]),
    ).toMatch(/solo MQTT/);
    expect(
      problems(step({ channelId: CHANNEL_ID }, { checks: [{ source: "status", operator: "equals", value: "101" }] }), [
        channelView(),
      ]),
    ).toMatch(/comprobaciones del propio canal/);
    expect(problems(step({ channelId: CHANNEL_ID }), [])).toMatch(/ya no existe/);
    expect(problems(step({ channelId: CHANNEL_ID, request: "{}" }), [channelView()])).toMatch(/no es gRPC/);
  });

  test("sin guion propio corre lo guardado del canal; gRPC solo su petición; y cuándo cierra, dicho", () => {
    const ws = channelView();
    expect(effectiveScript({ channelId: CHANNEL_ID }, ws).map((step) => step.action === "send" && step.body)).toEqual([
      '{"auth":"{{token}}"}',
      '{"join":"sala","sessionId":"s-1"}',
    ]);
    expect(effectiveScript({ channelId: CHANNEL_ID, messages: [] }, ws)).toEqual([]);
    expect(effectiveScript({ channelId: CHANNEL_ID }, channelView({ protocol: "grpc" }))).toEqual([]);

    expect(untilText({ channelId: CHANNEL_ID }, ws)).toBe("cierra al recibir 2 mensajes");
    expect(untilText({ channelId: CHANNEL_ID, untilMessages: 1 }, ws)).toBe("cierra al recibir 1 mensaje");
    expect(untilText({ channelId: CHANNEL_ID }, channelView({ protocol: "grpc", expectations: {} }))).toMatch(
      /termina la llamada/,
    );
    expect(newScriptStep("send", "mqtt")).toEqual({ action: "send", body: "", topic: "", qos: 0 });
    expect(newScriptStep("wait", "ws")).toEqual({ action: "wait", messages: 1, timeoutMs: 5_000 });
  });

  test("las capturas se sugieren desde el último mensaje guardado, con la forma de la conversación", () => {
    expect(channelSampleBody(channelView())).toMatchObject({ last: { join: "sala", sessionId: "s-1" }, count: 1 });
    expect(channelSampleBody(undefined)).toMatchObject({ last: null, messages: [] });
  });
});
