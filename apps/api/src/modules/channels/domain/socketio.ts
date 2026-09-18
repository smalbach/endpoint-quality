/**
 * Lo que un canal Socket.IO tiene y un WebSocket no: la ruta del servidor, el espacio de nombres, la
 * carga de `auth` del `CONNECT`, los eventos que se oyen y los transportes.
 *
 * En su propio fichero por lo mismo que `mqtt.ts`: Socket.IO se mide como cualquier canal —una
 * conexión, mensajes que van y vienen, un cierre— y se configura distinto. Aquí hay una función por
 * cosa que se valida, se guarda o se resuelve, y el modelo del canal solo las llama.
 *
 * **La carga de `auth` no es la autenticación del canal.** Aquella firma el upgrade HTTP (cabecera o
 * query), igual que en un WebSocket; esta es el objeto que Socket.IO manda en el `CONNECT` del
 * espacio de nombres y que el `io.use()` del servidor lee. Son dos sitios distintos del protocolo y
 * los dos pasan por la misma regla al guardar: un valor escrito a mano en un campo que se llama como
 * una credencial se guarda vacío, y una `{{variable}}` se queda (`storableSocketIo`).
 */
import { SECRET_FIELD } from "@/modules/endpoints/domain/examples";
import type { EndpointHeader } from "@/modules/endpoints/domain/model";
// `storableHeader` se usa dentro de una función y no al cargar: el ciclo con `model.ts` no muerde.
import { storableHeader, type ChannelInput } from "./model";

type Problem = { field: string; detail: string };

/**
 * 3 y 4: los servidores con los que habla el cliente 4 de `socket.io-client`. Un servidor 2 necesita
 * el cliente 2 (Engine.IO 3), que no se incluye: es una biblioteca sin mantenimiento con su propio
 * `ws` viejo, y la guarda de red habría que volver a probarla entera contra ella.
 */
export const SOCKETIO_VERSIONS = [3, 4] as const;
export type SocketIoVersion = (typeof SOCKETIO_VERSIONS)[number];
export const SOCKETIO_TRANSPORTS = ["websocket", "polling"] as const;
export type SocketIoTransport = (typeof SOCKETIO_TRANSPORTS)[number];

export const MAX_LISTENED_EVENTS = 50;
export const MAX_EVENT_NAME = 200;
export const MAX_QUERY_PARAMS = 50;
const MAX_PATH = 200;
/** La carga de `auth` es un objeto pequeño —un token, un id—: el mismo tope que un testamento MQTT. */
export const MAX_AUTH_PAYLOAD = 16 * 1024;

/**
 * Los eventos que Socket.IO se reserva: los emite la propia biblioteca, y uno que se llame así ni se
 * puede emitir (lanza) ni se oye como un evento del servidor.
 */
export const RESERVED_EVENTS = new Set([
  "connect",
  "connect_error",
  "disconnect",
  "disconnecting",
  "newListener",
  "removeListener",
]);

export type SocketIoQueryParam = EndpointHeader;

export type SocketIoSettings = {
  version: SocketIoVersion;
  /** La ruta del servidor: `/socket.io` salvo que el servidor diga otra. */
  path: string;
  /** `/` es el principal. Con `/` y una ruta en la URL, la ruta de la URL es el espacio, como en `io()`. */
  namespace: string;
  /** JSON con `{{variables}}`; vacío es sin carga. Se resuelve y se parsea al abrir. */
  auth: string;
  query: SocketIoQueryParam[];
  /** Oír **todos** los eventos (`onAny`), o solo los de `events`. */
  listenAll: boolean;
  events: string[];
  /**
   * Solo WebSocket por defecto: el sondeo largo por HTTP es una petición por mensaje y solo hace falta
   * con un servidor que no acepta el upgrade. Con los dos, se empieza sondeando y se sube.
   */
  transports: SocketIoTransport[];
};

