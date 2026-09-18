/**
 * Una conversación, medida sin abrir un socket.
 *
 * Todo aquí son listas de tramas escritas a mano, y es a propósito: los topes, la redacción y el
 * veredicto son las tres cosas que tienen que funcionar siempre, y la única forma de probarlas en
 * cada cambio es que no necesiten red. Lo que sí la necesita —el framing, el 401 en el upgrade, el
 * código de cierre de verdad— se prueba en la API contra un servidor en loopback.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyFrame,
  blankConversation,
  evaluateConversation,
  GRPC_STATUS_NAMES,
  grpcStatusName,
  maskSecrets,
  type ChannelLimits,
  type Conversation,
  type RawFrame,
  type RedactionRules,
} from "../src/conversation.ts";
import { evaluateChecks, type StepCheck } from "../src/checks.ts";
import { holds } from "../src/types.ts";
import { stepCheckSchema } from "../src/workflow-schema.ts";

const LIMITS: ChannelLimits = {
  maxMessages: 200,
  maxBytes: 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxDurationMs: 30_000,
  idleMs: 10_000,
};

/** Las tramas, una detrás de otra, y el primer motivo de parada que aparezca. */
function play(
  frames: RawFrame[],
  limits: ChannelLimits = LIMITS,
  rules: RedactionRules = {},
): { conversation: Conversation; stops: (string | null)[] } {
  let conversation = blankConversation();
  const stops: (string | null)[] = [];
  for (const frame of frames) {
    const next = applyFrame(conversation, frame, limits, rules);
    conversation = next.conversation;
    stops.push(next.stop);
  }
  return { conversation, stops };
}

const open = (atMs = 0): RawFrame => ({ direction: "open", atMs, handshake: { status: 101, headers: {} } });
const incoming = (atMs: number, body: string): RawFrame => ({ direction: "in", atMs, body });
const outgoing = (atMs: number, body: string): RawFrame => ({ direction: "out", atMs, body });

describe("los topes paran en la trama exacta, y dicen cuál", () => {
  test("el de mensajes", () => {
    const limits = { ...LIMITS, maxMessages: 3 };
    const { conversation, stops } = play([open(), incoming(1, "a"), incoming(2, "b"), incoming(3, "c")], limits);
    assert.deepEqual(stops, [null, null, null, "message-cap"]);
    assert.equal(conversation.stopped, "message-cap");
    // El mensaje que alcanza el tope sí entra: se paró *con* él, no antes.
    assert.equal(conversation.messages.length, 3);
  });

  test("el de bytes, sumando solo lo que entra", () => {
    const limits = { ...LIMITS, maxBytes: 10 };
    // Lo enviado no cuenta contra el tope de lo recibido: lo mandó quien está al teclado.
    const { stops, conversation } = play(
      [open(), outgoing(1, "x".repeat(50)), incoming(2, "123456"), incoming(3, "123456")],
      limits,
    );
    assert.deepEqual(stops, [null, null, null, "byte-cap"]);
    assert.equal(conversation.counters.bytesIn, 12);
    assert.equal(conversation.counters.bytesOut, 50);
  });

  test("el de tiempo, cuando una trama llega pasada la duración", () => {
    const { stops } = play([open(), incoming(29_999, "a"), incoming(30_000, "b")]);
    assert.deepEqual(stops, [null, null, "time-cap"]);
  });

  test("un error de transporte se anota aunque la misma trama pase un tope", () => {
    const limits = { ...LIMITS, maxMessages: 2 };
    const { stops } = play([open(), incoming(1, "a"), { direction: "error", atMs: 2, body: "ECONNRESET" }], limits);
    assert.equal(stops[2], "transport-error");
  });

  test("el cierre del otro lado se anota con su código", () => {
    const { conversation, stops } = play([
      open(),
      incoming(5, "hola"),
      { direction: "close", atMs: 9, closeCode: 1000, closeReason: "adiós" },
    ]);
    assert.equal(stops[2], "closed-by-peer");
    assert.equal(conversation.closeCode, 1000);
    assert.equal(conversation.closeReason, "adiós");
    // El cierre no es un mensaje: no cuenta como recibido ni tiene cuerpo.
    assert.equal(conversation.counters.received, 1);
  });

  test("el primer motivo de parada es el que queda, aunque luego pasen más cosas", () => {
    const limits = { ...LIMITS, maxMessages: 2 };
    const { conversation } = play(
      [open(), incoming(1, "a"), incoming(2, "b"), { direction: "close", atMs: 3 }],
      limits,
    );
    assert.equal(conversation.stopped, "message-cap");
  });
});

