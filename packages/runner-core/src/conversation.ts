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

/**
 * `event` es lo que pasa en la sesión sin ser un mensaje: suscribirse o dejar de hacerlo a mitad de
 * una sesión MQTT, y lo que el broker contesta. Va en la transcripción porque es parte de la
 * historia —«desde aquí se oye `alarmas/#`» explica por qué empiezan a llegar mensajes—, pero no
 * cuenta como enviado ni como recibido: un `SUBACK` que contara como mensaje haría pasar un «al
 * menos un mensaje» sin que llegara ninguno.
 */
export const MESSAGE_DIRECTIONS = ["out", "in", "open", "close", "error", "event"] as const;
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
  /** Las propiedades de MQTT 5 que traía el mensaje, **ya tapadas**. Ausente si no traía ninguna. */
  properties?: MessageProperties;
  /**
   * Solo Socket.IO: el nombre del evento, en los dos sentidos. Un servidor Socket.IO no habla en
   * mensajes sino en eventos con nombre, y «llegó un mensaje» sin decir cuál es tan poco útil como un
   * MQTT sin tema. Se tapa por valor, como el tema.
   */
  event?: string;
  /**
   * Solo Socket.IO: en un mensaje enviado, que se pidió acuse; en uno recibido, que **es** el acuse
   * —lo que el servidor devolvió al callback del evento `event`—. Cuenta como recibido, porque es la
   * respuesta del servidor y lo que la mayoría de las APIs Socket.IO contestan.
   */
  ack?: boolean;
};

/**
 * Lo que un `PUBLISH` de MQTT 5 lleva además del cuerpo, y que sirve al depurar: las propiedades de
 * usuario (una lista, porque el protocolo admite el mismo nombre varias veces), el tipo de contenido
 * y el tema y los datos de correlación de una petición-respuesta.
 *
 * Los datos de correlación son bytes: van como texto si lo son y como hexadecimal si no, y
 * `correlationEncoding` lo dice, porque «a1b2» podría ser cualquiera de las dos cosas.
 *
 * **Se tapan como las cabeceras**: el valor de una propiedad que se llama como una credencial,
 * entero; los secretos conocidos, por su valor, en todas. Una propiedad `authorization` es una
 * cabecera con otro nombre, y el broker la reenvía a todo el que escucha.
 */
export type MessageProperties = {
  userProperties?: [string, string][];
  contentType?: string;
  responseTopic?: string;
  correlationData?: string;
  correlationEncoding?: "text" | "hex";
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
  /**
   * Lo que llega **con** el cierre: los trailers de una llamada gRPC, donde viaja su estado y lo que
   * el servidor quiera añadir. `null` en un WebSocket, que cierra con un código y una frase y nada
   * más; `{}` en una llamada que terminó sin trailers propios.
   */
  trailers: Record<string, string> | null;
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
  /** Los trailers de una llamada gRPC, crudos: se tapan aquí dentro, como el cuerpo. */
  trailers?: Record<string, string>;
} & MessageRouting;

/**
 * Cómo se tapa lo que va dentro de un mensaje.
 *
 * `secrets` son valores concretos —lo que salió de las variables del entorno— y `redact` es la
 * regla por nombre que vive en la aplicación (los campos que suenan a credencial, los JWT por su
 * forma). Este paquete no conoce ninguna de las dos cosas y no debe: recibe las dos y las aplica.
 */
export type RedactionRules = {
  secrets?: string[];
  redact?: (text: string) => string;
  /**
   * Los nombres de cabecera cuyo valor se tapa entero, sea cual sea: `authorization`, `set-cookie`…
   * Lo usan las cabeceras de la apertura y los trailers, que también son texto que el servidor
   * escribe y que se guarda. La lista vive en la aplicación, como `redact`.
   */
  secretHeader?: RegExp;
};

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
    trailers: null,
    stopped: null,
    counters: { sent: 0, received: 0, bytesIn: 0, bytesOut: 0 },
  };
}

/**
 * Unas cabeceras con lo que no se guarda tapado: por nombre —las que suenan a credencial— y por
 * valor —los secretos conocidos—.
 *
 * Aparte del cuerpo y por la misma regla que él: las cabeceras de la apertura y los trailers de
 * gRPC van a la fila y a la trama en vivo igual que un mensaje, y un `set-cookie` o un token que el
 * servidor devuelve en un trailer es una credencial guardada en claro si solo se tapan los cuerpos.
 */
export function redactHeaders(headers: Record<string, string>, rules: RedactionRules = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      rules.secretHeader?.test(name) && value ? MASK : maskSecrets(value, rules.secrets ?? []),
    ]),
  );
}

/** Cada secreto, y también su UTF-8 en hexadecimal (en minúsculas, que es como se vuelca). */
function withHex(secrets: string[]): string[] {
  return [...secrets, ...secrets.map((secret) => hexOf(secret))];
}