export const DEFAULT_SOCKETIO: SocketIoSettings = {
  version: 4,
  path: "/socket.io",
  namespace: "/",
  auth: "",
  query: [],
  listenAll: true,
  events: [],
  transports: ["websocket"],
};

/** Lo que se emite: el evento, si se espera el acuse, y los argumentos si son más de uno. */
export type SocketIoEmit = { event: string; ack: boolean; args?: string[] };

/**
 * Lo que no vale en un canal, según sea o no Socket.IO.
 *
 * Un canal Socket.IO no negocia subprotocolos (los pone Engine.IO) ni tiene código de cierre (se
 * desconecta con un motivo, que queda en la transcripción), y sus tramas guardadas llevan evento y
 * no tema. Los demás protocolos no llevan ninguna de sus cosas.
 */
export function socketIoProblems(input: ChannelInput): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });
  const messages = Array.isArray(input.messages) ? input.messages : [];

  if (input.protocol !== "socketio") {
    if (input.socketio !== undefined && input.socketio !== null)
      problem("socketio", "Solo un canal Socket.IO lleva ajustes de Socket.IO");
    if (messages.some((message) => message && typeof message === "object" && "event" in message))
      problem("messages", "Solo Socket.IO emite eventos: una trama guardada de este canal no lleva evento");
    return problems;
  }

  if (input.subprotocols?.length) problem("subprotocols", "Socket.IO no negocia subprotocolos");
  if (input.expectations?.closeCode !== undefined)
    problem("expectations.closeCode", "Socket.IO no tiene código de cierre: se afirma sobre los eventos");
  if (input.socketio === null) problem("socketio", "Un canal Socket.IO necesita sus ajustes");
  else if (input.socketio !== undefined) problems.push(...settingsProblems(input.socketio));

  messages.forEach((message, index) => {
    // Un tema en una trama guardada ya lo rechaza `protocolProblems`, que es de MQTT.
    if (!message || typeof message !== "object") return;
    if (message.event !== undefined) {
      const eventProblem = eventNameProblem(message.event);
      if (eventProblem) problem(`messages.${index}.event`, eventProblem);
    }
  });
  return problems;
}

/** Un nombre de evento que se puede emitir u oír: texto, con tope, y no uno de los reservados. */
export function eventNameProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "El evento necesita un nombre";
  if (value.length > MAX_EVENT_NAME) return `Como mucho ${MAX_EVENT_NAME} caracteres`;
  if (RESERVED_EVENTS.has(value)) return `«${value}» lo emite Socket.IO: no es un evento del servidor`;
  return null;
}