describe("lo que se guarda de un mensaje", () => {
  test("una trama grande se recorta y lo dice, con su tamaño real", () => {
    const limits = { ...LIMITS, maxMessageBytes: 8 };
    const { conversation } = play([open(), incoming(1, "0123456789ABCDEF")], limits);
    const [message] = conversation.messages;
    assert.equal(message.body, "01234567");
    assert.equal(message.bytes, 16);
    assert.equal(message.truncated, true);
  });

  test("los números de secuencia son monótonos y el tiempo es desde la apertura", () => {
    const { conversation } = play([open(100), outgoing(3, "ping"), incoming(7, "pong")]);
    assert.deepEqual(
      conversation.messages.map((message) => [message.seq, message.direction, message.atMs]),
      [
        [0, "out", 3],
        [1, "in", 7],
      ],
    );
    assert.equal(conversation.openedAtMs, 100);
  });
});

describe("la redacción, en las dos direcciones y antes que nada", () => {
  const secret = "sk-live-9f8e7d6c5b4a";

  test("un valor conocido sale tapado en lo que se manda y en lo que llega", () => {
    // `out` porque la primera trama de medio protocolo de socket del mundo es la de auth, e `in`
    // porque la respuesta a esa trama es la sesión que el servidor acaba de abrir.
    const { conversation } = play(
      [open(), outgoing(1, `{"type":"auth","token":"${secret}"}`), incoming(2, `{"ok":true,"echo":"${secret}"}`)],
      LIMITS,
      { secrets: [secret] },
    );
    for (const message of conversation.messages) assert.ok(!message.body.includes(secret), message.body);
    assert.match(conversation.messages[0].body, /••••••••/);
  });

  test("se tapa antes de recortar: el corte no deja media credencial en claro", () => {
    // El fallo que esto fija. Recortando primero, el token partido por el corte ya no coincide con
    // su valor, la redacción no lo encuentra, y lo guardado es la mitad del token sin marca.
    const body = `{"token":"${secret}"}`;
    const cut = body.indexOf(secret) + 8; // el corte cae en mitad del token
    const { conversation } = play(
      [open(), incoming(1, body)],
      { ...LIMITS, maxMessageBytes: cut },
      { secrets: [secret] },
    );
    assert.ok(!conversation.messages[0].body.includes(secret.slice(0, 8)), conversation.messages[0].body);
  });

  test("la regla por nombre de la aplicación se aplica sobre el texto entero, no sobre el recortado", () => {
    // Un JSON cortado no se parsea, y una regla que lo parsea no taparía nada sin decirlo.
    let seen = "";
    const redact = (text: string) => {
      seen = text;
      return text.replace(/"password":"[^"]*"/, '"password":"••••••••"');
    };
    const body = `{"password":"hunter2hunter2","relleno":"${"x".repeat(100)}"}`;
    const { conversation } = play([open(), incoming(1, body)], { ...LIMITS, maxMessageBytes: 30 }, { redact });
    assert.equal(seen, body, "la regla tiene que ver el mensaje entero");
    assert.ok(!conversation.messages[0].body.includes("hunter2"));
  });

  test("los secretos largos se tapan antes que los cortos que contienen", () => {
    assert.equal(maskSecrets("abcd-efgh-ijkl", ["abcd", "abcd-efgh-ijkl"]), "••••••••");
    // Y un valor de menos de cuatro caracteres no se tapa: taparía cada «a» de cada mensaje.
    assert.equal(maskSecrets("a la mar", ["a"]), "a la mar");
  });
});

