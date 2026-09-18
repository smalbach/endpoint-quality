/**
 * Una conversación: lo que sustituye a «la respuesta» cuando el protocolo no tiene una.
 *
 * Todo lo que hay en este paquete está construido sobre una petición y **una** respuesta: un
 * estado, unas cabeceras, un cuerpo, y un veredicto sobre esos tres. Un WebSocket no tiene eso.
 * Tiene una apertura que puede fallar con un 401, una tanda de mensajes en las dos direcciones que
 * llegan cuando llegan, y un cierre que dice algo por sí mismo. Medir eso como si fuera una
 * respuesta obliga a mentir en algún campo, y este fichero existe para no tener que hacerlo.
 *
 * **Puro y sin E/S**, como `flow.ts`: recibe tramas ya leídas y devuelve la conversación con la
 * trama dentro. Quien abre el socket, quien cuenta los segundos y quien lo cierra está fuera. Eso
 * es lo que permite probar los cinco topes con listas escritas a mano, sin abrir un puerto, que es
 * la única forma de que esas pruebas se corran en cada cambio.
 *
 * El veredicto vuelve como el mismo `Evaluation` que devuelve `evaluateResponse`. No se comparte el
 * código —aquel está construido sobre `expectedStatus`, el envelope y el esquema, y aquí no hay
 * nada de eso— pero sí el tipo y, sobre todo, `holds()`: qué cuenta como «pasa» se decide en un
 * solo sitio del producto, y `FailureKind` sigue siendo el único vocabulario para clasificar un
 * rojo. Dos motores de veredicto con dos ideas de «verde» es cómo una pantalla dice una cosa y otra
 * dice la contraria.
 */
import type { ActualResponse, Evaluation } from "./assertions.ts";
import { evaluateChecks, type CheckMessage, type StepCheck } from "./checks.ts";
import { holds, type Assertion, type FailureKind } from "./types.ts";