function settingsProblems(settings: Partial<SocketIoSettings>): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });
  if (typeof settings !== "object" || Array.isArray(settings)) return [{ field: "socketio", detail: "Es un objeto" }];

  if (settings.version !== undefined && !(SOCKETIO_VERSIONS as readonly unknown[]).includes(settings.version))
    problem("socketio.version", "3 o 4: un servidor Socket.IO 2 necesita un cliente que esta instalación no incluye");
  for (const key of ["path", "namespace"] as const) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.startsWith("/")) problem(`socketio.${key}`, "Empieza por /");
    else if (value.length > MAX_PATH) problem(`socketio.${key}`, `Como mucho ${MAX_PATH} caracteres`);
    else if (/[\s?#]/.test(value)) problem(`socketio.${key}`, "Sin espacios, ? ni #");
  }

  if (settings.auth !== undefined) {
    if (typeof settings.auth !== "string") problem("socketio.auth", "Es texto: un objeto JSON");
    else if (Buffer.byteLength(settings.auth, "utf8") > MAX_AUTH_PAYLOAD)
      problem("socketio.auth", `Como mucho ${MAX_AUTH_PAYLOAD / 1024} KB`);
    else {
      const payloadProblem = authPayloadProblem(settings.auth);
      if (payloadProblem) problem("socketio.auth", payloadProblem);
    }
  }

  if (settings.query !== undefined) {
    if (!Array.isArray(settings.query)) problem("socketio.query", "Los parámetros son una lista");
    else {
      if (settings.query.length > MAX_QUERY_PARAMS) problem("socketio.query", `Como mucho ${MAX_QUERY_PARAMS}`);
      settings.query.forEach((param, index) => {
        if (typeof param?.name !== "string" || !param.name.trim())
          problem(`socketio.query.${index}.name`, "Falta el nombre");
        if (typeof param?.value !== "string") problem(`socketio.query.${index}.value`, "Es texto");
      });
    }
  }

  if (settings.listenAll !== undefined && typeof settings.listenAll !== "boolean")
    problem("socketio.listenAll", "Sí o no");
  if (settings.events !== undefined) {
    if (!Array.isArray(settings.events)) problem("socketio.events", "Los eventos son una lista");
    else {
      if (settings.events.length > MAX_LISTENED_EVENTS) problem("socketio.events", `Como mucho ${MAX_LISTENED_EVENTS}`);
      const seen = new Set<string>();
      settings.events.forEach((event, index) => {
        const eventProblem = eventNameProblem(event);
        if (eventProblem) problem(`socketio.events.${index}`, eventProblem);
        else if (seen.has(event)) problem(`socketio.events.${index}`, "Ya está en la lista");
        else seen.add(event);
      });
    }
  }
  if (settings.listenAll === false && Array.isArray(settings.events) && !settings.events.length)
    problem("socketio.events", "Sin «todos los eventos», di cuáles se oyen");

  if (settings.transports !== undefined) {
    if (
      !Array.isArray(settings.transports) ||
      !settings.transports.length ||
      settings.transports.some((transport) => !(SOCKETIO_TRANSPORTS as readonly unknown[]).includes(transport)) ||
      new Set(settings.transports).size !== settings.transports.length
    )
      problem("socketio.transports", "websocket, polling o los dos, sin repetir");
  }
  return problems;
}

/**
 * Lo que tiene mal una carga de `auth` escrita: tiene que ser un objeto JSON.
 *
 * Con `{{variables}}` fuera de una cadena —`{"n": {{numero}}}`— no es JSON hasta resolverla, y
 * entonces se vuelve a mirar al abrir (`socketIoSessionPlan`). Aquí solo se dice lo que ya se sabe.
 */
export function authPayloadProblem(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? null : 'La carga de auth es un objeto JSON: {"token": "{{token}}"}';
  } catch {
    return text.includes("{{") ? null : 'No es JSON: la carga de auth es un objeto, {"token": "{{token}}"}';
  }
}

/**
 * La URL de un servidor Socket.IO: `http(s)://` como la escribe todo el mundo, o `ws(s)://`.
 *
 * Como en los demás canales: con `{{variables}}` solo se mira lo que ninguna URL lleva, y la guarda
 * de red lo vuelve a mirar todo al conectar, con la URL ya resuelta.
 */
export function socketIoUrlProblems(url: string): Problem[] {
  if (url.includes("{{")) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ field: "url", detail: "No es una URL: empieza por http://, https://, ws:// o wss://" }];
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol))
    return [
      {
        field: "url",
        detail: `Un servidor Socket.IO empieza por http://, https://, ws:// o wss://, no por ${parsed.protocol}//`,
      },
    ];
  if (parsed.username || parsed.password)
    return [{ field: "url", detail: "Las credenciales van en la autenticación, no en la URL" }];
  return [];
}

/** Los ajustes guardados: lo que había, con lo que se mandó encima, validado antes y sin literales. */
export function mergedSocketIo(current: SocketIoSettings | null, input: Partial<SocketIoSettings>): SocketIoSettings {
  const merged = { ...DEFAULT_SOCKETIO, ...(current ?? {}), ...input };
  return storableSocketIo({
    version: merged.version,
    path: merged.path,
    namespace: merged.namespace,
    auth: merged.auth,
    query: merged.query.map(({ name, value, enabled }) => ({ name: name.trim(), value, enabled: enabled !== false })),
    listenAll: merged.listenAll,
    events: [...merged.events],
    transports: [...merged.transports],
  });
}