describe("el veredicto", () => {
  test("conectar y no recibir nada, sin pedir nada, pasa — y lo dice", () => {
    const { conversation } = play([open(), { direction: "close", atMs: 5, closeCode: 1000 }]);
    const verdict = evaluateConversation({ expect: {}, conversation });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.failure, null);
    assert.equal(verdict.assertions.length, 1);
    assert.match(verdict.assertions[0].detail, /abierta \(101 en el upgrade\)/);
  });

  test("un upgrade rechazado dice con qué estado, que es lo que se puede arreglar", () => {
    const conversation = { ...blankConversation(), handshake: { status: 401, headers: {} } };
    const verdict = evaluateConversation({ expect: {}, conversation });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failure, "network");
    assert.match(verdict.assertions[0].detail, /401/);
  });

  test("lo que paró la guarda o una variable que faltaba es `config`, no `network`", () => {
    const verdict = evaluateConversation({
      expect: {},
      conversation: blankConversation(),
      openFailure: { kind: "config", detail: "falta la variable {{wsUrl}}" },
    });
    assert.equal(verdict.failure, "config");
    assert.equal(verdict.assertions[0].detail, "falta la variable {{wsUrl}}");
  });

  test("cada afirmación solo cuando el canal la pide", () => {
    const { conversation } = play([
      open(),
      incoming(40, '{"type":"hello"}'),
      { direction: "close", atMs: 50, closeCode: 1006 },
    ]);
    const verdict = evaluateConversation({
      expect: { minMessages: 2, closeCode: 1000, firstMessageBudgetMs: 100 },
      conversation,
    });
    assert.deepEqual(
      verdict.assertions.map((assertion) => [assertion.label, assertion.pass]),
      [
        ["Conexión", true],
        ["Al menos 2 mensaje(s)", false],
        ["Cierre 1000", false],
        ["Primer mensaje en menos de 100 ms", true],
      ],
    );
    assert.equal(verdict.failure, "check");
  });

  test("un primer mensaje lento es `latency`, que es otra persona y otro día", () => {
    const { conversation } = play([open(), incoming(900, "{}")]);
    const verdict = evaluateConversation({ expect: { firstMessageBudgetMs: 100 }, conversation });
    assert.equal(verdict.failure, "latency");
  });

  test("nunca rojo con todas las afirmaciones en verde, ni verde con una roja", () => {
    // El invariante que `holds()` existe para mantener: el veredicto y la lista no se contradicen.
    for (const expect of [{}, { minMessages: 1 }, { minMessages: 5 }, { closeCode: 1000 }]) {
      const { conversation } = play([open(), incoming(1, "a"), { direction: "close", atMs: 2, closeCode: 1000 }]);
      const verdict = evaluateConversation({ expect, conversation });
      assert.equal(verdict.ok, holds(verdict.assertions));
    }
  });
});

describe("las comprobaciones escritas, sobre N mensajes", () => {
  const { conversation } = play([
    open(),
    outgoing(1, '{"type":"ping"}'),
    incoming(2, '{"type":"welcome","user":{"id":7}}'),
    incoming(3, '{"type":"pong"}'),
    incoming(4, "texto suelto"),
  ]);

  const run = (checks: StepCheck[]) => evaluateConversation({ expect: { checks }, conversation }).assertions.slice(1);

  test("algún mensaje trae `type: pong`, que es la comprobación que de verdad se escribe", () => {
    const [check] = run([{ source: "message", path: "type", operator: "equals", value: "pong", match: { at: "any" } }]);
    assert.equal(check.pass, true);
    assert.equal(check.detail, "1 de 3 mensajes cumplen");
    assert.equal(check.label, "algún mensaje · type es pong");
  });

  test("todos, primero, último y una posición", () => {
    const [all, first, last, second] = run([
      { source: "message", operator: "exists", match: { at: "all" } },
      { source: "message", path: "user.id", operator: "equals", value: 7, match: { at: "first" } },
      { source: "message", operator: "contains", value: "suelto" },
      { source: "message", path: "type", operator: "equals", value: "pong", match: { at: "first", index: 1 } },
    ]);
    assert.equal(all.pass, true);
    assert.equal(first.pass, true);
    // Sin `match` es el último, y un mensaje que no es JSON se compara como texto.
    assert.equal(last.pass, true);
    assert.equal(second.pass, true);
  });

  test("lo enviado no se comprueba: los mensajes son solo los recibidos", () => {
    const [none] = run([{ source: "message", path: "type", operator: "equals", value: "ping", match: { at: "any" } }]);
    assert.equal(none.pass, false);
    const [count] = run([{ source: "messageCount", operator: "equals", value: 3 }]);
    assert.equal(count.pass, true);
  });

  test("`todos` sobre ningún mensaje falla: un verde ahí no afirmaría nada", () => {
    const silent = play([open()]).conversation;
    const [check] = evaluateConversation({
      expect: { checks: [{ source: "message", operator: "exists", match: { at: "all" } }] },
      conversation: silent,
    }).assertions.slice(1);
    assert.equal(check.pass, false);
    assert.equal(check.detail, "No llegó ningún mensaje");
  });

  test("y una comprobación de respuesta HTTP en un canal falla en vez de pasar contra algo inventado", () => {
    const [status] = run([{ source: "status", operator: "equals", value: 200 }]);
    assert.equal(status.pass, false);
  });
});

