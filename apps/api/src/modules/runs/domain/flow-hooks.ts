/**
 * La mitad de entrada de un nodo `webhook`: una URL de un solo uso a la que llama un sistema externo
 * para que un flujo siga.
 *
 * Es la única ruta del producto que **cualquiera en internet** puede llamar sin sesión y que además
 * escribe, y eso da forma a cada regla de aquí:
 *
 * - **El token es la credencial, y no se guarda en ninguna parte.** 32 bytes de HMAC-SHA256 del id de
 *   la espera con una clave del servidor (derivada de `JWT_ACCESS_SECRET`), en base64url. La base
 *   guarda el SHA-256 del token, que es por donde lo busca la ruta pública, y el id; cualquier
 *   instancia puede volver a calcular la URL para enseñarla en la corrida, y un volcado de la base no
 *   entrega nada que se pueda llamar. Tampoco va en la fila del paso: ahí queda con el token tapado.
 * - **Un solo uso.** Aceptar la llamada y guardar lo que trajo es un único `UPDATE` condicional, así
 *   que dos llamadas a la misma URL no ganan las dos, y una llamada contestada con 202 no se pierde
 *   porque la corrida dejara de esperar en el mismo instante.
 * - **Sin oráculo.** Desconocido, mal formado, caducado, ya usado, otro verbo: el mismo 404. Quien
 *   llama solo sabe si **su** llamada se aceptó.
 * - **Lo que se guarda de la llamada es lo que una comprobación puede usar, tapado.** El cuerpo
 *   (≤ 1 MB, parseado si dice JSON) y una lista blanca de cabeceras, con las mismas reglas que una
 *   captura o un ejemplo: la `Authorization` del proveedor o la cookie de un navegador no acaban en
 *   un paso de corrida que alguien comparte en una captura de pantalla. Una comprobación sobre un
 *   campo con nombre de credencial ve la máscara, igual que en un ejemplo guardado.
 */
import { createHash, createHmac } from "node:crypto";
import type { ActualResponse } from "@eq/runner-core";

import { MASK, SECRET_FIELD, SECRET_HEADER, redactBody } from "@/modules/endpoints/domain/examples";

export const FLOW_HOOK_REPOSITORY = Symbol("FLOW_HOOK_REPOSITORY");

/** Donde vive la ruta, sin la base pública. El lector del cuerpo se monta en el mismo prefijo. */
export const FLOW_HOOK_PATH = "/hooks/flows";

/** El tema del bus por el que la instancia que aceptó la llamada despierta a la que espera. */
export const FLOW_HOOK_TOPIC = "runs.flow-hook.delivered";

/** 32 bytes en base64url sin relleno: exactamente 43 caracteres del alfabeto de URL. Cualquier otra
 * cosa se rechaza antes de tocar la base. */
export const FLOW_HOOK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Lo que ocupa el lugar del token en la fila del paso. */
export const REDACTED_TOKEN = "[token-redactado]";

export type FlowHookMethod = "POST" | "PUT";

/**
 * - `open`: esperando la llamada.
 * - `delivered`: la llamada llegó y el flujo aún no la ha leído.
 * - `closed`: nadie llamó a tiempo, o la corrida se canceló.
 * - `settled`: el flujo leyó lo que llegó, y lo que llegó ya no está en la fila.
 */
export type FlowHookStatus = "open" | "delivered" | "closed" | "settled";

export type FlowHook = {
  id: string;
  tokenHash: string;
  runId: string;
  caseId: string;
  stepId: string;
  method: FlowHookMethod;
  status: FlowHookStatus;
  expiresAt: Date;
  delivery: FlowHookDelivery | null;
  createdAt: Date;
};

/** Lo que trajo una llamada aceptada, ya tapado. */
export type FlowHookDelivery = {
  method: FlowHookMethod;
  contentType: string;
  headers: Record<string, string>;
  /** Parseado cuando el tipo dice JSON y parsea; el texto si no. */
  body: unknown;
  raw: string;
  /** ISO: cruza la base y el bus, así que va como texto. */
  receivedAt: string;
};

