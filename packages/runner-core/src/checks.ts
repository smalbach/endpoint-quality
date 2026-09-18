/**
 * What the author of a step claims about its response, on top of what the contract already says.
 *
 * The generated matrix asserts the things a contract can be held to: the status, the envelope, the
 * declared schema, the published budget. Those are the same for every project because they come
 * from the document. **A check is the other kind of claim** — «this list is never empty», «the
 * total equals the sum», «it answers in under 300 ms» — which nothing in an OpenAPI document
 * expresses and which is exactly what somebody building a flow wants to say.
 *
 * Pure, and separate from `assertions.ts` for one reason: those are derived, and these are
 * *written*. A derived assertion changes when the contract changes; a check changes when a person
 * decides it should, so it is stored with the step and travels with it.
 *
 * Every check produces an assertion whether it passes or not. A check that vanishes when it
 * succeeds is a check nobody can tell you ran.
 */
import type { ActualResponse } from "./assertions.ts";
import { topicMatches } from "./mqtt-topic.ts";
import type { Assertion } from "./types.ts";
import { valueAtPath } from "./variables.ts";

/**
 * Where the value being judged comes from.
 *
 * `message` y `messageCount` son de una conversación (`conversation.ts`) y no de una respuesta: allí
 * no hay estado ni cabeceras, hay N cuerpos. Son una extensión de este motor y no un segundo motor,
 * así que los doce operadores, las rutas al JSON y las etiquetas generadas valen igual.
 */
export const RESPONSE_CHECK_SOURCES = ["status", "body", "header", "durationMs"] as const;
export type ResponseCheckSource = (typeof RESPONSE_CHECK_SOURCES)[number];

/**
 * Las fuentes de una conversación, en su propia lista y no dentro de la de arriba.
 *
 * Separadas porque la de arriba es un **contrato**: el esquema de un flujo la valida, se exporta y
 * se compara entre versiones. Añadirle `message` la habría ensanchado en silencio, y un paso HTTP
 * habría aceptado —y guardado, y exportado— una comprobación sobre mensajes que nunca va a tener.
 * El motor evalúa las dos; cada sitio valida la suya.
 */
export const CONVERSATION_CHECK_SOURCES = ["message", "messageCount"] as const;
export const CHECK_SOURCES = [...RESPONSE_CHECK_SOURCES, ...CONVERSATION_CHECK_SOURCES] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

/**
 * Cuál de los mensajes, cuando hay muchos.
 *
 * `first`, `last` o una posición miran uno. `any` y `all` aplican el operador a **cada** mensaje y
 * combinan, que es lo que hace expresable «algún mensaje trae `type: "pong"`» — la comprobación que
 * de verdad se escribe contra un socket, y que sin esto no se podía decir.
 */
export const MESSAGE_MATCHES = ["first", "last", "any", "all"] as const;
export type MessageMatch = {
  at: (typeof MESSAGE_MATCHES)[number];
  index?: number;
  /**
   * Solo los mensajes de este tema —un filtro MQTT, con `+` y `#`— antes de elegir cuál.
   *
   * Un canal MQTT oye varios temas en la misma sesión, y «el último mensaje» sin decir de qué tema
   * es el de cualquiera: la comprobación pasaría o fallaría según quién publicó el último. Con el
   * filtro, `first`, `last`, la posición, `any`, `all` y `messageCount` cuentan **dentro** del tema.
   */
  topic?: string;
  /**
   * Solo los mensajes de este evento de Socket.IO, por su nombre exacto, antes de elegir cuál.
   *
   * Por lo mismo que `topic`: un servidor Socket.IO emite varios eventos en la misma sesión, y «el
   * último mensaje» sería el del evento que llegara último. Un acuse cuenta como del evento que lo
   * pidió.
   */
  event?: string;
};

/**
 * Lo que una comprobación necesita saber de un mensaje, y nada más.
 *
 * Estructural a propósito: `ChannelMessage` encaja sin que este fichero lo importe, así que la
 * dependencia va en una sola dirección —la conversación usa este motor, no al revés—.
 */
export type CheckMessage = { seq: number; body: string; topic?: string; event?: string };

export const CHECK_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "less_than",
  "exists",
  "not_exists",
  "matches",
  "is_array",
  "is_not_empty",
  "has_length",
] as const;
export type CheckOperator = (typeof CHECK_OPERATORS)[number];

