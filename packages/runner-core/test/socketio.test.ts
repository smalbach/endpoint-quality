/**
 * Socket.IO en el motor puro: el evento de cada mensaje, las comprobaciones por evento y lo que un
 * acuse deja en la conversación.
 *
 * Sin servidor, como `mqtt.test.ts`: la conexión, el `CONNECT` del espacio de nombres y la guarda de
 * red se prueban en la API contra un servidor `socket.io` en proceso.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { applyFrame, blankConversation, evaluateConversation, type ChannelLimits } from "../src/conversation.ts";
import { evaluateChecks, type CheckMessage } from "../src/checks.ts";
import { conversationResponse, stepChannelSchema } from "../src/channel-node.ts";

const LIMITS: ChannelLimits = {
  maxMessages: 200,
  maxBytes: 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxDurationMs: 30_000,
  idleMs: 10_000,
};

const NO_RESPONSE = { status: 0, statusText: "", contentType: "", headers: {}, body: null, raw: "" };

const received: CheckMessage[] = [
  { seq: 1, body: '{"sala":"a","n":1}', event: "chat" },
  { seq: 2, body: '{"estado":"ok"}', event: "estado" },
  { seq: 3, body: '{"sala":"a","n":2}', event: "chat" },
  { seq: 4, body: "sin evento" },
];

describe("las comprobaciones por evento", () => {
  test("el último mensaje de un evento, y no el último de todos", () => {
    const [last] = evaluateChecks(
      [{ source: "message", path: "n", operator: "equals", value: 2, match: { at: "last", event: "chat" } }],
      { response: NO_RESPONSE, durationMs: 0, messages: received },
    );
    assert.equal(last.pass, true);
    assert.equal(last.label.includes("del evento chat"), true);

    const [first] = evaluateChecks(
      [{ source: "message", path: "estado", operator: "equals", value: "ok", match: { at: "first", event: "estado" } }],
      { response: NO_RESPONSE, durationMs: 0, messages: received },
    );
    assert.equal(first.pass, true);
  });

  test("cuenta y `all` dentro del evento; un evento que no llegó no pasa por vacío", () => {
    const [count, all, none] = evaluateChecks(
      [
        { source: "messageCount", operator: "equals", value: 2, match: { at: "any", event: "chat" } },
        { source: "message", path: "sala", operator: "equals", value: "a", match: { at: "all", event: "chat" } },
        { source: "message", operator: "exists", match: { at: "all", event: "nunca" } },
      ],
      { response: NO_RESPONSE, durationMs: 0, messages: received },
    );
    assert.equal(count.pass, true);
    assert.equal(all.pass, true);
    assert.equal(none.pass, false);
    assert.equal(none.detail, "No llegó ningún mensaje");
  });

  test("evento y tema se suman: un mensaje sin tema no casa aunque el evento sí", () => {
    const [both] = evaluateChecks(
      [{ source: "messageCount", operator: "equals", value: 0, match: { at: "any", event: "chat", topic: "a/#" } }],
      { response: NO_RESPONSE, durationMs: 0, messages: received },
    );
    assert.equal(both.pass, true);
  });
});

describe("una trama con evento", () => {
  test("guarda el evento tapado por valor y el acuse, y el acuse cuenta como recibido", () => {
    const secret = "tk-socketio-9f2c";
    let conversation = blankConversation();
    conversation = applyFrame(conversation, { direction: "open", atMs: 0 }, LIMITS).conversation;
    conversation = applyFrame(
      conversation,
      { direction: "out", atMs: 1, body: `{"token":"${secret}"}`, event: "login", ack: true },
      LIMITS,
      { secrets: [secret] },
    ).conversation;
    conversation = applyFrame(
      conversation,
      { direction: "in", atMs: 5, body: '{"ok":true}', event: "login", ack: true },
      LIMITS,
      { secrets: [secret] },
    ).conversation;
    conversation = applyFrame(
      conversation,
      { direction: "in", atMs: 6, body: "hola", event: `canal-${secret}` },
      LIMITS,
      { secrets: [secret] },
    ).conversation;

    const [sent, ack, message] = conversation.messages;
    assert.equal(sent.event, "login");
    assert.equal(sent.ack, true);
    assert.equal(sent.body.includes(secret), false);
    assert.equal(ack.direction, "in");
    assert.equal(ack.ack, true);
    assert.equal(message.event, "canal-••••••••");
    assert.equal(message.ack, undefined);
    assert.equal(conversation.counters.received, 2);

    const verdict = evaluateConversation({
      expect: {
        checks: [
          { source: "message", path: "ok", operator: "equals", value: true, match: { at: "any", event: "login" } },
        ],
      },
      conversation,
    });
    assert.equal(verdict.ok, true);
  });

  test("sin evento, el mensaje sale como siempre: sin campos vacíos", () => {
    const { conversation } = applyFrame(blankConversation(), { direction: "in", atMs: 1, body: "x" }, LIMITS);
    assert.equal("event" in conversation.messages[0], false);
    assert.equal("ack" in conversation.messages[0], false);
  });
});

describe("el nodo canal con Socket.IO", () => {
  test("el guion admite el evento y el acuse; un evento vacío no", () => {
    const ok = stepChannelSchema.safeParse({
      channelId: "8c4f7a2e-3b1d-4e5f-9a6b-1c2d3e4f5a6b",
      messages: [{ action: "send", body: '{"a":1}', event: "chat", ack: true }],
    });
    assert.equal(ok.success, true);
    const empty = stepChannelSchema.safeParse({
      channelId: "8c4f7a2e-3b1d-4e5f-9a6b-1c2d3e4f5a6b",
      messages: [{ action: "send", body: "x", event: "" }],
    });
    assert.equal(empty.success, false);
  });

  test("las capturas ven el evento de cada mensaje", () => {
    const actual = conversationResponse({
      received: [{ body: '{"id":7}', event: "creado" }, { body: "suelto" }],
      handshake: null,
      closeCode: null,
    });
    const body = actual.body as { events: unknown[]; last: unknown };
    assert.deepEqual(body.events, ["creado", null]);
    assert.equal(body.last, "suelto");
  });
});
