/**
 * Conectar a un broker MQTT que eligió un usuario, con la misma guarda que una petición.
 *
 * MQTT no es HTTP —es TCP pelado con un `CONNECT` binario—, pero la amenaza es la misma: un campo
 * «broker» es una forma de pedirle a nuestro servidor que abra una conexión hacia una dirección que
 * escribió otro. Así que las cuatro reglas de `safe-fetch.ts` valen, y aquí no se reescribe ninguna:
 *
 *  1. Se resuelve y se comprueba la IP con `resolveTarget` —el mismo código, con los esquemas de un
 *     broker pedidos por nombre—. Una segunda lista de rangos privados sería el fallo.
 *  2. No hay redirecciones que seguir en MQTT 3.1.1. En 5 existe «usa otro servidor» (`0x9C`) y
 *     aquí **no se sigue**: se enseña el código y se acaba, por lo mismo que un 302 en el upgrade de
 *     un WebSocket no se sigue.
 *  3. **La conexión va a la IP comprobada**, y el nombre sigue viajando en el SNI y en la
 *     verificación del certificado. No se deja resolver a `mqtt.js`: se le da un `streamBuilder`
 *     propio que abre el socket contra la dirección fijada, que es lo mismo que el `lookup` del
 *     `Agent` de undici en `safe-fetch.ts` y el `createConnection` de `safe-socket.ts`.
 *  4. **Se pone tope a lo que vuelve**, y dentro de la conexión: ver `PacketSizeGuard`.
 *
 * `ws://` y `wss://` también, porque muchos brokers solo exponen MQTT sobre WebSocket (el 8083/8084
 * de siempre) y aquí sale casi gratis: es el mismo `ws` con la misma conexión fijada que ya usa
 * `safe-socket.ts`, envuelto en un stream.
 */
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { MqttClient, type IClientOptions, type IConnackPacket, type IPublishPacket } from "mqtt";
import WebSocket from "ws";

import { BlockedTargetError, resolveTarget, type SafeFetchPolicy } from "./safe-fetch";
import { HandshakeRejectedError, pinnedConnection } from "./safe-socket";

/** Los esquemas de un broker. Pedidos a `resolveTarget` por nombre, como los de un socket. */
export const MQTT_SCHEMES = ["mqtt:", "mqtts:", "ws:", "wss:"] as const;

const DEFAULT_PORTS: Record<string, number> = { "mqtt:": 1883, "mqtts:": 8883, "ws:": 80, "wss:": 443 };

export type MqttQos = 0 | 1 | 2;

export type SafeMqttOptions = {
  /** 4 es 3.1.1 y 5 es 5.0, que es como lo numera el propio protocolo en el `CONNECT`. */
  protocolVersion: 4 | 5;
  clientId: string;
  keepaliveSec: number;
  clean: boolean;
  username?: string;
  password?: string;
  subscriptions: { topic: string; qos: MqttQos }[];
  /** El testamento, ya resuelto. Lo publica el broker solo si la conexión se corta sin `DISCONNECT`. */
  will?: { topic: string; payload: string; qos: MqttQos; retain: boolean };
  /** Propiedades de usuario del `CONNECT`. Solo viajan en 5.0. */
  userProperties?: { name: string; value: string }[];
  /** El tope de un paquete entrante. Obligatorio: sin él, un `PUBLISH` de 256 MB entra entero en memoria. */
  maxPacketBytes: number;
  /** Cuánto se espera al `CONNACK`. Un broker que acepta el TCP y no contesta es una conexión colgada. */
  connectTimeoutMs: number;
};

/** Un mensaje, tal como llega. Las propiedades, solo en 5.0 y solo si el mensaje traía alguna. */
export type MqttDelivery = {
  topic: string;
  payload: Buffer;
  qos: MqttQos;
  retain: boolean;
  properties?: MqttDeliveryProperties;
};

/** Las propiedades de un `PUBLISH` que se enseñan, crudas: la correlación son bytes. */
export type MqttDeliveryProperties = {
  userProperties?: [string, string][];
  contentType?: string;
  responseTopic?: string;
  correlationData?: Buffer;
};

/**
 * Las propiedades de usuario en la forma de `mqtt-packet`: un objeto cuyo valor es texto, o una
 * lista si el nombre se repite. Se aplanan a pares para no perder las repetidas.
 */