/**
 * Los ajustes que se pueden guardar: la regla de las cabeceras, aplicada a la query y a la carga.
 *
 * La columna `socketio` es un `jsonb` sin cifrar, como la de las cabeceras. Un parámetro `token` o un
 * campo `password` de la carga con el valor escrito a mano se guardan **vacíos**, que es la marca de
 * que falta; con `{{token}}` se quedan, porque eso no es el secreto sino dónde está. Exportada porque
 * bifurcar, exportar y el fichero de proyecto limpian un canal con esta misma función.
 */
export function storableSocketIo(settings: SocketIoSettings): SocketIoSettings {
  return {
    ...settings,
    query: settings.query.map(storableHeader),
    auth: storableAuthPayload(settings.auth),
  };
}

/**
 * La carga de `auth` sin los valores escritos a mano de sus campos de credencial, a cualquier
 * profundidad. Una carga que no se puede parsear (lleva `{{variables}}` fuera de una cadena) se deja
 * como está salvo por esos campos, que se vacían con una expresión: guardarla entera sería guardar el
 * token que tenga dentro.
 */
export function storableAuthPayload(text: string): string {
  if (!text.trim()) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    const cleaned = cleanPayload(parsed);
    // Solo se reescribe si algo se vació, y con la sangría que traía: el resto es de quien la escribió.
    if (JSON.stringify(parsed) === JSON.stringify(cleaned)) return text;
    return JSON.stringify(cleaned, null, text.includes("\n") ? 2 : undefined);
  } catch {
    return text.replace(
      /"([^"\\]+)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
      (whole, key: string, colon: string, value: string) =>
        isCredentialName(key) && !onlyVariables(value) ? `"${key}"${colon}""` : whole,
    );
  }
}

function cleanPayload(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanPayload(item, key));
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, cleanPayload(item, name)]));
  if (typeof value === "string" && key && isCredentialName(key) && !onlyVariables(value)) return "";
  return value;
}

/** Un nombre de credencial: el de una cabecera (`authorization`, `x-api-key`…) o el de un campo (`password`, `token`…). */
function isCredentialName(name: string): boolean {
  return storableHeader({ name, value: "x", enabled: true }).value === "" || SECRET_FIELD.test(name);
}

const VARIABLE = /\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}/g;
/** Lo que queda de un valor sin sus variables y que no es secreto: el esquema de `Authorization`. */
const onlyVariables = (value: string) =>
  value.includes("{{") && /^(?:bearer|basic|token|bot)?\s*$/i.test(value.replace(VARIABLE, "").trim());

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lo que hace falta para conectar, ya resuelto contra el entorno. */
export type SocketIoSessionPlan = {
  path: string;
  /** El espacio de nombres efectivo: el de los ajustes o, con `/`, la ruta de la URL. */
  namespace: string;
  auth: Record<string, unknown> | null;
  query: Record<string, string>;
  listenAll: boolean;
  events: string[];
  transports: SocketIoTransport[];
};

/**
 * El plan de conexión, con las variables resueltas y **cada valor de la carga en los secretos**.
 *
 * Todos, y no solo los que se llaman como una credencial: la carga de `auth` existe para llevar
 * credenciales, y cada servidor las llama como quiere (`sid`, `jwt`, `key`, `pase`…). Un servidor que
 * devuelve la carga en un evento —un eco, un «bienvenido, <token>»— la metería en la fila; con los
 * valores en la lista, `applyFrame` los tapa. Los valores de la query con nombre de credencial
 * entran por lo mismo.
 */
