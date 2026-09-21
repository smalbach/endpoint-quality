/**
 * Un canal: lo que un proyecto prueba cuando lo que prueba no es una petición. Un WebSocket, un
 * broker MQTT o un servicio gRPC (lo propio de cada uno vive en `mqtt.ts` y en `grpc.ts`).
 *
 * Es un agregado hermano de `Endpoint` y no un tipo de él. El motivo entero está en la migración
 * `1700000028000-Channels`; aquí basta con saber lo que eso compra: el mock, la documentación
 * publicada, la matriz de roles, la corrida de seguridad y el resto de lectores de `Endpoint` no
 * tienen que acordarse de filtrar sockets, porque no hay sockets entre sus filas.
 *
 * Lo que sí se comparte, y a propósito: la forma de una cabecera (`EndpointHeader`), la validación
 * de la autenticación (`authProblems`) y el motor de comprobaciones de `runner-core`. Copiarlos
 * sería tener dos respuestas a «¿esta cabecera es válida?» que un día dejan de coincidir.
 */
import {
  CONVERSATION_CHECK_SOURCES,
  CHECK_OPERATORS,
  MESSAGE_MATCHES,
  topicFilterProblem,
  type ChannelExpectation,
  type ChannelLimits,
  type RequestAuth,
  type StepCheck,
} from "@eq/runner-core";

import { authProblems, type EndpointHeader } from "@/modules/endpoints/domain/model";
import { SECRET_HEADER } from "@/modules/endpoints/domain/examples";
import { redactAuth, storableParams } from "@/modules/workflows/domain/postman-auth";
import {
  DEFAULT_MQTT,
  brokerUrlProblems,
  mergedSettings,
  protocolProblems,
  type MqttQos,
  type MqttSettings,
} from "./mqtt";
import {
  DEFAULT_GRPC_SETTINGS,
  grpcExpectationProblems,
  grpcSettingsProblems,
  grpcUrlProblems,
  binaryMetadataProblem,
  isBinaryMetadata,
  metadataKeyProblem,
  type GrpcSettings,
} from "./grpc";
import {
  DEFAULT_SOCKETIO,
  mergedSocketIo,
  socketIoProblems,
  socketIoUrlProblems,
  type SocketIoSettings,
} from "./socketio";

type Problem = { field: string; detail: string };

export const CHANNEL_PROTOCOLS = ["ws", "mqtt", "grpc", "socketio"] as const;
export type ChannelProtocol = (typeof CHANNEL_PROTOCOLS)[number];

export const MAX_CHANNEL_NAME = 120;
export const MAX_CHANNEL_URL = 2_000;
export const MAX_CHANNELS_PER_PROJECT = 200;
export const MAX_SUBPROTOCOLS = 10;
export const MAX_CHANNEL_HEADERS = 50;
export const MAX_CHANNEL_CHECKS = 50;
/** Las tramas guardadas. Una biblioteca, no un historial: lo que se manda a menudo. */
export const MAX_SAVED_MESSAGES = 30;
export const MAX_SAVED_MESSAGE_BYTES = 64 * 1024;

/**
 * Un subprotocolo es un `token` de HTTP: sin espacios ni separadores.
 *
 * Se valida aquí y no se deja a la biblioteca porque `ws` lanza con un mensaje en inglés sobre la
 * cabecera `Sec-WebSocket-Protocol` en el momento de conectar, y eso es un fallo en la pantalla de
 * la sesión por algo que se escribió mal en la del canal.
 */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_NAME = TOKEN;

/**
 * Las cabeceras que no escribe quien crea el canal.
 *
 * `Host` la pone la conexión con el nombre de la URL —ver `safe-socket.ts`—, y las `Sec-WebSocket-*`
 * y `Upgrade`/`Connection` son el propio protocolo: fijarlas a mano es romper el handshake y
 * descubrirlo al conectar con un error que no nombra la cabecera.
 */