/**
 * Las esperas y las llamadas que tomaron.
 *
 * Un puerto propio y no tres métodos más en la cola: la cola es cómo se ejecuta una corrida, y esto
 * es cómo una llamada de fuera encuentra la corrida que la espera — en la instancia que sea.
 */
export interface FlowHookRepositoryPort {
  open(hook: FlowHook): Promise<void>;
  /**
   * Toma la espera de `tokenHash` si existe, sigue abierta, no ha caducado en `now` y se abrió para
   * `method`, y guarda `delivery` — en un solo paso. Devuelve la espera tomada, o null: el 404, sin
   * decir por qué.
   */
  deliver(tokenHash: string, method: FlowHookMethod, delivery: FlowHookDelivery, now: Date): Promise<FlowHook | null>;
  find(id: string): Promise<FlowHook | null>;
  /**
   * Termina la espera: la cierra si seguía abierta —desde aquí toda llamada es un 404— y devuelve la
   * entrega si la hubo, dejándola fuera de la fila. Atómico con `deliver`: o la llamada entró antes y
   * sale aquí, o ya no puede entrar.
   */
  settle(id: string): Promise<FlowHookDelivery | null>;
  /** Las que siguen esperando en `now`, para enseñar su URL en la corrida. */
  openForRun(runId: string, now: Date): Promise<FlowHook[]>;
}

/** El tope del cuerpo. Más que cualquier notificación de un proveedor y mucho menos que los 8 MB de
 * las rutas con sesión: esta está abierta a internet. */
export const MAX_HOOK_BODY_BYTES = 1_048_576;

/** Cuántas llamadas por minuto acepta la ruta de un mismo cliente. Un token son 256 bits, así que no
 * es por adivinar: es cuánto puede empujar alguien contra una ruta pública que escribe. */
export const HOOK_RATE_LIMIT = 60;

/**
 * La clave con la que se derivan los tokens: un HMAC de `JWT_ACCESS_SECRET` con una etiqueta propia.
 *
 * De ese secreto porque es el único que toda instalación tiene seguro y que comparten todas las
 * instancias, y con etiqueta para que la clave de los webhooks no sea la de firmar sesiones. Rotar el
 * secreto invalida las esperas en curso, que es lo que se espera de rotar un secreto.
 */
export function flowHookKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("endpoint-quality:flow-hook-token:v1").digest();
}

/** El token de una espera: siempre el mismo para el mismo id y la misma clave. */
export function flowHookToken(key: Buffer, hookId: string): string {
  return createHmac("sha256", key).update(hookId).digest("base64url");
}

/** Cómo se guarda y se busca un token: su SHA-256, como un token de API. */
export function hashFlowHookToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

/** Cabeceras que se quedan por nombre. Las firmas no son secretos: son con lo que una comprobación
 * verifica al proveedor. */
const KEPT_HEADERS = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "idempotency-key",
  "traceparent",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "stripe-signature",
]);
/** Fuera sean lo que sean: las que describen la red delante de esta API y no a quien llama. */
const DROPPED_HEADER = /forwarded|real-ip|client-ip/i;
/** Tapadas, como en una captura: se enseña que llegaron, no lo que valían. */
const MASKED_HEADER = /authorization|cookie|token|secret|api[-_]?key|session|password/i;
const MAX_HEADERS = 40;
const MAX_HEADER_VALUE = 1_024;

/** Las cabeceras de una llamada que vale la pena guardar, en minúsculas: la lista blanca más las `x-…`,
 * sin las de red, con las de credencial tapadas, y con tope de número y de largo. */
