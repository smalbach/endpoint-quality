/**
 * MQTT en el motor puro: los temas, las comprobaciones por tema y lo que una trama con tema deja en
 * la conversación.
 *
 * Sin broker, como el resto de `conversation.test.ts`: el framing, el CONNACK de verdad y la guarda
 * de red se prueban en la API contra un broker en proceso. Aquí va lo que tiene que valer siempre
 * —qué casa con `+` y `#`, que el tema se tapa, que el veredicto no habla de un upgrade que no hubo—.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { applyFrame, blankConversation, evaluateConversation, type ChannelLimits } from "../src/conversation.ts";
import { evaluateChecks, type CheckMessage, type StepCheck } from "../src/checks.ts";
import { publishTopicProblem, topicFilterProblem, topicMatches } from "../src/mqtt-topic.ts";

const LIMITS: ChannelLimits = {
  maxMessages: 200,
  maxBytes: 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxDurationMs: 30_000,
  idleMs: 10_000,
};

const NO_RESPONSE = { status: 0, statusText: "", contentType: "", headers: {}, body: null, raw: "" };

describe("los temas", () => {
  test("+ casa un nivel y # el resto, incluido el padre", () => {
    assert.equal(topicMatches("sensores/+/temp", "sensores/sala/temp"), true);
    assert.equal(topicMatches("sensores/+/temp", "sensores/sala/cocina/temp"), false);
    assert.equal(topicMatches("sensores/#", "sensores/sala/temp"), true);
    // La especificación: `sensores/#` también recoge `sensores`.
    assert.equal(topicMatches("sensores/#", "sensores"), true);
    assert.equal(topicMatches("sensores", "sensores/sala"), false);
    assert.equal(topicMatches("sensores/sala", "sensores/sala"), true);
    // Un nivel vacío es un nivel: `a//b` no es `a/b`.
    assert.equal(topicMatches("a/+/b", "a//b"), true);
    assert.equal(topicMatches("a/b", "a//b"), false);
  });

  test("un comodín inicial no recoge los temas de sistema", () => {
    assert.equal(topicMatches("#", "$SYS/broker/uptime"), false);
    assert.equal(topicMatches("+/broker/uptime", "$SYS/broker/uptime"), false);
    assert.equal(topicMatches("$SYS/#", "$SYS/broker/uptime"), true);
  });

  test("un filtro mal escrito se dice, y no casa con nada", () => {
    assert.match(topicFilterProblem("sensores/#/temp") ?? "", /# va solo/);
    assert.match(topicFilterProblem("sensores/sala+") ?? "", /\+ ocupa un nivel/);
    assert.equal(topicFilterProblem(""), "Falta el tema");
    assert.equal(topicFilterProblem("a/\u0000"), "Un tema no lleva el carácter nulo");
    assert.equal(topicFilterProblem("sensores/+/temp"), null);
    assert.equal(topicMatches("sensores/#/temp", "sensores/x/temp"), false);
  });

  test("publicar en un comodín no existe", () => {
    assert.match(publishTopicProblem("sensores/+") ?? "", /comodines/);
    assert.match(publishTopicProblem("#") ?? "", /comodines/);
    assert.equal(publishTopicProblem("sensores/sala"), null);
    assert.equal(publishTopicProblem(42), "Falta el tema");
  });
});

describe("una comprobación con tema", () => {
  const messages: CheckMessage[] = [
    { seq: 1, body: '{"t":21}', topic: "sensores/sala/temp" },
    { seq: 2, body: '{"on":true}', topic: "luces/sala" },
    { seq: 3, body: '{"t":19}', topic: "sensores/cocina/temp" },
    { seq: 4, body: '{"on":false}', topic: "luces/cocina" },
  ];
  const run = (check: StepCheck) => evaluateChecks([check], { response: NO_RESPONSE, durationMs: 0, messages })[0];

  test("«el último» es el último del tema, no el último que llegó", () => {
    const assertion = run({
      source: "message",
      path: "t",
      operator: "equals",
      value: 19,
      match: { at: "last", topic: "sensores/+/temp" },
    });
    assert.equal(assertion.pass, true, assertion.detail);
    assert.equal(assertion.label, "último mensaje en sensores/+/temp · t es 19");
  });

  test("`all` y `messageCount` cuentan dentro del tema", () => {
    assert.equal(
      run({ source: "message", path: "on", operator: "exists", match: { at: "all", topic: "luces/#" } }).pass,
      true,
    );
    const count = run({ source: "messageCount", operator: "equals", value: 2, match: { at: "any", topic: "luces/#" } });
    assert.equal(count.pass, true, count.detail);
    assert.equal(count.label, "mensajes recibidos en luces/# es 2");
  });

  test("un tema del que no llegó nada falla por eso, y no por el cuerpo de otro", () => {
    const assertion = run({ source: "message", operator: "exists", match: { at: "any", topic: "puertas/#" } });
    assert.equal(assertion.pass, false);
    assert.equal(assertion.detail, "No llegó ningún mensaje");
  });

  test("sin tema, lo de siempre: el último mensaje de todos", () => {
    assert.equal(run({ source: "message", path: "on", operator: "equals", value: false }).pass, true);
  });

  test("un mensaje sin tema —un WebSocket— no casa con ningún filtro", () => {
    const [assertion] = evaluateChecks(
      [{ source: "messageCount", operator: "equals", value: 0, match: { at: "any", topic: "#" } }],
      { response: NO_RESPONSE, durationMs: 0, messages: [{ seq: 0, body: "hola" }] },
    );
    assert.equal(assertion.pass, true);
  });
});

describe("una trama con tema en la conversación", () => {
  test("el tema se guarda tapado, con su QoS y su retain, y el cuerpo se tapa como siempre", () => {
    const secret = "tk-dispositivo-9f2e";
    const { conversation } = applyFrame(
      blankConversation(),
      {
        direction: "in",
        atMs: 5,
        body: `{"token":"${secret}"}`,
        topic: `dispositivos/${secret}/estado`,
        qos: 1,
        retain: true,
      },
      LIMITS,
      { secrets: [secret] },
    );
    const [message] = conversation.messages;
    assert.equal(message.topic, "dispositivos/••••••••/estado");
    assert.equal(message.qos, 1);
    assert.equal(message.retain, true);
    assert.ok(!message.body.includes(secret));
    assert.ok(!JSON.stringify(conversation).includes(secret));
  });

  test("una trama sin tema no deja campos vacíos: un WebSocket sigue igual que antes", () => {
    const { conversation } = applyFrame(blankConversation(), { direction: "in", atMs: 1, body: "hola" }, LIMITS);
    assert.deepEqual(Object.keys(conversation.messages[0]).sort(), [
      "atMs",
      "body",
      "bytes",
      "direction",
      "kind",
      "seq",
      "truncated",
    ]);
  });

  test("el veredicto nombra el CONNACK, y sin `via` sigue diciendo upgrade", () => {
    const opened = (via?: string) =>
      applyFrame(
        blankConversation(),
        { direction: "open", atMs: 0, handshake: { status: 0, headers: {}, ...(via ? { via } : {}) } },
        LIMITS,
      ).conversation;
    const mqtt = evaluateConversation({ expect: {}, conversation: opened("CONNACK") });
    assert.equal(mqtt.assertions[0].detail, "abierta (0 en el CONNACK)");
    const ws = evaluateConversation({ expect: {}, conversation: opened() });
    assert.equal(ws.assertions[0].detail, "abierta (0 en el upgrade)");
  });
});

describe("las propiedades de MQTT 5 y los eventos de la sesión", () => {
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJh";
  const redact = (text: string) => text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "••••••••");

  test("las propiedades se tapan como cabeceras: por nombre, por forma y por valor", () => {
    const secret = "tk-correlacion-77aa";
    const { conversation } = applyFrame(
      blankConversation(),
      {
        direction: "in",
        atMs: 3,
        body: "{}",
        topic: "respuestas",
        properties: {
          userProperties: [
            ["authorization", "Bearer lo-que-sea"],
            ["origen", "sala"],
            ["origen", JWT],
          ],
          contentType: "application/json",
          responseTopic: `respuestas/${secret}`,
          correlationData: `id-${secret}`,
          correlationEncoding: "text",
        },
      },
      LIMITS,
      { secrets: [secret], redact, secretHeader: /^authorization$/i },
    );
    const { properties } = conversation.messages[0];
    assert.deepEqual(properties?.userProperties, [
      ["authorization", "••••••••"],
      ["origen", "sala"],
      ["origen", "••••••••"],
    ]);
    assert.equal(properties?.contentType, "application/json");
    assert.equal(properties?.responseTopic, "respuestas/••••••••");
    assert.equal(properties?.correlationData, "id-••••••••");
    assert.equal(properties?.correlationEncoding, "text");
    assert.ok(!JSON.stringify(conversation).includes(secret));
  });

  test("unos datos de correlación binarios van en hexadecimal y lo dicen", () => {
    const { conversation } = applyFrame(
      blankConversation(),
      { direction: "in", atMs: 1, body: "x", properties: { correlationData: "00ff", correlationEncoding: "hex" } },
      LIMITS,
    );
    assert.deepEqual(conversation.messages[0].properties, { correlationData: "00ff", correlationEncoding: "hex" });
  });

  test("unas propiedades vacías no dejan campo", () => {
    const { conversation } = applyFrame(
      blankConversation(),
      { direction: "in", atMs: 1, body: "x", properties: { userProperties: [] } },
      LIMITS,
    );
    assert.equal("properties" in conversation.messages[0], false);
  });

  test("un evento consta en la transcripción y no cuenta como mensaje", () => {
    let conversation = applyFrame(
      blankConversation(),
      { direction: "event", atMs: 2, body: "suscrito a casa/# (QoS 1)", topic: "casa/#", qos: 1 },
      LIMITS,
    ).conversation;
    conversation = applyFrame(
      conversation,
      { direction: "in", atMs: 4, body: "hola", topic: "casa/x" },
      LIMITS,
    ).conversation;
    assert.deepEqual(
      conversation.messages.map((message) => message.direction),
      ["event", "in"],
    );
    assert.deepEqual(conversation.counters, { sent: 0, received: 1, bytesIn: 4, bytesOut: 0 });
    const verdict = evaluateConversation({ expect: { minMessages: 2 }, conversation });
    assert.equal(verdict.assertions[1].detail, "llegaron 1");
  });
});