const RESERVED_HEADERS = new Set([
  "host",
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/**
 * Una trama guardada, con nombre, para no reteclear la de auth en cada sesión.
 *
 * En MQTT lleva además a dónde se publica: una trama sin tema no se puede mandar. En Socket.IO, el
 * evento que emite.
 */
export type SavedMessage = {
  name: string;
  body: string;
  topic?: string;
  qos?: MqttQos;
  retain?: boolean;
  event?: string;
};

export type Channel = {
  id: string;
  projectId: string;
  protocol: ChannelProtocol;
  name: string;
  /** Con `{{variables}}` si hace falta: se resuelve contra el entorno al abrir la sesión. */
  url: string;
  subprotocols: string[];
  headers: EndpointHeader[];
  auth: RequestAuth | null;
  limits: ChannelLimits;
  expectations: ChannelExpectation;
  messages: SavedMessage[];
  /** Solo en un canal MQTT: el broker, la sesión y las suscripciones. `null` en los demás. */
  mqtt: MqttSettings | null;
  /** Solo en un canal gRPC: servicio, método, mensaje y plazo. `null` en los demás. */
  grpc: GrpcSettings | null;
  /** Solo en un canal Socket.IO: ruta, espacio de nombres, carga de `auth` y eventos. `null` en los demás. */
  socketio: SocketIoSettings | null;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
  /** Fuera de la lista sin perderse, como el resto de recursos. Ver `shared/lifecycle`. */
  archivedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * Los techos del despliegue, que son el máximo que un canal puede pedir.
 *
 * Viven en `env` y llegan aquí como un valor: el dominio no lee el entorno, pero tiene que saber
 * dónde está el techo para poder decir «como mucho 30 segundos» en vez de guardar 3.600 y recortar
 * en silencio al abrir.
 */
export type ChannelCeilings = ChannelLimits & { maxOpen: number };

/** Lo que un canal nuevo pide si no dice nada: lo que una prueba de un socket necesita de verdad. */
export const DEFAULT_LIMITS: ChannelLimits = {
  maxMessages: 200,
  maxBytes: 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  maxDurationMs: 30_000,
  idleMs: 10_000,
};

/**
 * Los topes de un canal, sin pasar del techo.
 *
 * Recorta y no rechaza cuando el techo **bajó** después de guardar el canal: un despliegue que pasa
 * de 60 a 30 segundos no puede dejar inservibles los canales que se crearon antes. Al guardar sí
 * se rechaza —`channelProblems`—, porque ahí quien escribe está delante para verlo.
 */
export function effectiveLimits(limits: ChannelLimits, ceilings: ChannelCeilings): ChannelLimits {
  return {
    maxMessages: Math.min(limits.maxMessages, ceilings.maxMessages),
    maxBytes: Math.min(limits.maxBytes, ceilings.maxBytes),
    maxMessageBytes: Math.min(limits.maxMessageBytes, ceilings.maxMessageBytes),
    maxDurationMs: Math.min(limits.maxDurationMs, ceilings.maxDurationMs),
    idleMs: Math.min(limits.idleMs, ceilings.idleMs),
  };
}

export type ChannelInput = {
  /** Solo al crear: un canal no cambia de protocolo. Al cambiarlo, lo pone quien valida. */
  protocol?: ChannelProtocol;
  name?: string;
  url?: string;
  subprotocols?: string[];
  headers?: EndpointHeader[];
  auth?: RequestAuth | null;
  limits?: Partial<ChannelLimits>;
  expectations?: ChannelExpectation;
  messages?: SavedMessage[];
  mqtt?: Partial<MqttSettings> | null;
  grpc?: Partial<GrpcSettings>;
  socketio?: Partial<SocketIoSettings> | null;
};

const LIMIT_TEXT: Record<keyof ChannelLimits, string> = {
  maxMessages: "mensajes",
  maxBytes: "bytes recibidos",
  maxMessageBytes: "bytes por mensaje",
  maxDurationMs: "ms de duración",
  idleMs: "ms sin mensajes",
};

export function channelProblems(
  input: ChannelInput,
  ceilings: ChannelCeilings,
  protocol: ChannelProtocol = input.protocol ?? "ws",
): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });
  const grpc = protocol === "grpc";

  if (!(CHANNEL_PROTOCOLS as readonly string[]).includes(protocol))
    problem("protocol", `Uno de ${CHANNEL_PROTOCOLS.join(", ")}`);

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) problem("name", "El canal necesita un nombre");
    else if (name.length > MAX_CHANNEL_NAME) problem("name", `Como mucho ${MAX_CHANNEL_NAME} caracteres`);
  }

  if (input.url !== undefined)
    problems.push(...(protocol === "mqtt" ? brokerUrlProblems(input.url) : urlProblems(input.url, protocol)));
  problems.push(...protocolProblems({ ...input, protocol }));
  problems.push(...socketIoProblems({ ...input, protocol }));

  if (grpc && input.subprotocols?.length) problem("subprotocols", "Los subprotocolos son de WebSocket");
  if (input.grpc !== undefined) {
    if (grpc) problems.push(...grpcSettingsProblems(input.grpc));
    else problem("grpc", "Los ajustes de gRPC son de un canal gRPC");
  }

  if (input.subprotocols !== undefined) {
    if (!Array.isArray(input.subprotocols)) problem("subprotocols", "Los subprotocolos son una lista");
    else {
      if (input.subprotocols.length > MAX_SUBPROTOCOLS) problem("subprotocols", `Como mucho ${MAX_SUBPROTOCOLS}`);
      input.subprotocols.forEach((value, index) => {
        if (typeof value !== "string" || !TOKEN.test(value))
          problem(`subprotocols.${index}`, "Un subprotocolo es una palabra sin espacios ni separadores");
      });
    }
  }

  if (input.headers !== undefined) {
    if (!Array.isArray(input.headers)) problem("headers", "Las cabeceras son una lista");
    else {
      if (input.headers.length > MAX_CHANNEL_HEADERS) problem("headers", `Como mucho ${MAX_CHANNEL_HEADERS}`);
      input.headers.forEach((header, index) => {
        const name = typeof header?.name === "string" ? header.name.trim() : "";
        const metadataProblem = grpc && name ? metadataKeyProblem(name) : null;
        if (!name || !HEADER_NAME.test(name)) problem(`headers.${index}.name`, "No es un nombre de cabecera válido");
        else if (metadataProblem) problem(`headers.${index}.name`, metadataProblem);
        else if (!grpc && RESERVED_HEADERS.has(name.toLowerCase()))
          problem(`headers.${index}.name`, `${name} la pone el protocolo, no se escribe a mano`);
        if (typeof header?.value !== "string" || /[\r\n]/.test(header.value))
          problem(`headers.${index}.value`, "Una cabecera es texto y no lleva saltos de línea");
        else if (grpc && isBinaryMetadata(name)) {
          const binaryProblem = binaryMetadataProblem(header.value);
          if (binaryProblem) problem(`headers.${index}.value`, binaryProblem);
        }
      });
    }
  }

  if (input.auth) problems.push(...authProblems(input.auth));

  if (input.limits !== undefined) {
    for (const key of Object.keys(LIMIT_TEXT) as (keyof ChannelLimits)[]) {
      const value = input.limits[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 1) problem(`limits.${key}`, "Un número entero mayor que cero");
      else if (value > ceilings[key]) problem(`limits.${key}`, `Como mucho ${ceilings[key]} ${LIMIT_TEXT[key]}`);
    }
  }

  if (input.expectations !== undefined) {
    problems.push(...expectationProblems(input.expectations, grpc));
    if (grpc) problems.push(...grpcExpectationProblems(input.expectations));
  }

  if (input.messages !== undefined) {
    if (!Array.isArray(input.messages)) problem("messages", "Las tramas guardadas son una lista");
    else {
      if (input.messages.length > MAX_SAVED_MESSAGES) problem("messages", `Como mucho ${MAX_SAVED_MESSAGES}`);
      input.messages.forEach((message, index) => {
        if (typeof message?.name !== "string" || !message.name.trim())
          problem(`messages.${index}.name`, "La trama necesita un nombre");
        if (typeof message?.body !== "string") problem(`messages.${index}.body`, "El cuerpo de la trama es texto");
        else if (Buffer.byteLength(message.body, "utf8") > MAX_SAVED_MESSAGE_BYTES)
          problem(`messages.${index}.body`, `Como mucho ${MAX_SAVED_MESSAGE_BYTES / 1024} KB`);
      });
    }
  }

  return problems;
}

