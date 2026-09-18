import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { applyCaptures } from "../src/workflows.ts";
import { conversationResponse } from "../src/channel-node.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const issues = (steps: unknown[]) => {
  const parsed = safeParseWorkflowDocument({ steps });
  return parsed.ok ? [] : parsed.issues.map((issue) => `${issue.field}: ${issue.detail}`);
};

describe("el nodo canal en el esquema", () => {
  test("un canal con guion de envío, espera y fin se acepta", () => {
    const found = issues([
      {
        id: "socket",
        kind: "channel",
        channel: {
          channelId: uuid(1),
          messages: [
            { action: "send", body: '{"auth":"{{token}}"}', delayMs: 10 },
            { action: "wait", messages: 1, timeoutMs: 2_000 },
            { action: "send", body: "hola", topic: "sensores/1/temp", qos: 1, retain: false },
            { action: "end" },
          ],
          request: '{"name":"{{nombre}}"}',
          untilMessages: 2,
          idleMs: 500,
        },
        captures: [{ variable: "sesion", from: "body", path: "last.session" }],
      },
    ]);
    assert.deepEqual(found, []);
  });

  test("sin canal, con un canal que no es un id o con un bloque en otro nodo, es un problema con su campo", () => {
    assert.match(issues([{ id: "a", kind: "channel" }]).join("\n"), /necesita el canal/);
    assert.match(issues([{ id: "a", kind: "channel", channel: { channelId: "chat" } }]).join("\n"), /elige el canal/);
    assert.match(
      issues([{ id: "a", kind: "wait", waitMs: 1, channel: { channelId: uuid(1) } }]).join("\n"),
      /solo un nodo canal/,
    );
  });

  test("las comprobaciones son las del canal, y no admite reintentos, forEach ni login", () => {
    const found = issues([
      {
        id: "a",
        kind: "channel",
        channel: { channelId: uuid(1) },
        checks: [{ source: "status", operator: "equals", value: "101" }],
        retry: { attempts: 1, delayMs: 0 },
      },
    ]).join("\n");
    assert.match(found, /comprobaciones del propio canal/);
    assert.match(found, /no admite reintentos/);
  });

  test("un tema con comodines, una acción desconocida o un guion sin techo se rechazan", () => {
    const channel = (messages: unknown[]) => [{ id: "a", kind: "channel", channel: { channelId: uuid(1), messages } }];
    assert.match(issues(channel([{ action: "send", body: "x", topic: "a/#" }])).join("\n"), /comodines/);
    assert.notDeepEqual(issues(channel([{ action: "reconnect" }])), []);
    assert.notDeepEqual(issues(channel([{ action: "wait", messages: 0, timeoutMs: 10 }])), []);
    const long = Array.from({ length: 31 }, () => ({ action: "end" }));
    assert.match(issues(channel(long)).join("\n"), /como mucho 30/);
  });

  test("una petición guardada en un nodo canal no tiene sentido", () => {
    const found = issues([{ id: "a", kind: "channel", requestTemplateId: uuid(2), channel: { channelId: uuid(1) } }]);
    assert.match(found.join("\n"), /ejecuta un canal/);
  });

  test("el esquema del contrato y un reintento de petición no pueden leer un nodo canal", () => {
    const found = issues([
      { id: "a", kind: "channel", channel: { channelId: uuid(1) } },
      { id: "s", kind: "schema", dependsOn: ["a"], schema: { from: "a", source: "contract" } },
      {
        id: "p",
        kind: "poll",
        dependsOn: ["a"],
        poll: { from: "a", attempts: 2, delayMs: 0 },
        checks: [{ source: "status", operator: "equals", value: "101" }],
      },
    ]).join("\n");
    assert.match(found, /esquema del contrato/);
    assert.match(found, /solo repite una petición/);
  });
});

describe("la conversación como respuesta", () => {
  test("los mensajes parseados, el último a mano, y lo que las capturas leen de ahí", () => {
    const actual = conversationResponse({
      received: [
        { body: '{"type":"hello","id":7}' },
        { body: "texto suelto" },
        { body: '{"type":"ok","session":"s-123"}', topic: "chat/1" },
      ],
      handshake: { status: 101, headers: { "sec-websocket-protocol": "chat" } },
      closeCode: 1000,
    });
    assert.equal(actual.status, 101);
    assert.equal(actual.headers["sec-websocket-protocol"], "chat");
    const body = actual.body as { messages: unknown[]; last: unknown; count: number; topics: unknown[] };
    assert.equal(body.count, 3);
    assert.deepEqual(body.messages[1], "texto suelto");
    assert.deepEqual(body.last, { type: "ok", session: "s-123" });
    assert.deepEqual(body.topics, [null, null, "chat/1"]);

    const variables: Record<string, string> = {};
    const capture = applyCaptures(
      [
        { variable: "sesion", from: "body", path: "last.session" },
        { variable: "primero", from: "body", path: "messages.0.id" },
        { variable: "tipo", from: "regex", path: '"type":"(hello)"' },
        { variable: "nada", from: "body", path: "messages.9.id" },
      ],
      actual,
      variables,
      "socket",
    );
    assert.deepEqual(capture.captured, ["sesion", "primero", "tipo"]);
    assert.deepEqual(capture.missing, ["nada"]);
    assert.equal(variables["socket.sesion"], "s-123");
    assert.equal(variables.primero, "7");
  });

  test("sin apertura ni mensajes: estado 0, lista vacía y sin último", () => {
    const actual = conversationResponse({ received: [], handshake: null, closeCode: null });
    assert.equal(actual.status, 0);
    assert.deepEqual(actual.body, { messages: [], last: null, count: 0, topics: [], closeCode: null });
    assert.equal(actual.raw, "");
  });
});