export function userPropertyPairs(properties: Record<string, string | string[]> | undefined): [string, string][] {
  return Object.entries(properties ?? {}).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((one): [string, string] => [name, String(one)]),
  );
}

/** Y al revés: pares a la forma de `mqtt-packet`, agrupando los nombres repetidos. */
export function userPropertyRecord(pairs: { name: string; value: string }[]): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const { name, value } of pairs) {
    const current = record[name];
    record[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return record;
}

/**
 * Lo que quien conecta quiere oír, entregado **desde antes de conectar**.
 *
 * Por el mismo motivo medido que en `safe-socket.ts`: un broker entrega los mensajes retenidos
 * nada más confirmar la suscripción, en el mismo paquete muchas veces, y con las escuchas puestas
 * después se perderían justo esos —que suelen ser el estado actual, lo que más se quiere ver—.
 */
export type MqttListeners = {
  /** El `CONNACK`, antes que cualquier mensaje. */
  onOpen?: (handshake: { status: number; headers: Record<string, string>; via: string }) => void;
  onMessage: (delivery: MqttDelivery) => void;
  /** El broker cerró, o se cortó la conexión. Con el motivo cuando el broker lo dio (5.0). */
  onClose: (reason: string, code?: number) => void;
  /** Solo los errores **después** de abrir. Los de antes rechazan la promesa. */
  onError: (error: Error) => void;
};

/**
 * El broker dijo que no: en el `CONNACK` o en el `SUBACK`.
 *
 * Hereda de `HandshakeRejectedError` para que quien abre sesiones lo trate igual que un 401 en el
 * upgrade —el motivo va entero al veredicto, y el rojo es `network`, no un error de la API— sin
 * tener que conocer MQTT. El mensaje nombra el código **y** lo que significa, porque «CONNACK 5»
 * a secas manda a buscar una tabla.
 */
export class MqttRejectedError extends HandshakeRejectedError {
  constructor(code: number, target: string, detail: string) {
    super(code, target);
    this.message = detail;
    this.name = "MqttRejectedError";
  }
}

/** Los códigos de rechazo, en castellano. 3.1.1 usa del 1 al 5; 5.0, del 0x80 en adelante. */
const REFUSALS: Record<number, string> = {
  1: "versión del protocolo no aceptada",
  2: "identificador de cliente rechazado",
  3: "servidor no disponible",
  4: "usuario o contraseña incorrectos",
  5: "no autorizado",
  0x80: "error sin especificar",
  0x81: "paquete mal formado",
  0x82: "error de protocolo",
  0x84: "versión del protocolo no aceptada",
  0x85: "identificador de cliente no válido",
  0x86: "usuario o contraseña incorrectos",
  0x87: "no autorizado",
  0x88: "servidor no disponible",
  0x89: "servidor ocupado",
  0x8a: "cliente vetado",
  0x8c: "método de autenticación no válido",
  0x8e: "otra conexión tomó la sesión",
  0x8f: "filtro de tema no válido",
  0x95: "paquete demasiado grande",
  0x97: "cuota superada",
  0x9c: "usa otro servidor (no se sigue)",
  0x9d: "el servidor se ha movido (no se sigue)",
  0x9e: "suscripciones compartidas no admitidas",
  0x9f: "demasiadas conexiones seguidas",
  0xa2: "suscripciones con comodín no admitidas",
};

export const refusalText = (code: number): string => `${code} (${REFUSALS[code] ?? `código 0x${code.toString(16)}`})`;

/**
 * El tope de paquete, **dentro** de la conexión.
 *
 * `mqtt-packet` junta un paquete entero antes de entregarlo, y la longitud de un `PUBLISH` puede
 * llegar a 256 MB: contarlo en `conversation.ts` sería contar lo que ya está en memoria. Esto lee
 * solo la cabecera fija de cada paquete —un byte de tipo y hasta cuatro de longitud— y corta la
 * conexión en cuanto uno anuncia más de lo permitido, antes de que llegue su primer byte de cuerpo.
 * Es el `maxPayload` de `ws`, para un protocolo cuya biblioteca no lo trae.
 *
 * En 5.0 además se le dice al broker en el `CONNECT` (`maximumPacketSize`), y uno que cumple ni lo
 * manda. Esto es para el que no cumple, y para 3.1.1, que no tiene forma de decirlo.
 */
export class PacketSizeGuard {
  private state: "type" | "length" | "body" = "type";
  private length = 0;
  private multiplier = 1;
  private lengthBytes = 0;
  private remaining = 0;

  constructor(private readonly maxPacketBytes: number) {}

  /** `null` si todo va bien; el motivo si hay que cortar. */
  feed(chunk: Buffer): string | null {
    let at = 0;
    while (at < chunk.length) {
      if (this.state === "type") {
        at++;
        this.state = "length";
        this.length = 0;
        this.multiplier = 1;
        this.lengthBytes = 0;
      } else if (this.state === "length") {
        const byte = chunk[at++];
        this.length += (byte & 0x7f) * this.multiplier;
        this.multiplier *= 128;
        this.lengthBytes++;
        if (byte & 0x80) {
          if (this.lengthBytes >= 4) return "el broker mandó un paquete con una longitud mal formada";
          continue;
        }
        if (this.length > this.maxPacketBytes)
          return `el broker anunció un paquete de ${this.length} bytes, y el tope es ${this.maxPacketBytes}`;
        this.remaining = this.length;
        this.state = this.remaining > 0 ? "body" : "type";
      } else {
        const skip = Math.min(this.remaining, chunk.length - at);
        this.remaining -= skip;
        at += skip;
        if (this.remaining === 0) this.state = "type";
      }
    }
    return null;
  }
}

/**
 * El stream que `mqtt.js` lee y escribe: el socket fijado, con el tope de paquete delante.
 *
 * Lo que sale va directo al socket; lo que entra pasa antes por `PacketSizeGuard`. Un corte por
 * tamaño es un error **con código**, porque `mqtt.js` descarta en silencio los errores de stream
 * que no lo llevan, y un corte silencioso parecería un broker que se fue sin decir nada.
 */
export function guardedStream(inner: Duplex, maxPacketBytes: number): Duplex {
  const guard = new PacketSizeGuard(maxPacketBytes);
  const outer = new Duplex({
    read() {
      inner.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      inner.write(chunk, callback);
    },
    final(callback) {
      inner.end(() => callback());
    },
    destroy(error, callback) {
      inner.destroy();
      callback(error);
    },
  });
  inner.on("data", (chunk: Buffer) => {
    const problem = guard.feed(chunk);
    if (problem) {
      outer.destroy(Object.assign(new Error(problem), { code: "EQ_MQTT_PACKET_TOO_LARGE" }));
      return;
    }
    if (!outer.push(chunk)) inner.pause();
  });
  inner.on("end", () => outer.push(null));
  inner.on("error", (error) => outer.destroy(error));
  inner.on("close", () => {
    if (!outer.destroyed) outer.destroy();
  });
  return outer;
}

/**
 * El socket crudo, abierto contra la dirección comprobada y no contra el nombre.
 *
 * Exportado para poder probarlo solo: es la línea que cierra la ventana de rebinding, y si algún día
 * alguien la «simplifica» pasándole el nombre a `mqtt.js`, esto es lo que tiene que ponerse rojo.
 */
export function pinnedBrokerStream(
  url: URL,
  address: string,
  options: { maxPacketBytes: number; connectTimeoutMs: number },
): Duplex {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (url.protocol === "mqtt:") return netConnect({ host: address, port });
  if (url.protocol === "mqtts:") {
    // El SNI y la verificación llevan el nombre: sin él, el certificado del broker no casa con nada.
    // A una IP literal no se le manda SNI, que el estándar no lo permite.
    return tlsConnect({ host: address, port, servername: isIP(hostname) ? "" : hostname });
  }
  const secure = url.protocol === "wss:";
  const socket = new WebSocket(url, ["mqtt"], {
    maxPayload: options.maxPacketBytes,
    handshakeTimeout: options.connectTimeoutMs,
    followRedirects: false,
    createConnection: pinnedConnection(address, secure, hostname),
  });
  const stream = WebSocket.createWebSocketStream(socket);
  // Un upgrade que no es un 101 se dice con su número, como en un canal WebSocket.
  socket.once("unexpected-response", (request, response: IncomingMessage) => {
    request.destroy();
    const rejected = { message: `el upgrade contestó ${response.statusCode ?? 0}`, code: "EQ_MQTT_UPGRADE" };
    // Destruir el stream con el socket a medio abrir llama a `terminate()`, y el error de ese aborto
    // («WebSocket was closed before…», sin código) es el que el stream acaba emitiendo, no el que se
    // le pasa. MQTT se traga un error sin código, y la sesión decía «el broker cerró la conexión» sin
    // el número: el aborto se lleva el motivo de aquí. Escuchado antes de destruir, para ir primero.
    socket.once("error", (aborted: Error) => Object.assign(aborted, rejected));
    stream.destroy(Object.assign(new Error(rejected.message), { code: rejected.code }));
  });
  return stream;
}

/**
 * Conectado y suscrito, o el motivo de que no.
 *
 * Lanza `BlockedTargetError` cuando la guarda dice que no —`config`: nadie llegó a llamar—,
 * `MqttRejectedError` cuando el broker contestó y fue un no, y el error de red tal cual en el resto.
 * Una suscripción rechazada es un no del broker como un `CONNACK` rechazado: una sesión que se
 * suponía que oía `alarmas/#` y no oye nada por falta de permiso no puede salir como «abierta».
 */
export async function openSafeMqtt(
  rawUrl: string,
  policy: SafeFetchPolicy,
  options: SafeMqttOptions,
  listeners: MqttListeners,
): Promise<{ client: MqttClient; handshake: { status: number; headers: Record<string, string>; via: string } }> {
  const { url, address } = await resolveTarget(rawUrl, policy, { schemes: MQTT_SCHEMES });
  const v5 = options.protocolVersion === 5;

  const clientOptions: IClientOptions = {
    protocolVersion: options.protocolVersion,
    clientId: options.clientId,
    keepalive: options.keepaliveSec,
    clean: options.clean,
    ...(options.username ? { username: options.username } : {}),
    ...(options.password ? { password: options.password } : {}),
    // Nada de reconectar: una sesión es **una** conexión, y una reconexión silenciosa escondería
    // justo el corte que la transcripción tiene que contar.
    reconnectPeriod: 0,
    resubscribe: false,
    connectTimeout: options.connectTimeoutMs,
    ...(v5
      ? {
          properties: {
            maximumPacketSize: options.maxPacketBytes + 5,
            ...(options.userProperties?.length ? { userProperties: userPropertyRecord(options.userProperties) } : {}),
          },
        }
      : {}),
    ...(options.will
      ? {
          will: {
            topic: options.will.topic,
            payload: Buffer.from(options.will.payload, "utf8"),
            qos: options.will.qos,
            retain: options.will.retain,
          },
        }
      : {}),
  };

  return new Promise((resolve, reject) => {
    let state: "connecting" | "open" | "failed" = "connecting";
    let disconnect: { reason: string; code?: number } | null = null;

    const client = new MqttClient(
      () => guardedStream(pinnedBrokerStream(url, address, options), options.maxPacketBytes),
      clientOptions,
    );

    const fail = (error: Error) => {
      if (state === "open") {
        listeners.onError(error);
        return;
      }
      if (state === "failed") return;
      state = "failed";
      client.end(true);
      reject(error);
    };

    // Enganchadas aquí, con el cliente recién creado: nada puede llegar antes.
    client.on("message", (topic, payload, packet) => {
      if (state === "failed") return;
      const properties = deliveryProperties(packet.properties);
      listeners.onMessage({
        topic,
        payload,
        qos: packet.qos,
        retain: packet.retain,
        ...(properties ? { properties } : {}),
      });
    });
    client.on("disconnect", (packet) => {
      const code = packet.reasonCode ?? 0;
      disconnect = { reason: `el broker desconectó: ${refusalText(code)}`, code };
    });
    client.on("error", (error) => {
      // Un `CONNACK` con código es un no del broker, y se dice como tal: con el código y su nombre.
      const code = (error as { code?: unknown }).code;
      if (state === "connecting" && typeof code === "number" && !client.connected) {
        fail(new MqttRejectedError(code, rawUrl, `el broker rechazó la conexión: CONNACK ${refusalText(code)}`));
        return;
      }
      fail(error);
    });
    client.on("close", () => {
      if (state === "open") {
        state = "failed";
        listeners.onClose(disconnect?.reason ?? "el broker cerró la conexión", disconnect?.code);
        return;
      }
      fail(new Error(disconnect?.reason ?? "el broker cerró la conexión antes de confirmarla"));
    });

    client.once("connect", (connack: IConnackPacket) => {
      if (state !== "connecting") return;
      const status = (v5 ? connack.reasonCode : connack.returnCode) ?? 0;
      const handshake = {
        status,
        via: "CONNACK",
        headers: {
          protocolo: v5 ? "MQTT 5.0" : "MQTT 3.1.1",
          "sesión previa": connack.sessionPresent ? "sí" : "no",
          suscripciones: options.subscriptions.map((s) => `${s.topic} (QoS ${s.qos})`).join(", ") || "ninguna",
          // El tema del testamento, no su cuerpo: basta para saber que lo lleva y dónde saldría.
          ...(options.will ? { testamento: `${options.will.topic} (QoS ${options.will.qos})` } : {}),
        },
      };
      listeners.onOpen?.(handshake);
      const done = () => {
        if (state !== "connecting") return;
        state = "open";
        resolve({ client, handshake });
      };
      if (!options.subscriptions.length) return done();

      const wanted = Object.fromEntries(options.subscriptions.map((s) => [s.topic, { qos: s.qos }]));
      client.subscribe(wanted, (error, _granted, packet) => {
        const refused = refusedCodes(packet?.granted);
        if (refused.length) {
          const { code, index } = refused[0];
          const topic = options.subscriptions[index]?.topic ?? "?";
          fail(
            new MqttRejectedError(code, rawUrl, `el broker rechazó la suscripción a ${topic}: ${refusalText(code)}`),
          );
          return;
        }
        if (error) return fail(error);
        done();
      });
    });
  });
}

/** Los códigos de un `SUBACK`, uno por tema y en el orden pedido; 0x80 o más es un no. */
function subackCodes(granted: unknown): number[] {
  return ((granted ?? []) as (number | { qos: number })[]).map((code) => (typeof code === "number" ? code : code.qos));
}

function refusedCodes(granted: unknown): { code: number; index: number }[] {
  return subackCodes(granted)
    .map((code, index) => ({ code, index }))
    .filter(({ code }) => (code & 0x80) !== 0);
}

/**
 * Suscribirse a mitad de sesión: la QoS concedida, o `MqttRejectedError` con el código si el broker
 * dijo que no.
 *
 * Al contrario que al conectar, un no aquí **no** cierra la sesión: se pidió un tema más y no se
 * concedió, pero lo que ya se oía se sigue oyendo. Quien llama lo anota como un hecho de la sesión.
 * Con plazo, porque un broker que nunca contesta el `SUBACK` dejaría la petición colgada.
 */
export function subscribeMqtt(client: MqttClient, topic: string, qos: MqttQos, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`el broker no confirmó la suscripción en ${timeoutMs} ms`)),
      timeoutMs,
    );
    client.subscribe({ [topic]: { qos } }, (error, _granted, packet) => {
      clearTimeout(timer);
      const codes = subackCodes(packet?.granted);
      const refused = refusedCodes(packet?.granted)[0];
      if (refused) return reject(new MqttRejectedError(refused.code, topic, refusalText(refused.code)));
      if (error) return reject(error);
      resolve(codes[0] ?? qos);
    });
  });
}