const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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
        handshake: frame.handshake
          ? { ...frame.handshake, headers: redactHeaders(frame.handshake.headers, rules) }
          : conversation.handshake,
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
        // La frase del cierre también es texto del servidor: un `details` de gRPC que repite el
        // token que no le gustó se tapa como un mensaje.
        closeReason: maskSecrets(frame.closeReason ?? "", rules.secrets ?? []),
        trailers: frame.trailers ? redactHeaders(frame.trailers, rules) : conversation.trailers,
        stopped: conversation.stopped ?? "closed-by-peer",
      },
      stop: "closed-by-peer",
    };
  }

  const raw = frame.body ?? "";
  const bytes = frame.bytes ?? byteLength(raw);
  // El texto también se mira: un mensaje gRPC cuenta los bytes del cable, y su JSON —lo que se
  // guarda— puede pasar del tope aunque el cable no. El tope del cuerpo es del cuerpo.
  const truncated =
    bytes > limits.maxMessageBytes || (frame.kind !== "binary" && byteLength(raw) > limits.maxMessageBytes);
  // Se tapa **antes** de recortar, por dos motivos y los dos silenciosos. Un token que el corte
  // parte por la mitad ya no coincide con su valor, así que la redacción por valor no lo encuentra
  // y se guarda media credencial en claro. Y un JSON cortado no se parsea, así que la redacción
  // por nombre de campo —que lo parsea— no tapa nada y no avisa. Recortar lo ya tapado no puede
  // destapar nada.
  // Un mensaje binario se guarda como hexadecimal de sus bytes: un secreto que viajó dentro no se
  // parece a sí mismo ahí, así que se busca también su volcado. Sin esto, un token mandado o devuelto
  // en una trama binaria quedaba en la fila en claro, solo que en hexadecimal.
  const secrets = frame.kind === "binary" ? withHex(rules.secrets ?? []) : (rules.secrets ?? []);
  const redacted = maskSecrets(rules.redact ? rules.redact(raw) : raw, secrets);
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

  // Un evento no es tráfico: ni se envía ni se recibe, y sus bytes son los de una frase nuestra.
  const incoming = frame.direction === "in" || frame.direction === "error";
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
 * El tema, la QoS y el `retain` (y el evento de Socket.IO), solo los que la trama trae.
 *
 * El tema se tapa **solo por valor**, con la lista de secretos: la regla por nombre de campo parsea
 * JSON y un tema no lo es. Y no se recorta: la especificación ya lo limita a 64 KB.
 */
function routingOf(frame: RawFrame, rules: RedactionRules): MessageRouting {
  const properties = frame.properties ? redactProperties(frame.properties, rules) : null;
  return {
    ...(frame.topic !== undefined ? { topic: maskSecrets(frame.topic, rules.secrets ?? []) } : {}),
    ...(frame.qos !== undefined ? { qos: frame.qos } : {}),
    ...(frame.retain !== undefined ? { retain: frame.retain } : {}),
    ...(properties ? { properties } : {}),
    ...(frame.event !== undefined ? { event: maskSecrets(frame.event, rules.secrets ?? []) } : {}),
    ...(frame.ack !== undefined ? { ack: frame.ack } : {}),
  };
}

/**
 * Las propiedades de un mensaje, tapadas con las mismas reglas que una cabecera y que un cuerpo.
 *
 * Una propiedad de usuario es una cabecera con otro nombre: su nombre decide si el valor se tapa
 * entero (`secretHeader`), y después pasan la regla por forma (`redact`, que tapa un JWT) y los
 * secretos conocidos. El tema de respuesta es un tema, y se tapa como uno; los datos de correlación
 * en texto, como un cuerpo. En hexadecimal no hay nada que buscar por valor, y se dejan: un secreto
 * que viaja como bytes no se reconoce en su volcado, igual que en un mensaje binario.
 */
export function redactProperties(properties: MessageProperties, rules: RedactionRules = {}): MessageProperties | null {
  const secrets = rules.secrets ?? [];
  const text = (value: string) => maskSecrets(rules.redact ? rules.redact(value) : value, secrets);
  const out: MessageProperties = {};
  if (properties.userProperties?.length) {
    out.userProperties = properties.userProperties.map(([name, value]) => [
      maskSecrets(name, secrets),
      rules.secretHeader?.test(name) && value ? MASK : text(value),
    ]);
  }
  if (properties.contentType) out.contentType = maskSecrets(properties.contentType, secrets);
  if (properties.responseTopic) out.responseTopic = maskSecrets(properties.responseTopic, secrets);
  if (properties.correlationData !== undefined) {
    const hex = properties.correlationEncoding === "hex";
    out.correlationData = hex ? properties.correlationData : text(properties.correlationData);
    out.correlationEncoding = hex ? "hex" : "text";
  }
  return Object.keys(out).length ? out : null;
}

/** Lo que el canal afirma de su conversación, más las comprobaciones escritas a mano. */
export type ChannelExpectation = {
  /** Cuántos mensajes tienen que llegar. Ausente: no se afirma nada sobre el número. */
  minMessages?: number;
  /** El código de cierre esperado. 1000 contra 1006 es «se despidió» contra «se murió». */
  closeCode?: number;
  /**
   * El estado gRPC esperado al terminar la llamada: `0` es OK. Aparte de `closeCode` aunque los dos
   * se comparan con el mismo número de la conversación, porque no significan lo mismo —un 0 no es
   * un código de cierre de WebSocket, ni un 1000 un estado de gRPC— y la etiqueta tiene que decir
   * cuál de las dos cosas se afirma.
   */
  status?: number;
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

  // 3b. El estado de una llamada gRPC, solo si el canal declara uno. Con su nombre, porque «14» no
  //     le dice nada a nadie y «UNAVAILABLE» sí.
  if (expect.status !== undefined) {
    const got = conversation.closeCode;
    assertions.push({
      label: `Estado ${grpcStatusName(expect.status)}`,
      pass: got === expect.status,
      detail:
        got === null
          ? "la llamada no llegó a terminar"
          : `terminó con ${grpcStatusName(got)}${conversation.closeReason ? `: ${conversation.closeReason}` : ""}`,
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

/**
 * Los estados de gRPC por su nombre, en el orden del estándar: el número es la posición.
 *
 * Aquí y no en la API porque el veredicto los nombra, y el veredicto se decide en este paquete.
 */
export const GRPC_STATUS_NAMES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

export const grpcStatusName = (code: number): string => `${GRPC_STATUS_NAMES[code] ?? "desconocido"} (${code})`;

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