export function keptHookHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (Object.keys(kept).length >= MAX_HEADERS) break;
    const name = rawName.toLowerCase();
    if (rawValue === undefined || DROPPED_HEADER.test(name)) continue;
    if (!KEPT_HEADERS.has(name) && !name.startsWith("x-") && !SECRET_HEADER.test(name) && !MASKED_HEADER.test(name))
      continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    kept[name] = SECRET_HEADER.test(name) || MASKED_HEADER.test(name) ? MASK : value.slice(0, MAX_HEADER_VALUE);
  }
  return kept;
}

/**
 * El cuerpo tapado: JSON por la forma y por el nombre del campo (`redactBody`, lo de los ejemplos),
 * un formulario por el nombre del campo, y el resto tal cual.
 */
export function redactHookBody(raw: string, contentType: string): string {
  if (!raw) return raw;
  if (/x-www-form-urlencoded/i.test(contentType)) {
    return raw
      .split("&")
      .map((pair) => {
        const equals = pair.indexOf("=");
        if (equals === -1) return pair;
        let name = pair.slice(0, equals);
        try {
          name = decodeURIComponent(name.replace(/\+/g, " "));
        } catch {
          // Un nombre mal codificado se compara tal cual.
        }
        return SECRET_FIELD.test(name) ? `${pair.slice(0, equals)}=${encodeURIComponent(MASK)}` : pair;
      })
      .join("&");
  }
  return redactBody(raw, contentType).body;
}

/**
 * Lo que llegó, como entrega y ya tapado. Un tipo JSON que no parsea se queda como texto en vez de
 * rechazarse: la carga del proveedor es la que es, y una comprobación que falla sobre ella dice más
 * que un 400 que el proveedor reintentará para siempre.
 */
export function readHookPayload(
  method: FlowHookMethod,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  now: Date,
): FlowHookDelivery {
  const kept = keptHookHeaders(headers);
  const contentType = kept["content-type"] ?? "";
  const received = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : "";
  const raw = redactHookBody(received, contentType);
  let parsed: unknown = raw;
  if (/[/+]json\b/i.test(contentType) && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  return { method, contentType, headers: kept, body: parsed, raw, receivedAt: now.toISOString() };
}

/** Una entrega como la respuesta que recibió el nodo: lo que leen sus comprobaciones, sus capturas y
 * los nodos siguientes. */
export function hookResponse(delivery: FlowHookDelivery): ActualResponse {
  return {
    status: 200,
    statusText: "OK",
    contentType: delivery.contentType,
    headers: delivery.headers,
    body: delivery.body,
    raw: delivery.raw,
  };
}

/**
 * La base con la que empieza la URL publicada.
 *
 * `PUBLIC_API_URL` cuando está —lo que un despliegue detrás de un proxy o con prefijo tiene que
 * poner, porque el trabajador que acuña la URL no tiene petición de la que sacar un origen y puede no
 * ser la instancia a la que llegará el proveedor—. Sin ella, la API en su puerto de localhost: bien
 * para un portátil y mal para cualquier cosa a la que tenga que llamar un proveedor en internet, que
 * es por lo que existe la variable.
 */
export function publicApiBase(env: { PUBLIC_API_URL?: string; PORT: number }): string {
  return (env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");
}

/** Lo que hace falta del entorno para escribir la URL de una espera. */
export type FlowHookEnv = { PUBLIC_API_URL?: string; PORT: number; JWT_ACCESS_SECRET: string };

/**
 * La URL de una espera, con el token (`url`, para quien sigue la corrida) y con el token tapado
 * (`redactedUrl`, lo que queda escrito en la fila del paso). Se calcula cada vez: no hay una copia
 * del token que borrar después.
 */
export function flowHookUrls(env: FlowHookEnv, hookId: string): { url: string; redactedUrl: string } {
  const base = `${publicApiBase(env)}${FLOW_HOOK_PATH}`;
  return {
    url: `${base}/${flowHookToken(flowHookKey(env.JWT_ACCESS_SECRET), hookId)}`,
    redactedUrl: `${base}/${REDACTED_TOKEN}`,
  };
}