/** Dejar de oír un filtro. En 5.0 el `UNSUBACK` trae un código por tema y también puede ser un no. */
export function unsubscribeMqtt(client: MqttClient, topic: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`el broker no confirmó la baja en ${timeoutMs} ms`)), timeoutMs);
    client.unsubscribe(topic, (error, packet) => {
      clearTimeout(timer);
      const code = subackCodes((packet as { granted?: unknown; reasonCode?: unknown } | undefined)?.granted)[0];
      if (code !== undefined && (code & 0x80) !== 0)
        return reject(new MqttRejectedError(code, topic, refusalText(code)));
      if (error) return reject(error);
      resolve();
    });
  });
}

/**
 * Lo que se enseña de las propiedades de un `PUBLISH`. `null` si no trae ninguna de esas: la
 * de tope de paquete o de alias de tema son del transporte y no le dicen nada a quien depura.
 */
function deliveryProperties(properties: IPublishPacket["properties"]): MqttDeliveryProperties | null {
  if (!properties) return null;
  const out: MqttDeliveryProperties = {};
  const pairs = userPropertyPairs(properties.userProperties as Record<string, string | string[]> | undefined);
  if (pairs.length) out.userProperties = pairs;
  if (properties.contentType) out.contentType = properties.contentType;
  if (properties.responseTopic) out.responseTopic = properties.responseTopic;
  if (properties.correlationData) out.correlationData = Buffer.from(properties.correlationData);
  return Object.keys(out).length ? out : null;
}

export { BlockedTargetError };