/**
 * La URL de un canal: `ws://` o `wss://`, o una plantilla que acabará siéndolo.
 *
 * Con `{{variables}}` no se puede comprobar el esquema —`{{wsBase}}/chat` es una URL perfectamente
 * buena que solo se sabe qué es al abrir contra un entorno—, así que entonces solo se mira que no
 * lleve lo que ninguna URL lleva. La guarda de red vuelve a mirar todo al conectar, con la URL ya
 * resuelta: esto es para decirlo antes, no para proteger nada.
 */
function urlProblems(value: unknown, protocol: ChannelProtocol): Problem[] {
  if (typeof value !== "string" || !value.trim()) return [{ field: "url", detail: "Falta la URL" }];
  const url = value.trim();
  if (url.length > MAX_CHANNEL_URL) return [{ field: "url", detail: `Como mucho ${MAX_CHANNEL_URL} caracteres` }];
  if (/\s/.test(url)) return [{ field: "url", detail: "Una URL no lleva espacios" }];
  if (protocol === "grpc") return grpcUrlProblems(url);
  if (protocol === "socketio") return socketIoUrlProblems(url);
  if (url.includes("{{")) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ field: "url", detail: "No es una URL: empieza por ws:// o wss://" }];
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
    return [{ field: "url", detail: `Un canal WebSocket empieza por ws:// o wss://, no por ${parsed.protocol}//` }];
  // Lo mismo que rechaza la guarda, dicho aquí para que no se descubra al conectar.
  if (parsed.username || parsed.password)
    return [{ field: "url", detail: "Las credenciales van en la autenticación, no en la URL" }];
  return [];
}

