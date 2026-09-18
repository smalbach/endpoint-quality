/**
 * Lo que un canal MQTT tiene y un WebSocket no: el broker, la sesión MQTT y las suscripciones.
 *
 * En su propio fichero, y el modelo del canal solo lo llama, porque MQTT se parece a un WebSocket
 * en lo que importa para medir —una conexión, mensajes que van y vienen, un cierre— y se diferencia
 * en todo lo que se configura. Mezclar las dos cosas en `channelProblems` sería un `if` por campo;
 * aquí es una función por protocolo.
 *
 * **Usuario y contraseña no viven aquí**: van en la autenticación del canal, como `basic`. Es la
 * misma credencial con los mismos dos campos, y así pasa por la misma puerta que ya vacía los
 * secretos literales al guardar (`redactAuth`) y por la misma lista de secretos al abrir. Un campo
 * `password` aparte en esta columna sería una segunda puerta, y la que un día se olvida.
 */
import { publishTopicProblem, topicFilterProblem, type RequestAuth } from "@eq/runner-core";

import type { ChannelInput } from "./model";

type Problem = { field: string; detail: string };

/** 4 es 3.1.1 y 5 es 5.0: los números que el propio protocolo pone en el `CONNECT`. */
export const MQTT_VERSIONS = [4, 5] as const;
export type MqttVersion = (typeof MQTT_VERSIONS)[number];
export type MqttQos = 0 | 1 | 2;

export const MAX_SUBSCRIPTIONS = 50;
export const MAX_CLIENT_ID = 256;
const MAX_BROKER_URL = 2_000;
/** El máximo del protocolo para `keepalive`: dos bytes, en segundos. */
const MAX_KEEPALIVE = 65_535;

export type MqttSubscription = { topic: string; qos: MqttQos };

export type MqttSettings = {
  version: MqttVersion;
  /**
   * Con `{{variables}}` si hace falta. Vacío: se inventa uno por sesión (`eq-…`), que es lo que
   * quiere casi siempre quien prueba —dos pestañas con el mismo id se echan la una a la otra—.
   */
  clientId: string;
  keepaliveSec: number;
  /** `clean` en 3.1.1 y `cleanStart` en 5.0: empezar sin lo que el broker guardaba del cliente. */
  cleanSession: boolean;
  subscriptions: MqttSubscription[];
};

export const DEFAULT_MQTT: MqttSettings = {
  version: 4,
  clientId: "",
  keepaliveSec: 60,
  cleanSession: true,
  subscriptions: [],
};

/** Lo que se publica: tema, QoS y `retain`. El cuerpo va aparte, como en un WebSocket. */
export type MqttPublish = { topic: string; qos: MqttQos; retain: boolean };

const isQos = (value: unknown): value is MqttQos => value === 0 || value === 1 || value === 2;

/**
 * Lo que no vale en un canal, según su protocolo.
 *
 * Un canal WebSocket no lleva ajustes de MQTT, y uno MQTT no lleva lo que es de un upgrade HTTP
 * —subprotocolos, cabeceras— ni un código de cierre esperado, que MQTT no tiene. Guardarlos sería
 * guardar algo que nunca se usa y que la pantalla enseñaría como si importara.
 */
export function protocolProblems(input: ChannelInput): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });

  if (input.protocol !== "mqtt") {
    if (input.mqtt !== undefined && input.mqtt !== null) problem("mqtt", "Solo un canal MQTT lleva ajustes de MQTT");
    if (Array.isArray(input.messages) && input.messages.some((message) => message && "topic" in message))
      problem("messages", "Un WebSocket no tiene temas: una trama guardada es solo su cuerpo");
    return problems;
  }

  if (input.subprotocols?.length) problem("subprotocols", "MQTT no negocia subprotocolos");
  if (input.headers?.length) problem("headers", "Un broker MQTT no recibe cabeceras");
  if (input.auth && input.auth.type !== "none" && input.auth.type !== "basic")
    problem("auth.type", "En MQTT la autenticación es usuario y contraseña (basic)");
  if (input.expectations?.closeCode !== undefined)
    problem("expectations.closeCode", "MQTT no tiene código de cierre: se afirma sobre los mensajes");
  if (input.mqtt === null) problem("mqtt", "Un canal MQTT necesita sus ajustes");
  else if (input.mqtt !== undefined) problems.push(...settingsProblems(input.mqtt));

  if (Array.isArray(input.messages)) {
    input.messages.forEach((message, index) => {
      if (!message || typeof message !== "object") return;
      const field = `messages.${index}`;
      if (message.topic !== undefined && message.topic !== "") {
        const topicProblem = publishTopicProblem(message.topic);
        if (topicProblem && !String(message.topic).includes("{{")) problem(`${field}.topic`, topicProblem);
      }
      if (message.qos !== undefined && !isQos(message.qos)) problem(`${field}.qos`, "QoS es 0, 1 o 2");
      if (message.retain !== undefined && typeof message.retain !== "boolean") problem(`${field}.retain`, "Sí o no");
    });
  }
  return problems;
}