export function socketIoSessionPlan(
  settings: SocketIoSettings,
  url: string,
  interpolate: (value: string) => string,
  secrets: string[],
): { plan: SocketIoSessionPlan; problems: Problem[] } {
  const problems: Problem[] = [];
  let auth: Record<string, unknown> | null = null;
  const authText = interpolate(settings.auth);
  if (authText.trim()) {
    try {
      const parsed: unknown = JSON.parse(authText);
      if (isPlainObject(parsed)) auth = parsed;
      else problems.push({ field: "socketio.auth", detail: "La carga de auth, ya resuelta, no es un objeto JSON" });
    } catch {
      problems.push({ field: "socketio.auth", detail: "La carga de auth, ya resuelta, no es JSON" });
    }
  }
  if (auth) for (const value of leafStrings(auth)) secrets.push(value);

  const query: Record<string, string> = {};
  for (const param of settings.query) {
    if (!param.enabled || !param.name.trim()) continue;
    const value = interpolate(param.value);
    query[param.name.trim()] = value;
    if (isCredentialName(param.name) && value) secrets.push(value);
  }

  let namespace = interpolate(settings.namespace) || "/";
  if (namespace === "/") {
    try {
      const pathname = new URL(url).pathname;
      if (pathname && pathname !== "/") namespace = pathname;
    } catch {
      // Una URL que no se parsea la rechaza la guarda al conectar, con su motivo.
    }
  }
  return {
    plan: {
      path: interpolate(settings.path) || "/socket.io",
      namespace,
      auth,
      query,
      listenAll: settings.listenAll,
      events: settings.listenAll ? [] : settings.events.map(interpolate),
      transports: settings.transports.length ? settings.transports : ["websocket"],
    },
    problems,
  };
}

/** Los textos de un valor JSON, a cualquier profundidad: lo que se busca en cada mensaje. */
function leafStrings(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (isPlainObject(value)) return Object.values(value).flatMap(leafStrings);
  return [];
}

/**
 * Los argumentos de un `emit`, a partir de lo escrito: un objeto o una lista JSON se mandan como
 * JSON, y cualquier otra cosa como texto.
 *
 * Solo objetos y listas, a propósito: `42` o `true` escritos en un campo de texto casi siempre son
 * texto, y adivinar el tipo haría que «el mismo mensaje» viajara distinto según lo que contenga. Quien
 * necesite un número lo manda dentro de un objeto, que es como lo esperan las APIs de verdad.
 */
export function emitValues(texts: string[]): unknown[] {
  return texts.map((text) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return text;
    }
  });
}

/**
 * Los argumentos de un evento como el cuerpo de un mensaje de la transcripción: nada es `""`, uno solo
 * es él mismo (el texto tal cual, o su JSON), y varios son una lista JSON.
 *
 * Así una comprobación sobre `data.id` funciona igual contra `socket.emit("x", {id})` que contra un
 * mensaje de WebSocket, y la de varios argumentos se escribe con la posición: `0.id`, `1`. Los bytes
 * de un argumento binario van como hexadecimal de lo que quepa, con su tamaño real, igual que una
 * trama binaria de un WebSocket.
 */
export function argsBody(args: unknown[]): string {
  if (!args.length) return "";
  if (args.length === 1 && typeof args[0] === "string") return args[0];
  return JSON.stringify(args.length === 1 ? args[0] : args, binaryReplacer) ?? "";
}

function binaryReplacer(_key: string, value: unknown): unknown {
  // `JSON.stringify` llama a `toJSON` del Buffer antes que a esto: se reconoce por la forma.
  if (isPlainObject(value) && value.type === "Buffer" && Array.isArray(value.data)) {
    const bytes = Buffer.from(value.data as number[]);
    return { $binary: bytes.subarray(0, 256).toString("hex"), bytes: bytes.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    const bytes = Buffer.from(value);
    return { $binary: bytes.subarray(0, 256).toString("hex"), bytes: bytes.byteLength };
  }
  return value;
}