/**
 * Lo que el canal afirma de su conversación.
 *
 * Las comprobaciones de un canal solo pueden mirar mensajes. `status`, `header` y `body` son de una
 * respuesta HTTP; `evaluateConversation` las evaluaría contra una respuesta vacía y fallarían —que
 * es lo correcto en ejecución—, pero guardarlas es guardar una comprobación que nunca puede pasar, y
 * eso se dice aquí.
 */
function expectationProblems(expect: ChannelExpectation, grpc = false): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });
  if (typeof expect !== "object" || expect === null) return [{ field: "expectations", detail: "Es un objeto" }];

  if (expect.minMessages !== undefined && (!Number.isInteger(expect.minMessages) || expect.minMessages < 0))
    problem("expectations.minMessages", "Un número entero, cero o más");
  if (!grpc && expect.status !== undefined)
    problem("expectations.status", "El estado es de una llamada gRPC; un WebSocket afirma su código de cierre");
  if (
    !grpc &&
    expect.closeCode !== undefined &&
    (!Number.isInteger(expect.closeCode) || expect.closeCode < 1000 || expect.closeCode > 4999)
  )
    problem("expectations.closeCode", "Un código de cierre entre 1000 y 4999");
  if (
    expect.firstMessageBudgetMs !== undefined &&
    (!Number.isInteger(expect.firstMessageBudgetMs) || expect.firstMessageBudgetMs < 1)
  )
    problem("expectations.firstMessageBudgetMs", "Milisegundos, un entero mayor que cero");

  if (expect.checks !== undefined) {
    if (!Array.isArray(expect.checks)) problem("expectations.checks", "Las comprobaciones son una lista");
    else {
      if (expect.checks.length > MAX_CHANNEL_CHECKS) problem("expectations.checks", `Como mucho ${MAX_CHANNEL_CHECKS}`);
      expect.checks.forEach((check: StepCheck, index) => {
        const field = `expectations.checks.${index}`;
        if (!(CONVERSATION_CHECK_SOURCES as readonly string[]).includes(check?.source))
          problem(`${field}.source`, "En un canal se comprueban los mensajes: `message` o `messageCount`");
        if (!(CHECK_OPERATORS as readonly string[]).includes(check?.operator))
          problem(`${field}.operator`, "No es un operador conocido");
        if (check?.match !== undefined && !(MESSAGE_MATCHES as readonly string[]).includes(check.match?.at))
          problem(`${field}.match.at`, `Uno de ${MESSAGE_MATCHES.join(", ")}`);
        if (check?.match?.index !== undefined && (!Number.isInteger(check.match.index) || check.match.index < 0))
          problem(`${field}.match.index`, "Una posición: un entero, cero o más");
        if (check?.match?.topic !== undefined) {
          const topicProblem = topicFilterProblem(check.match.topic);
          if (topicProblem) problem(`${field}.match.topic`, topicProblem);
        }
        if (check?.match?.event !== undefined && (typeof check.match.event !== "string" || !check.match.event.trim()))
          problem(`${field}.match.event`, "El nombre del evento, tal cual lo emite el servidor");
      });
    }
  }
  return problems;
}