export type StepCheck<Source extends CheckSource = CheckSource> = {
  /** What to call it in the report. Generated from the rest when it is not given, because naming
   * twelve checks by hand is how people stop writing the twelfth. */
  label?: string;
  source: Source;
  /** A dot path into the JSON body, or the name of a header. Ignored by `status` and `durationMs`. */
  path?: string;
  operator: CheckOperator;
  /** The right-hand side. Absent for the operators that take none. */
  value?: unknown;
  /** `warning` records the check and does not fail the case. Absent means it fails it. */
  severity?: "error" | "warning";
  /** Solo para `message`: cuál de ellos. Ausente es `last`, que es el que suele contestar. */
  match?: MessageMatch;
};

/** Lo que admite un paso de un flujo HTTP: las fuentes de una respuesta, y ninguna más. */
export type ResponseCheck = StepCheck<ResponseCheckSource>;

/**
 * What a check was actually run against: the response, plus what only the runner knows.
 *
 * `messages` son los **recibidos**, y solo de una conversación. Los enviados no se comprueban: los
 * escribió quien escribe la comprobación, y afirmar algo sobre ellos es afirmarlo sobre uno mismo.
 */
export type CheckContext = { response: ActualResponse; durationMs: number; messages?: CheckMessage[] };

export function evaluateChecks(checks: StepCheck[], context: CheckContext): Assertion[] {
  return checks.map((check) => evaluateCheck(check, context));
}

function evaluateCheck(check: StepCheck, given: CheckContext): Assertion {
  const context = withinTopic(check, given);
  if (check.source === "message" && (check.match?.at === "any" || check.match?.at === "all")) {
    return evaluateAcrossMessages(check, context.messages ?? []);
  }
  const actual = actualFor(check, context);
  let pass: boolean;
  try {
    pass = applyOperator(check.operator, actual, check.value);
  } catch (caught) {
    // A malformed regular expression is the author's mistake and the report is where they will see
    // it. Throwing would take the whole run down over one badly typed check.
    return {
      label: labelFor(check),
      pass: false,
      ...(check.severity ? { severity: check.severity } : {}),
      detail: caught instanceof Error ? caught.message : "La comprobación no se pudo evaluar",
    };
  }
  return {
    label: labelFor(check),
    pass,
    ...(check.severity ? { severity: check.severity } : {}),
    detail: `Obtenido ${describe(actual)}`,
  };
}

/**
 * Los mensajes del tema —o del evento de Socket.IO— que pide la comprobación, y solo esos.
 *
 * Un mensaje sin tema —el de un WebSocket— no casa con ningún filtro: una comprobación con tema en
 * un canal que no tiene temas no mira nada, y sale en rojo por «no llegó ningún mensaje», que es la
 * verdad.
 */
function withinTopic(check: StepCheck, context: CheckContext): CheckContext {
  const filter = check.match?.topic;
  const event = check.match?.event;
  if ((!filter && !event) || (check.source !== "message" && check.source !== "messageCount")) return context;
  return {
    ...context,
    // Los dos filtros se suman: un mensaje sin evento —el de un WebSocket— no casa con ninguno, como
    // uno sin tema no casa con un filtro de tema.
    messages: (context.messages ?? []).filter(
      (message) =>
        (!filter || (message.topic !== undefined && topicMatches(filter, message.topic))) &&
        (!event || message.event === event),
    ),
  };
}

/**
 * `any` y `all`: el operador contra cada mensaje, y la combinación.
 *
 * **Sin mensajes, las dos fallan.** `all` sobre una lista vacía es verdad en lógica y mentira en un
 * informe: «todos los mensajes traen `ok: true`» en verde, cuando no llegó ninguno, es la marca que
 * no afirma nada que este motor existe para no poner.
 */
function evaluateAcrossMessages(check: StepCheck, messages: CheckMessage[]): Assertion {
  const severity = check.severity ? { severity: check.severity } : {};
  if (messages.length === 0) {
    return { label: labelFor(check), pass: false, ...severity, detail: "No llegó ningún mensaje" };
  }
  let matching: number;
  try {
    matching = messages.filter((message) =>
      applyOperator(check.operator, messageValue(message, check.path), check.value),
    ).length;
  } catch (caught) {
    return {
      label: labelFor(check),
      pass: false,
      ...severity,
      detail: caught instanceof Error ? caught.message : "La comprobación no se pudo evaluar",
    };
  }
  const pass = check.match?.at === "all" ? matching === messages.length : matching > 0;
  return { label: labelFor(check), pass, ...severity, detail: `${matching} de ${messages.length} mensajes cumplen` };
}

/**
 * El valor de un mensaje: su JSON si lo es, su texto si no.
 *
 * Un mensaje de socket no trae `Content-Type`, así que se prueba a leerlo. Si no es JSON, una ruta
 * no puede apuntar a nada dentro y el valor es el texto entero — que es con lo que `contains` y
 * `matches` tienen que trabajar.
 */