function settingsProblems(settings: Partial<MqttSettings>): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });
  if (typeof settings !== "object" || Array.isArray(settings)) return [{ field: "mqtt", detail: "Es un objeto" }];

  if (settings.version !== undefined && !(MQTT_VERSIONS as readonly unknown[]).includes(settings.version))
    problem("mqtt.version", "4 (3.1.1) o 5 (5.0)");
  if (settings.clientId !== undefined) {
    if (typeof settings.clientId !== "string") problem("mqtt.clientId", "Es texto");
    else if (settings.clientId.length > MAX_CLIENT_ID)
      problem("mqtt.clientId", `Como mucho ${MAX_CLIENT_ID} caracteres`);
  }
  if (
    settings.keepaliveSec !== undefined &&
    (!Number.isInteger(settings.keepaliveSec) || settings.keepaliveSec < 0 || settings.keepaliveSec > MAX_KEEPALIVE)
  )
    problem("mqtt.keepaliveSec", `Segundos, de 0 a ${MAX_KEEPALIVE}`);
  if (settings.cleanSession !== undefined && typeof settings.cleanSession !== "boolean")
    problem("mqtt.cleanSession", "Sí o no");

  if (settings.subscriptions !== undefined) {
    if (!Array.isArray(settings.subscriptions)) problem("mqtt.subscriptions", "Las suscripciones son una lista");
    else {
      if (settings.subscriptions.length > MAX_SUBSCRIPTIONS)
        problem("mqtt.subscriptions", `Como mucho ${MAX_SUBSCRIPTIONS}`);
      const seen = new Set<string>();
      settings.subscriptions.forEach((subscription, index) => {
        const field = `mqtt.subscriptions.${index}`;
        const topic = subscription?.topic;
        // Con `{{variables}}` se comprueba lo que se puede: el resto se vuelve a mirar al abrir.
        const topicProblem = topicFilterProblem(topic);
        if (topicProblem) problem(`${field}.topic`, topicProblem);
        else if (seen.has(topic)) problem(`${field}.topic`, "Ya hay una suscripción a ese tema");
        else seen.add(topic);
        if (!isQos(subscription?.qos)) problem(`${field}.qos`, "QoS es 0, 1 o 2");
      });
    }
  }
  return problems;
}

/**
 * La URL de un broker: `mqtt://`, `mqtts://`, o MQTT sobre `ws://`/`wss://`.
 *
 * Como la de un WebSocket: con `{{variables}}` solo se mira que no lleve lo que ninguna URL lleva, y
 * la guarda de red vuelve a mirarlo todo al conectar con la URL ya resuelta.
 */
export function brokerUrlProblems(value: unknown): Problem[] {
  if (typeof value !== "string" || !value.trim()) return [{ field: "url", detail: "Falta la URL del broker" }];
  const url = value.trim();
  if (url.length > MAX_BROKER_URL) return [{ field: "url", detail: `Como mucho ${MAX_BROKER_URL} caracteres` }];
  if (/\s/.test(url)) return [{ field: "url", detail: "Una URL no lleva espacios" }];
  if (url.includes("{{")) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ field: "url", detail: "No es una URL: empieza por mqtt:// o mqtts://" }];
  }
  if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(parsed.protocol))
    return [
      {
        field: "url",
        detail: `Un broker MQTT empieza por mqtt://, mqtts://, ws:// o wss://, no por ${parsed.protocol}//`,
      },
    ];
  if (parsed.username || parsed.password)
    return [{ field: "url", detail: "Usuario y contraseña van en la autenticación, no en la URL" }];
  return [];
}

/** Los ajustes guardados: lo que había, con lo que se mandó encima, validado antes. */
export function mergedSettings(current: MqttSettings | null, input: Partial<MqttSettings>): MqttSettings {
  const merged = { ...DEFAULT_MQTT, ...(current ?? {}), ...input };
  return {
    version: merged.version,
    clientId: merged.clientId.trim(),
    keepaliveSec: merged.keepaliveSec,
    cleanSession: merged.cleanSession,
    subscriptions: merged.subscriptions.map(({ topic, qos }) => ({ topic, qos })),
  };
}

/** Lo que hace falta para conectar, ya resuelto contra el entorno. */
export type MqttSessionPlan = {
  version: MqttVersion;
  clientId: string;
  keepaliveSec: number;
  cleanSession: boolean;
  username?: string;
  password?: string;
  subscriptions: MqttSubscription[];
};

/**
 * El plan de conexión, con las variables resueltas y la contraseña **añadida a los secretos**.
 *
 * Añadida aquí, en el mismo sitio donde se lee: la contraseña no viaja en la transcripción —va en el
 * `CONNECT`, que no se guarda—, pero un broker que la devuelve en un mensaje (un eco, un error que
 * repite lo que recibió) la metería en la fila. Con ella en la lista, `applyFrame` la tapa.
 */
export function mqttSessionPlan(
  settings: MqttSettings,
  auth: RequestAuth | null,
  interpolate: (value: string) => string,
  secrets: string[],
  randomId: () => string,
): MqttSessionPlan {
  const credentials =
    auth?.type === "basic"
      ? { username: interpolate(auth.params.username ?? ""), password: interpolate(auth.params.password ?? "") }
      : {};
  if (credentials.password) secrets.push(credentials.password);
  const clientId = interpolate(settings.clientId) || `eq-${randomId()}`;
  return {
    version: settings.version,
    clientId,
    keepaliveSec: settings.keepaliveSec,
    cleanSession: settings.cleanSession,
    ...(credentials.username ? { username: credentials.username } : {}),
    ...(credentials.password ? { password: credentials.password } : {}),
    subscriptions: settings.subscriptions.map(({ topic, qos }) => ({ topic: interpolate(topic), qos })),
  };
}

/** Lo que falla de un plan ya resuelto: un filtro que solo con la variable dentro deja de serlo. */
export function planProblems(plan: MqttSessionPlan): Problem[] {
  return plan.subscriptions.flatMap((subscription, index) => {
    const problem = topicFilterProblem(subscription.topic);
    return problem ? [{ field: `mqtt.subscriptions.${index}.topic`, detail: problem }] : [];
  });
}