export function blankChannel(fields: {
  id: string;
  projectId: string;
  name: string;
  url: string;
  now: Date;
  by: string;
  protocol?: ChannelProtocol;
}): Channel {
  const protocol = fields.protocol ?? "ws";
  return {
    id: fields.id,
    projectId: fields.projectId,
    protocol,
    name: fields.name.trim(),
    url: fields.url.trim(),
    subprotocols: [],
    headers: [],
    auth: null,
    limits: { ...DEFAULT_LIMITS },
    // Una llamada gRPC que termina en `INTERNAL` no puede salir en verde porque nadie pidió nada: el
    // estado OK se afirma desde el principio, a la vista y quitable, como cualquier otra afirmación.
    expectations: protocol === "grpc" ? { status: 0 } : {},
    messages: [],
    mqtt: protocol === "mqtt" ? { ...DEFAULT_MQTT } : null,
    grpc: protocol === "grpc" ? { ...DEFAULT_GRPC_SETTINGS } : null,
    socketio: protocol === "socketio" ? { ...DEFAULT_SOCKETIO } : null,
    orderIndex: 0,
    createdAt: fields.now,
    updatedAt: fields.now,
    updatedBy: fields.by,
    archivedAt: null,
    deletedAt: null,
  };
}

/** Los cambios aplicados, sin tocar lo que no se mandó. Validados antes por `channelProblems`. */
export function withChanges(channel: Channel, input: ChannelInput, now: Date, by: string): Channel {
  return {
    ...channel,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.url !== undefined ? { url: input.url.trim() } : {}),
    ...(input.subprotocols !== undefined ? { subprotocols: input.subprotocols } : {}),
    ...(input.headers !== undefined ? { headers: input.headers.map(storableHeader) } : {}),
    // La misma regla que un endpoint, y por la misma función: un criterio distinto para guardar la
    // autenticación de un canal sería una segunda respuesta a «¿qué se guarda de una credencial?».
    // `redactAuth` primero: una contraseña escrita a mano se guarda vacía y solo una `{{variable}}`
    // se queda. Sin esto, la de un broker MQTT —y el token de un WebSocket— iban en claro al `jsonb`.
    ...(input.auth !== undefined
      ? {
          auth: input.auth ? { type: input.auth.type, params: storableParams(redactAuth(input.auth).auth) } : null,
        }
      : {}),
    ...(input.limits !== undefined ? { limits: { ...channel.limits, ...input.limits } } : {}),
    ...(input.expectations !== undefined ? { expectations: input.expectations } : {}),
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    ...(input.mqtt && channel.protocol === "mqtt" ? { mqtt: mergedSettings(channel.mqtt, input.mqtt) } : {}),
    ...(input.grpc !== undefined && channel.grpc ? { grpc: { ...channel.grpc, ...input.grpc } } : {}),
    // Sin literales de credencial en la query ni en la carga de `auth`: ver `storableSocketIo`.
    ...(input.socketio && channel.protocol === "socketio"
      ? { socketio: mergedSocketIo(channel.socketio, input.socketio) }
      : {}),
    updatedAt: now,
    updatedBy: by,
  };
}

const VARIABLE = /\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}/g;
/** Lo que queda de un valor sin sus variables y que no es secreto: el esquema de `Authorization`. */
const SCHEME_ONLY = /^(?:bearer|basic|token|bot)?\s*$/i;

/**
 * Una cabecera —o una clave de metadata— que se puede guardar.
 *
 * La regla de la autenticación, aplicada a las cabeceras: una que se llama como una credencial
 * (`authorization`, `x-api-key`, `*-token`…) y trae un valor escrito a mano se guarda **vacía**, que
 * es la marca de que falta. `{{token}}` sí se queda: eso no es el secreto, es dónde está, y ese sitio
 * sí lo cifra. `Bearer {{token}}` también, porque lo escrito a mano es solo el esquema. La columna es
 * un `jsonb` sin cifrar, y una cabecera `Authorization: Bearer eyJ…` ahí es la credencial en claro
 * que el entorno existe para no tener.
 */
export function storableHeader(header: EndpointHeader): EndpointHeader {
  const value = header.value.trim();
  // Con `-bin` detrás también: `x-api-key-bin` es la misma credencial, en bytes.
  if (!value || !SECRET_HEADER.test(header.name.trim().replace(/-bin$/i, ""))) return header;
  if (value.includes("{{") && SCHEME_ONLY.test(value.replace(VARIABLE, "").trim())) return header;
  return { ...header, value: "" };
}