export const MESSAGE_DIRECTIONS = ["out", "in", "open", "close", "error"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_KINDS = ["text", "binary", "ping", "pong"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * Un mensaje, ya guardable.
 *
 * `atMs` va **desde la apertura** y no como reloj de pared, porque una conversación se lee por sus
 * huecos: «+12 ms, +4 ms, +3.200 ms» dice dónde está el problema y tres marcas de hora no.
 *
 * `bytes` es el tamaño real y `body` puede venir recortado: los dos, porque «llegaron 4 MB y aquí
 * tienes los primeros 64 KB» es una frase honesta y «aquí tienes 64 KB» no lo es.
 */
export type ChannelMessage = {
  /** Monótono dentro de la sesión, y la mitad de su clave primaria cuando se guarde. */
  seq: number;
  direction: MessageDirection;
  atMs: number;
  kind: MessageKind;
  /** Ya redactado. Lo binario entra como hexadecimal de lo que quepa, nunca la trama entera. */
  body: string;
  bytes: number;
  truncated: boolean;
} & MessageRouting;

/**
 * Por dónde viajó un mensaje, en los protocolos que lo dicen: hoy MQTT.
 *
 * Opcional y ausente en un WebSocket, que no tiene temas: un campo vacío en cada mensaje de socket
 * sería una columna que se enseña y no significa nada. El tema **se tapa** como el cuerpo —un
 * `dispositivos/<token>/estado` existe—, y QoS y `retain` van tal cual, porque son lo que distingue
 * un mensaje retenido de uno recién publicado y es justo lo que se quiere ver al depurar.
 */
export type MessageRouting = {
  topic?: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
};

/**
 * La apertura, en el protocolo que sea.
 *
 * `via` nombra el paso que contestó —el `upgrade` de un WebSocket, el `CONNACK` de MQTT— para que el
 * veredicto diga «0 en el CONNACK» y no «0 en el upgrade», que en MQTT sería un upgrade que no hubo.
 * Ausente es `upgrade`, que es lo que tienen todas las filas de antes.
 */
export type Handshake = { status: number; headers: Record<string, string>; via?: string };

/**
 * Por qué se dejó de escuchar.
 *
 * Alcanzar un tope **no es un error**: es un hecho de la sesión, y la diferencia importa porque un
 * rojo se le enseña a alguien y un hecho se cuenta. «Se cortó: tope de 200 mensajes» es una frase
 * que se entiende; un fallo genérico en el mismo sitio manda a leer logs.
 */
export const STOP_REASONS = [
  "closed-by-peer",
  "closed-by-us",
  "message-cap",
  "byte-cap",
  "time-cap",
  "idle-cap",
  "cancelled",
  "handshake-failed",
  "transport-error",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export type Conversation = {
  messages: ChannelMessage[];
  /** Lo que contestó la apertura (el `Upgrade`, el `CONNACK`). `null` mientras no haya contestado. */
  handshake: Handshake | null;
  openedAtMs: number | null;
  closedAtMs: number | null;
  closeCode: number | null;
  closeReason: string;
  stopped: StopReason | null;
  counters: { sent: number; received: number; bytesIn: number; bytesOut: number };
};

/**
 * Los cinco topes, y los cinco obligatorios.
 *
 * `idleMs` es el que de verdad atrapa el socket colgado: con solo el tope de duración, **toda**
 * sesión contra un servidor callado cuesta los treinta segundos enteros, y veinte de esas son diez
 * minutos de proceso esperando a nadie.
 *
 * `maxMessageBytes` no es un lujo al lado de `maxBytes`: se le pasa además a la biblioteca como
 * tope de trama, y hace falta porque `permessage-deflate` cuenta **después** de inflar. Sin él,
 * 10 KB en el cable pueden ser 1 GB en el contador que iba a pararlos.
 */
export type ChannelLimits = {
  maxMessages: number;
  maxBytes: number;
  maxMessageBytes: number;
  maxDurationMs: number;
  idleMs: number;
};

/** Lo que el transporte entrega: la trama cruda, antes de redactar y antes de recortar. */
export type RawFrame = {
  direction: MessageDirection;
  atMs: number;
  kind?: MessageKind;
  body?: string;
  /** El tamaño real, cuando el transporte lo sabe mejor que la longitud del texto (binario). */
  bytes?: number;
  handshake?: Handshake;
  closeCode?: number;
  closeReason?: string;
} & MessageRouting;

/**
 * Cómo se tapa lo que va dentro de un mensaje.
 *
 * `secrets` son valores concretos —lo que salió de las variables del entorno— y `redact` es la
 * regla por nombre que vive en la aplicación (los campos que suenan a credencial, los JWT por su
 * forma). Este paquete no conoce ninguna de las dos cosas y no debe: recibe las dos y las aplica.
 */
export type RedactionRules = { secrets?: string[]; redact?: (text: string) => string };

/** Ocho puntos, los mismos que usa el resto del producto para decir «aquí había algo». */
const MASK = "••••••••";

export function blankConversation(): Conversation {
  return {
    messages: [],
    handshake: null,
    openedAtMs: null,
    closedAtMs: null,
    closeCode: null,
    closeReason: "",
    stopped: null,
    counters: { sent: 0, received: 0, bytesIn: 0, bytesOut: 0 },
  };
}

/** Los valores conocidos, fuera del texto. Se tapan los largos primero, o uno corto parte a otro. */
export function maskSecrets(text: string, secrets: string[]): string {
  return [...secrets]
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.split(secret).join(MASK), text);
}

/**
 * La trama, dentro de la conversación.
 *
 * Recibe la trama **cruda** y devuelve solo el mensaje ya tapado, y eso es deliberado y estructural:
 * hay dos caminos de escritura por mensaje —la fila que se guarda y la trama que sale en vivo hacia
 * el navegador— y una sola redacción aplicada «al guardar» falla **en verde**. La fila queda limpia,
 * la prueba que busca el token en la fila pasa, y el secreto está en la memoria del navegador, en la
 * pestaña de red y en la captura de pantalla que alguien va a pegar en un chat. Con esta firma, el
 * texto crudo no queda al alcance de quien publica.
 *
 * Devuelve el motivo de parada cuando esta trama lo alcanza. Quien llama decide qué hacer con él
 * —cerrar con 1000— porque cerrar es E/S y aquí no hay.
 */
export function applyFrame(
  conversation: Conversation,
  frame: RawFrame,
  limits: ChannelLimits,
  rules: RedactionRules = {},
): { conversation: Conversation; stop: StopReason | null } {
  if (frame.direction === "open") {
    return {
      conversation: {
        ...conversation,
        handshake: frame.handshake ?? conversation.handshake,
        openedAtMs: conversation.openedAtMs ?? frame.atMs,
      },
      stop: null,
    };
  }

  if (frame.direction === "close") {
    return {
      conversation: {
        ...conversation,
        closedAtMs: frame.atMs,
        closeCode: frame.closeCode ?? null,
        closeReason: frame.closeReason ?? "",
        stopped: conversation.stopped ?? "closed-by-peer",
      },
      stop: "closed-by-peer",
    };
  }

  const raw = frame.body ?? "";
  const bytes = frame.bytes ?? byteLength(raw);
  const truncated = bytes > limits.maxMessageBytes;
  // Se tapa **antes** de recortar, por dos motivos y los dos silenciosos. Un token que el corte
  // parte por la mitad ya no coincide con su valor, así que la redacción por valor no lo encuentra
  // y se guarda media credencial en claro. Y un JSON cortado no se parsea, así que la redacción
  // por nombre de campo —que lo parsea— no tapa nada y no avisa. Recortar lo ya tapado no puede
  // destapar nada.
  const redacted = maskSecrets(rules.redact ? rules.redact(raw) : raw, rules.secrets ?? []);
  const body = truncated ? redacted.slice(0, limits.maxMessageBytes) : redacted;

  const message: ChannelMessage = {
    seq: conversation.messages.length,
    direction: frame.direction,
    atMs: frame.atMs,
    kind: frame.kind ?? "text",
    body,
    bytes,
    truncated,
    ...routingOf(frame, rules),
  };

  const incoming = frame.direction !== "out";
  const counters = {
    sent: conversation.counters.sent + (frame.direction === "out" ? 1 : 0),
    received: conversation.counters.received + (frame.direction === "in" ? 1 : 0),
    bytesIn: conversation.counters.bytesIn + (incoming ? bytes : 0),
    bytesOut: conversation.counters.bytesOut + (frame.direction === "out" ? bytes : 0),
  };

  // El orden es el de la gravedad, no el del código: un error de transporte se anota aunque la
  // misma trama pase de un tope, porque es lo que hay que contar.
  const stop: StopReason | null =
    frame.direction === "error"
      ? "transport-error"
      : frame.atMs >= limits.maxDurationMs
        ? "time-cap"
        : counters.bytesIn > limits.maxBytes
          ? "byte-cap"
          : conversation.messages.length + 1 >= limits.maxMessages
            ? "message-cap"
            : null;

  return {
    conversation: {
      ...conversation,
      messages: [...conversation.messages, message],
      counters,
      stopped: conversation.stopped ?? stop,
    },
    stop,
  };
}

/**
 * El tema, la QoS y el `retain`, solo los que la trama trae.
 *
 * El tema se tapa **solo por valor**, con la lista de secretos: la regla por nombre de campo parsea
 * JSON y un tema no lo es. Y no se recorta: la especificación ya lo limita a 64 KB.
 */
function routingOf(frame: RawFrame, rules: RedactionRules): MessageRouting {
  return {
    ...(frame.topic !== undefined ? { topic: maskSecrets(frame.topic, rules.secrets ?? []) } : {}),
    ...(frame.qos !== undefined ? { qos: frame.qos } : {}),
    ...(frame.retain !== undefined ? { retain: frame.retain } : {}),
  };
}

/** Lo que el canal afirma de su conversación, más las comprobaciones escritas a mano. */
export type ChannelExpectation = {
  /** Cuántos mensajes tienen que llegar. Ausente: no se afirma nada sobre el número. */
  minMessages?: number;
  /** El código de cierre esperado. 1000 contra 1006 es «se despidió» contra «se murió». */
  closeCode?: number;
  /** Cuánto puede tardar el primer mensaje. Propio, y no el presupuesto publicado del contrato. */
  firstMessageBudgetMs?: number;
  checks?: StepCheck[];
};

export type EvaluateConversationInput = {
  expect: ChannelExpectation;
  conversation: Conversation;
  /** Por qué no se pudo abrir, cuando no se pudo. Lo sabe quien abrió, no esta función. */
  openFailure?: { kind: "network" | "config"; detail: string } | null;
};

/**
 * El veredicto.
 *
 * Cada afirmación **solo cuando aplica**, que es la regla que ya documenta `checks.ts`: una marca
 * verde que no afirma nada es exactamente lo que este producto vino a sustituir. Por eso un canal
 * que conecta, no recibe nada y no pidió recibir nada **pasa** — y lo dice con todas las letras,
 * porque un verde mudo ahí es indistinguible de un canal roto.
 */
export function evaluateConversation(input: EvaluateConversationInput): Evaluation {
  const { conversation, expect } = input;
  const assertions: Assertion[] = [];

  // 1. La conexión, siempre. Y con el estado del `Upgrade` dentro cuando lo hubo: un `ws` que
  //    contesta 401 es donde está la mayoría de los fallos de verdad, y «no se pudo conectar» sin
  //    ese 401 no le sirve a nadie para arreglar nada.
  const connected = conversation.openedAtMs !== null && !input.openFailure;
  assertions.push({
    label: "Conexión",
    pass: connected,
    detail: connected
      ? `abierta${conversation.handshake ? ` (${conversation.handshake.status} en el ${conversation.handshake.via ?? "upgrade"})` : ""}`
      : handshakeDetail(input),
  });

  const received = conversation.messages.filter((message) => message.direction === "in");

  // 2. El número de mensajes, solo si el canal declara uno.
  if (expect.minMessages !== undefined) {
    assertions.push({
      label: `Al menos ${expect.minMessages} mensaje(s)`,
      pass: received.length >= expect.minMessages,
      detail: `llegaron ${received.length}`,
    });
  }

  // 3. El cierre, solo si el canal declara uno.
  if (expect.closeCode !== undefined) {
    assertions.push({
      label: `Cierre ${expect.closeCode}`,
      pass: conversation.closeCode === expect.closeCode,
      detail: conversation.closeCode === null ? "no llegó a cerrarse" : `cerró con ${conversation.closeCode}`,
    });
  }

  // 4. Lo escrito a mano, que es el trabajo de verdad. Mismo motor que el de una respuesta: los
  //    doce operadores, las rutas al JSON y las etiquetas generadas son los de allí.
  if (expect.checks?.length) {
    assertions.push(
      ...evaluateChecks(expect.checks, {
        response: NO_RESPONSE,
        durationMs: conversation.closedAtMs ?? lastAt(conversation),
        messages: received as CheckMessage[],
      }),
    );
  }

  // 5. El presupuesto del primer mensaje, **solo si el canal declara el suyo**. Reutilizar el del
  //    contrato sería poner la etiqueta de una medida publicada encima de otra distinta.
  if (expect.firstMessageBudgetMs !== undefined) {
    const first = received[0];
    assertions.push({
      label: `Primer mensaje en menos de ${expect.firstMessageBudgetMs} ms`,
      pass: first !== undefined && first.atMs < expect.firstMessageBudgetMs,
      detail: first ? `${first.atMs} ms` : "no llegó ningún mensaje",
    });
  }

  const ok = holds(assertions);
  return { ok, failure: ok ? null : failureOf(input, assertions), assertions, notImplemented: false };
}

/**
 * La respuesta que una conversación no tiene.
 *
 * `evaluateChecks` la pide porque las fuentes `status`, `header` y `body` la leen. Aquí no aplican,
 * y un `status equals 200` escrito en un canal falla contra este 0 en vez de pasar contra algo
 * inventado: es la forma correcta de que una comprobación mal elegida se note.
 */
const NO_RESPONSE: ActualResponse = { status: 0, statusText: "", contentType: "", headers: {}, body: null, raw: "" };

function handshakeDetail(input: EvaluateConversationInput): string {
  if (input.openFailure) return input.openFailure.detail;
  const status = input.conversation.handshake?.status;
  return status ? `el upgrade contestó ${status}` : "no se pudo conectar";
}

const lastAt = (conversation: Conversation): number =>
  conversation.messages.length ? conversation.messages[conversation.messages.length - 1].atMs : 0;

/**
 * De quién es el rojo.
 *
 * El mismo vocabulario que una corrida HTTP y por el mismo motivo: una lista de cuarenta rojos solo
 * se puede repartir si cada uno dice a quién le toca. Un canal que no abrió es `network` —o `config`
 * si lo paró la guarda o faltaba una variable, que es otra persona y otro día—; uno que abrió y no
 * cumplió lo que se le pedía es `check`.
 */
function failureOf(input: EvaluateConversationInput, assertions: Assertion[]): FailureKind {
  if (input.openFailure) return input.openFailure.kind;
  if (input.conversation.openedAtMs === null) return "network";
  const failed = assertions.find((assertion) => !assertion.pass && assertion.severity !== "warning");
  if (failed?.label.startsWith("Primer mensaje")) return "latency";
  return "check";
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;