describe("las respuestas HTTP de siempre no cambian", () => {
  test("un paso de flujo sigue sin aceptar fuentes de conversación", () => {
    // El ensanche callado que esto vigila. El esquema de un flujo se exporta y se compara entre
    // versiones; si validara contra la lista completa, un paso HTTP aceptaría —y guardaría— una
    // comprobación sobre mensajes que nunca va a tener, y nada se pondría rojo.
    for (const source of ["message", "messageCount"]) {
      assert.equal(stepCheckSchema.safeParse({ source, operator: "exists" }).success, false, source);
    }
    assert.equal(stepCheckSchema.safeParse({ source: "status", operator: "equals", value: 200 }).success, true);
  });

  test("sin mensajes en el contexto, las fuentes de siempre se evalúan igual que antes", () => {
    // La extensión no puede tocar a los que no la usan: un flujo HTTP no pasa `messages`.
    const [assertion] = evaluateChecks([{ source: "status", operator: "equals", value: 200 }], {
      response: { status: 200, statusText: "OK", contentType: "", headers: {}, body: null, raw: "" },
      durationMs: 10,
    });
    assert.equal(assertion.pass, true);
    assert.equal(assertion.label, "status es 200");
  });
});

describe("una llamada gRPC, que cierra con un estado y unos trailers", () => {
  const SECRET = "tk-grpc-no-debe-salir-91ab";
  const rules: RedactionRules = { secrets: [SECRET], secretHeader: /^(authorization|set-cookie|.*-token)$/i };

  test("los trailers se guardan tapados: por nombre y por valor, antes de llegar a la fila", () => {
    const { conversation } = play(
      [
        open(),
        {
          direction: "close",
          atMs: 3,
          closeCode: 16,
          closeReason: `token ${SECRET} caducado`,
          trailers: { "x-session-token": "abc123", "x-debug": `vio ${SECRET}`, "x-region": "eu" },
        },
      ],
      LIMITS,
      rules,
    );
    assert.deepEqual(conversation.trailers, {
      "x-session-token": "••••••••",
      "x-debug": "vio ••••••••",
      "x-region": "eu",
    });
    assert.ok(!conversation.closeReason.includes(SECRET), conversation.closeReason);
  });

  test("las cabeceras de la apertura se tapan con la misma regla", () => {
    const { conversation } = play(
      [{ direction: "open", atMs: 0, handshake: { status: 200, headers: { "set-cookie": "s=1", via: SECRET } } }],
      LIMITS,
      rules,
    );
    assert.deepEqual(conversation.handshake?.headers, { "set-cookie": "••••••••", via: "••••••••" });
    // Y un WebSocket sin trailers sigue sin ellos: `null`, no `{}`.
    assert.equal(conversation.trailers, null);
  });

  test("el estado esperado se afirma con su nombre, y el detalle trae el del servidor", () => {
    const { conversation } = play([
      { direction: "open", atMs: 0, handshake: { status: 200, headers: {}, via: "inicio de la llamada" } },
      { direction: "close", atMs: 5, closeCode: 14, closeReason: "sin backend", trailers: {} },
    ]);
    const verdict = evaluateConversation({ expect: { status: 0 }, conversation });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failure, "check");
    assert.deepEqual(
      verdict.assertions.map((assertion) => [assertion.label, assertion.pass, assertion.detail]),
      [
        ["Conexión", true, "abierta (200 en el inicio de la llamada)"],
        ["Estado OK (0)", false, "terminó con UNAVAILABLE (14): sin backend"],
      ],
    );
  });

  test("una llamada que no terminó no pasa el estado, y lo dice", () => {
    const { conversation } = play([open(), incoming(1, "{}")]);
    const [, status] = evaluateConversation({ expect: { status: 0 }, conversation }).assertions;
    assert.equal(status.pass, false);
    assert.equal(status.detail, "la llamada no llegó a terminar");
  });

  test("los nombres siguen el estándar: el número es la posición", () => {
    assert.equal(GRPC_STATUS_NAMES[4], "DEADLINE_EXCEEDED");
    assert.equal(GRPC_STATUS_NAMES[16], "UNAUTHENTICATED");
    assert.equal(grpcStatusName(99), "desconocido (99)");
  });
});