function messageValue(message: CheckMessage, path: string | undefined): unknown {
  let parsed: unknown = message.body;
  try {
    parsed = JSON.parse(message.body);
  } catch {
    return path ? undefined : message.body;
  }
  return path ? valueAtPath(parsed, path) : parsed;
}

/** El mensaje que miran `first`, `last` y una posición. */
function pickMessage(messages: CheckMessage[], match: MessageMatch | undefined): CheckMessage | undefined {
  if (match?.index !== undefined) return messages[match.index];
  return match?.at === "first" ? messages[0] : messages[messages.length - 1];
}

/** `where` is what the check points at, and it is half of every label and every message. */
function where(check: StepCheck): string {
  if (check.source === "status") return "status";
  if (check.source === "durationMs") return "duración";
  const topic =
    (check.match?.topic ? ` en ${check.match.topic}` : "") +
    (check.match?.event ? ` del evento ${check.match.event}` : "");
  if (check.source === "messageCount") return `mensajes recibidos${topic}`;
  if (check.source === "message") {
    const which =
      check.match?.index !== undefined
        ? `mensaje ${check.match.index}`
        : check.match?.at === "any"
          ? "algún mensaje"
          : check.match?.at === "all"
            ? "todos los mensajes"
            : check.match?.at === "first"
              ? "primer mensaje"
              : "último mensaje";
    return check.path ? `${which}${topic} · ${check.path}` : `${which}${topic}`;
  }
  if (check.source === "header") return `cabecera ${check.path ?? ""}`.trim();
  return check.path ? `body.${check.path}` : "body";
}

const OPERATOR_TEXT: Record<CheckOperator, string> = {
  equals: "es",
  not_equals: "no es",
  contains: "contiene",
  not_contains: "no contiene",
  greater_than: "es mayor que",
  less_than: "es menor que",
  exists: "existe",
  not_exists: "no existe",
  matches: "cumple",
  is_array: "es una lista",
  is_not_empty: "no está vacío",
  has_length: "tiene longitud",
};

const NO_OPERAND: CheckOperator[] = ["exists", "not_exists", "is_array", "is_not_empty"];

function labelFor(check: StepCheck): string {
  if (check.label?.trim()) return check.label.trim();
  const operand = NO_OPERAND.includes(check.operator) ? "" : ` ${describe(check.value)}`;
  return `${where(check)} ${OPERATOR_TEXT[check.operator]}${operand}`;
}

function actualFor(check: StepCheck, { response, durationMs, messages = [] }: CheckContext): unknown {
  switch (check.source) {
    case "messageCount":
      return messages.length;
    case "message": {
      const message = pickMessage(messages, check.match);
      return message ? messageValue(message, check.path) : undefined;
    }
    case "status":
      return response.status;
    case "durationMs":
      return durationMs;
    case "header":
      // Header names are case-insensitive by the spec and lowercased by every client that
      // normalizes them; looking under both is cheaper than making the author remember which.
      return check.path ? (response.headers[check.path.toLowerCase()] ?? response.headers[check.path]) : undefined;
    case "body":
      return check.path ? valueAtPath(response.body, check.path) : response.body;
  }
}

function applyOperator(operator: CheckOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    // Compared as text on purpose: `status equals "200"` typed into a form and `200` read off the
    // wire are the same claim, and failing it on the type of a field nobody chose is a puzzle.
    case "equals":
      return sameValue(actual, expected);
    case "not_equals":
      return !sameValue(actual, expected);
    case "contains":
      return Array.isArray(actual)
        ? actual.some((item) => sameValue(item, expected))
        : text(actual).includes(text(expected));
    case "not_contains":
      return !(Array.isArray(actual)
        ? actual.some((item) => sameValue(item, expected))
        : text(actual).includes(text(expected)));
    case "greater_than":
      return Number(actual) > Number(expected);
    case "less_than":
      return Number(actual) < Number(expected);
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "matches":
      return new RegExp(String(expected)).test(text(actual));
    case "is_array":
      return Array.isArray(actual);
    case "is_not_empty":
      return sizeOf(actual) > 0;
    case "has_length":
      return sizeOf(actual) === Number(expected);
  }
}

/** Deep for structures, textual for scalars. `"200"` and `200` are the same claim. */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
  return String(actual) === String(expected);
}

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** Length of a list or a string; the number of keys of an object. Anything else has no size. */
function sizeOf(value: unknown): number {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

/** What goes in the report. Long structures are cut: a detail line nobody can read is not one. */
function describe(value: unknown): string {
  if (value === undefined) return "nada";
  if (value === null) return "null";
  const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}
