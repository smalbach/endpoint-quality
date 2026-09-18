/**
 * Capturar tráfico: un proxy al que se apunta un navegador o un móvil, y lo que pasó por él.
 *
 * Es la puerta de Postman que faltaba junto al HAR. El HAR pide abrir el inspector, usar la
 * aplicación y exportar; hay tráfico que no sale de ningún inspector —una app de móvil, un cliente
 * de escritorio, un script que no es tuyo— y para ese lo que hace Postman es levantar un proxy
 * local, grabar lo que pasa por él en una «sesión de captura» y dejar elegir qué se guarda.
 *
 * ## Lo que se guarda ya viene tapado
 *
 * Una captura es tráfico real de alguien: el `Bearer` de su sesión, la cookie, la contraseña del
 * formulario de login. **Se tapa al escribir**, no al leer ni al importar: lo que no está en la
 * tabla no se puede filtrar por un volcado, por una consulta mal filtrada ni por una pantalla que
 * se olvida de redactar. Las reglas son las de los ejemplos (`SECRET_HEADER`, `SECRET_FIELD`, el
 * JWT reconocido por su forma), para que un secreto no tenga dos definiciones que discrepen.
 *
 * La `Authorization` conserva **el esquema** —`Bearer ••••••••`— y pierde el valor: el esquema es
 * lo que el import del HAR lee para saber cómo entra el endpoint, y no es un secreto.
 *
 * ## De la captura a los endpoints, por el mismo camino que el HAR
 *
 * Lo elegido se escribe como un HAR y entra por el import de siempre. No hay un segundo lector: el
 * filtro del ruido (bundles, hojas de estilo, fuentes, telemetría, el `OPTIONS` de preflight), la
 * ruta repetida que se vuelve otro ejemplo y la credencial sin valor son exactamente los del HAR,
 * porque son el mismo código.
 */
import { randomUUID } from "node:crypto";
import type { CaptureItemSummaryView, CaptureItemView, CaptureSessionView } from "@eq/contracts";

import { harNoise } from "@/modules/workflows/domain/import-requests";
import { MASK, SECRET_FIELD, SECRET_HEADER, redactBody } from "@/modules/endpoints/domain/examples";

export const CAPTURE_STATUSES = ["active", "stopped"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * Por qué terminó una sesión.
 *
 * - `manual`: alguien pulsó «Parar».
 * - `expired`: se acabó su tiempo. Una sesión que nadie para no puede quedarse abierta para
 *   siempre: es un proxy autenticado con un token que alguien copió en un móvil.
 * - `request-limit`: llegó al tope de peticiones.
 * - `replaced`: se abrió otra en el mismo proyecto. Una por proyecto: dos sesiones vivas son dos
 *   tokens válidos y una lista partida en dos.
 * - `restart`: la API se reinició. El proxy vive en el proceso y el registro de tokens en memoria,
 *   así que una sesión «activa» en la tabla sin proceso detrás no está activa.
 */
export const CAPTURE_STOP_REASONS = ["manual", "expired", "request-limit", "replaced", "restart"] as const;
export type CaptureStopReason = (typeof CAPTURE_STOP_REASONS)[number];

/** Los topes de una sesión, fijados al abrirla desde la configuración del despliegue. */
export type CaptureLimits = {
  /** Cuánto dura como mucho, en milisegundos. */
  durationMs: number;
  /** Cuántas peticiones graba antes de pararse sola. */
  maxRequests: number;
  /** Cuánto se guarda de cada cuerpo. Lo que pasa por el proxy no se corta: se corta lo guardado. */
  maxBodyBytes: number;
};

export type CaptureSession = {
  id: string;
  projectId: string;
  status: CaptureStatus;
  /** El hash del token. El token en claro se enseña una vez, al abrir, y no se guarda. */
  tokenHash: string;
  limits: CaptureLimits;
  itemCount: number;
  startedAt: Date;
  expiresAt: Date;
  stoppedAt: Date | null;
  stopReason: CaptureStopReason | null;
  startedBy: string;
};

/** Una petición grabada, ya tapada. */
export type CaptureItem = {
  id: string;
  sessionId: string;
  projectId: string;
  /** El orden de llegada dentro de la sesión, desde 1. Es el cursor de la lista en vivo. */
  seq: number;
  at: Date;
  method: string;
  url: string;
  /** `null` en un túnel y en una petición que no llegó a contestar. */
  status: number | null;
  /**
   * Un `CONNECT`: un túnel HTTPS que el proxy abrió sin mirar dentro.
   *
   * Solo se sabe a qué `host:puerto` iba. Descifrarlo pediría instalar una CA de este producto en
   * el dispositivo, y eso no se hace por defecto (ver `capture-proxy.ts`).
   */
  encrypted: boolean;
  requestHeaders: Record<string, string>;
  requestBody: string;
  requestBodyTruncated: boolean;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseBodyTruncated: boolean;
  responseContentType: string;
  durationMs: number;
  /** Por qué no se reenvió o no contestó, dicho en palabras. */
  error: string | null;
};

/** Lo que el proxy vio, en bruto. Solo vive en memoria el tiempo de convertirlo en un `CaptureItem`. */
export type RawExchange = {
  at: Date;
  method: string;
  url: string;
  status: number | null;
  encrypted: boolean;
  requestHeaders: Record<string, string>;
  requestBody: Buffer;
  requestBodyTruncated: boolean;
  responseHeaders: Record<string, string>;
  responseBody: Buffer;
  responseBodyTruncated: boolean;
  durationMs: number;
  error: string | null;
};

/* ------------------------------------------------------------------ *
 * La redacción, al escribir
 * ------------------------------------------------------------------ */

/**
 * Las cabeceras con los valores de las credenciales tapados.
 *
 * Se tapan y no se quitan, a diferencia de un ejemplo: aquí lo que se enseña es **qué mandó** el
 * cliente, y una petición que llevaba `Authorization` y en la lista aparece sin ella dice otra cosa.
 * `Authorization` y `Proxy-Authorization` conservan el esquema.
 */
export function redactCapturedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET_HEADER.test(name.trim())) {
      out[name] = value;
      continue;
    }
    const lowered = name.trim().toLowerCase();
    const scheme = /^\s*([A-Za-z][\w-]*)\s+\S/.exec(value)?.[1];
    out[name] =
      (lowered === "authorization" || lowered === "proxy-authorization") && scheme ? `${scheme} ${MASK}` : MASK;
  }
  return out;
}

/**
 * La URL con los valores de la query que son credenciales tapados: `?access_token=…`, `?api_key=…`.
 *
 * Es la tercera forma en que viaja un secreto, y la que acaba en los registros de todo el mundo.
 * Se reescribe a mano y no con `URLSearchParams`, que volvería a codificar el resto de la query y
 * cambiaría una URL que solo había que tapar.
 */
export function redactCapturedUrl(url: string): string {
  const hash = url.indexOf("#");
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const cut = withoutHash.indexOf("?");
  if (cut === -1) return withoutHash;
  const query = withoutHash
    .slice(cut + 1)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const rawName = equals === -1 ? pair : pair.slice(0, equals);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, " "));
      } catch {
        // Un nombre mal codificado se compara tal cual.
      }
      return SECRET_FIELD.test(name) && equals !== -1 ? `${rawName}=${encodeURIComponent(MASK)}` : pair;
    })
    .join("&");
  // El fragmento no viaja al servidor: si lo trae, es porque lo escribió el cliente, y se quita.
  return `${withoutHash.slice(0, cut)}?${query}`;
}

/**
 * Un cuerpo, tapado: JSON por la forma (`redactBody`), un formulario por el nombre del campo, y el
 * resto tal cual —adivinar dónde está el secreto en un XML es cortar el cuerpo por la mitad—.
 */
export function redactCapturedBody(body: string, contentType: string): string {
  if (!body) return body;
  if (/x-www-form-urlencoded/i.test(contentType)) {
    return body
      .split("&")
      .map((pair) => {
        const equals = pair.indexOf("=");
        if (equals === -1) return pair;
        let name = pair.slice(0, equals);
        try {
          name = decodeURIComponent(name.replace(/\+/g, " "));
        } catch {
          // Igual que en la URL: se compara tal cual.
        }
        return SECRET_FIELD.test(name) ? `${pair.slice(0, equals)}=${encodeURIComponent(MASK)}` : pair;
      })
      .join("&");
  }
  return redactBody(body, contentType).body;
}

/**
 * Los valores de las credenciales que la petición llevó: la de `Authorization` sin su esquema, las
 * cookies, las cabeceras de clave, la query y los campos con nombre de credencial —de la petición y
 * de la respuesta—.
 *
 * Tapar por nombre de campo no basta, y esto salió probando contra un servidor de verdad: un eco
 * como el de httpbin devuelve la URL entera en `"url"`, un campo que no se llama como una
 * credencial, y `?api_key=…` quedaba en claro en la fila. Con los valores en la mano se tapan
 * donde aparezcan, igual que la consola de un script tapa los secretos del entorno.
 */
export function credentialValues(raw: RawExchange): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 4 && trimmed !== MASK) found.add(trimmed);
  };
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text.replace(/\+/g, " "));
    } catch {
      return text;
    }
  };
  const pairs = (text: string) =>
    text.split("&").map((pair) => {
      const equals = pair.indexOf("=");
      return equals === -1 ? null : ([decode(pair.slice(0, equals)), pair.slice(equals + 1)] as const);
    });
  const fromPairs = (text: string) => {
    for (const pair of pairs(text)) {
      if (!pair || !SECRET_FIELD.test(pair[0])) continue;
      add(pair[1]);
      add(decode(pair[1]));
    }
  };
  const fromJson = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const walk = (value: unknown, key: string, depth: number) => {
      if (depth > 20) return;
      if (typeof value === "string" || typeof value === "number") {
        if (key && SECRET_FIELD.test(key)) add(String(value));
        return;
      }
      if (Array.isArray(value)) for (const item of value) walk(item, key, depth + 1);
      else if (value && typeof value === "object")
        for (const [name, item] of Object.entries(value)) walk(item, name, depth + 1);
    };
    walk(parsed, "", 0);
  };
  for (const headers of [raw.requestHeaders, raw.responseHeaders])
    for (const [name, value] of Object.entries(headers)) {
      if (!SECRET_HEADER.test(name.trim())) continue;
      const lowered = name.trim().toLowerCase();
      if (lowered === "cookie" || lowered === "set-cookie") {
        // En `Set-Cookie` solo el primer par es la cookie; `Domain=api.example.com` y compañía son
        // atributos, y tomarlos por secretos taparía el dominio en todo el cuerpo.
        const parts = lowered === "cookie" ? value.split(";") : value.split("\n").map((line) => line.split(";")[0]!);
        for (const part of parts) {
          const equals = part.indexOf("=");
          if (equals !== -1) add(part.slice(equals + 1));
        }
        continue;
      }
      add(value);
      add(/^\s*[A-Za-z][\w-]*\s+(\S.*)$/.exec(value)?.[1]);
    }
  const cut = raw.url.indexOf("?");
  if (cut !== -1) fromPairs(raw.url.slice(cut + 1).split("#")[0]!);
  for (const [body, headers] of [
    [raw.requestBody, raw.requestHeaders],
    [raw.responseBody, raw.responseHeaders],
  ] as const) {
    const text = textOf(body);
    if (!text) continue;
    if (/x-www-form-urlencoded/i.test(headerOf(headers, "content-type"))) fromPairs(text);
    else fromJson(text);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** Cada valor, y su forma codificada en una URL, cambiado por `mask` donde aparezca. */
function maskValues(text: string, values: string[], mask = MASK): string {
  let out = text;
  for (const value of values)
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))
      if (form.length >= 4) out = out.split(form).join(mask);
  return out;
}

/** La cabecera, sin importar cómo la escribió quien la mandó. */
export function headerOf(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1] ?? "";
}

/**
 * Lo que el proxy vio, como fila: tapado, con los cuerpos como texto y con su tope.
 *
 * Un cuerpo que no es UTF-8 —una imagen, un protobuf— no se guarda: decodificado sería basura que
 * pesa, y lo que se viene a buscar aquí es la API. Se dice que no se guardó en vez de callarlo.
 */
export function captureItemFrom(
  raw: RawExchange,
  context: { sessionId: string; projectId: string; seq: number },
): CaptureItem {
  const requestType = headerOf(raw.requestHeaders, "content-type");
  const responseType = headerOf(raw.responseHeaders, "content-type");
  const secrets = credentialValues(raw);
  const hide = (text: string) => maskValues(text, secrets);
  const hideHeaders = (headers: Record<string, string>) =>
    Object.fromEntries(Object.entries(redactCapturedHeaders(headers)).map(([name, value]) => [name, hide(value)]));
  return {
    id: randomUUID(),
    sessionId: context.sessionId,
    projectId: context.projectId,
    seq: context.seq,
    at: raw.at,
    // Los largos de las columnas. Una URL de más de 4000 caracteres no es una API que alguien
    // quiera importar, y cortarla es mejor que perder la fila entera en un error de la base.
    method: raw.method.toUpperCase().slice(0, 16),
    url: maskValues(redactCapturedUrl(raw.url), secrets, encodeURIComponent(MASK)).slice(0, 4000),
    status: raw.status,
    encrypted: raw.encrypted,
    requestHeaders: hideHeaders(raw.requestHeaders),
    requestBody: hide(
      raw.requestBodyTruncated ? textOf(raw.requestBody) : redactCapturedBody(textOf(raw.requestBody), requestType),
    ),
    requestBodyTruncated: raw.requestBodyTruncated,
    responseHeaders: hideHeaders(raw.responseHeaders),
    responseBody: hide(
      raw.responseBodyTruncated
        ? maskTruncated(textOf(raw.responseBody))
        : redactCapturedBody(textOf(raw.responseBody), responseType),
    ),
    responseBodyTruncated: raw.responseBodyTruncated,
    responseContentType: responseType.split(";")[0]!.trim().slice(0, 200),
    durationMs: raw.durationMs,
    error: raw.error ? hide(raw.error).slice(0, 500) : null,
  };
}

/**
 * El texto de unos bytes, o vacío cuando no son texto.
 *
 * Un `\uFFFD` en lo decodificado es la marca de que no era UTF-8 —o de que el tope cortó un
 * carácter por la mitad, y por eso se mira solo antes del último—.
 */
function textOf(bytes: Buffer): string {
  if (!bytes.length) return "";
  const text = bytes.toString("utf8");
  const replacement = text.indexOf("\uFFFD");
  if (replacement !== -1 && replacement < text.length - 3) return "";
  // Un byte nulo no aparece en un texto que alguien quiera leer.
  if (text.includes("\u0000")) return "";
  return text;
}

/**
 * Un cuerpo cortado no parsea como JSON, así que `redactBody` lo dejaría intacto. Lo que sí se
 * puede hacer sin parsearlo es tapar los valores con nombre de credencial y los JWT sueltos: es el
 * caso de un login cuya respuesta es más larga que el tope.
 */
function maskTruncated(text: string): string {
  return text
    .replace(/"([^"\\]{1,64})"\s*:\s*"(?:[^"\\]|\\.)*"/g, (whole, key: string) =>
      SECRET_FIELD.test(key) ? `"${key}": "${MASK}"` : whole,
    )
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, (candidate) =>
      /^eyJ/.test(candidate) ? MASK : candidate,
    );
}

/* ------------------------------------------------------------------ *
 * Las vistas
 * ------------------------------------------------------------------ */

export function viewCaptureSession(session: CaptureSession): CaptureSessionView {
  return {
    id: session.id,
    status: session.status,
    stopReason: session.stopReason,
    itemCount: session.itemCount,
    limits: session.limits,
    startedAt: session.startedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    stoppedAt: session.stoppedAt?.toISOString() ?? null,
  };
}

export const ENCRYPTED_NOTE = "cifrado, sin detalle";

/**
 * Una fila de la lista en vivo.
 *
 * `noise` es `harNoise`, la misma función que filtra un HAR, así que la pantalla puede dejar sin
 * marcar lo que de todos modos no iba a entrar —y decir por qué— sin tener una segunda lista de
 * ruido.
 */
export function viewCaptureItemSummary(item: CaptureItem): CaptureItemSummaryView {
  let host = "";
  try {
    host = new URL(item.url).host;
  } catch {
    host = "";
  }
  return {
    id: item.id,
    seq: item.seq,
    at: item.at.toISOString(),
    method: item.method,
    url: item.url,
    host,
    status: item.status,
    encrypted: item.encrypted,
    contentType: item.responseContentType,
    durationMs: item.durationMs,
    error: item.error,
    noise: item.encrypted
      ? ENCRYPTED_NOTE
      : item.error
        ? "no llegó a contestar"
        : harNoise(item.method, item.url, item.responseContentType),
  };
}

export function viewCaptureItem(item: CaptureItem): CaptureItemView {
  return {
    ...viewCaptureItemSummary(item),
    requestHeaders: item.requestHeaders,
    requestBody: item.requestBody,
    requestBodyTruncated: item.requestBodyTruncated,
    responseHeaders: item.responseHeaders,
    responseBody: item.responseBody,
    responseBodyTruncated: item.responseBodyTruncated,
  };
}

/* ------------------------------------------------------------------ *
 * Hacia el import
 * ------------------------------------------------------------------ */

/** Lo que no puede entrar por el import, con el motivo. Un túnel no tiene método ni ruta que leer. */
export function unimportable(item: CaptureItem): string | null {
  if (item.encrypted) return `${item.url}: ${ENCRYPTED_NOTE}`;
  return null;
}

const headerList = (headers: Record<string, string>) =>
  Object.entries(headers).map(([name, value]) => ({ name, value }));

/**
 * Las peticiones elegidas, escritas como el HAR que habría exportado un navegador.
 *
 * Es el puente entero hacia el import: a partir de aquí son una entrada más de `parseHar`, con su
 * filtro, su deduplicación por ruta y su credencial sin valor. Una petición sin respuesta sale con
 * estado 0, que es lo que un navegador anota en una cancelada y lo que `parseHar` ya sabe no
 * convertir en ejemplo. Los túneles no salen: no hay nada dentro que escribir.
 */
export function captureToHar(items: CaptureItem[]): string {
  const entries = items
    .filter((item) => !item.encrypted)
    .sort((left, right) => left.seq - right.seq)
    .map((item) => {
      const requestType = headerOf(item.requestHeaders, "content-type");
      return {
        startedDateTime: item.at.toISOString(),
        time: item.durationMs,
        request: {
          method: item.method,
          url: item.url,
          httpVersion: "HTTP/1.1",
          headers: headerList(item.requestHeaders),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: Buffer.byteLength(item.requestBody),
          ...(item.requestBody ? { postData: { mimeType: requestType, text: item.requestBody } } : {}),
        },
        response: {
          status: item.status ?? 0,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: headerList(item.responseHeaders),
          cookies: [],
          content: {
            size: Buffer.byteLength(item.responseBody),
            mimeType: item.responseContentType,
            text: item.responseBody,
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: item.durationMs, receive: 0 },
      };
    });
  return JSON.stringify({
    log: { version: "1.2", creator: { name: "endpoint-quality · captura", version: "1" }, entries },
  });
}

/**
 * Las peticiones elegidas como una colección de Postman de una sola carpeta, para el flujo.
 *
 * Un flujo es una secuencia, y la captura es justo eso: el orden en que la aplicación llamó. Se
 * escribe como colección para que entre por el importador de flujos de Postman —el que ya sabe
 * convertir peticiones en nodos encadenados— y no por uno nuevo. Se filtra el ruido con la misma
 * `harNoise` y **no** se deduplica: dos veces la misma ruta en un flujo son dos pasos.
 */
export function captureToFlowCollection(name: string, items: CaptureItem[]): { text: string; steps: number } {
  const steps = items
    .filter((item) => !item.encrypted && !item.error)
    .filter((item) => !harNoise(item.method, item.url, item.responseContentType))
    .sort((left, right) => left.seq - right.seq);
  const collection = {
    info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: steps.map((item) => {
      const requestType = headerOf(item.requestHeaders, "content-type");
      let path = item.url;
      try {
        path = new URL(item.url).pathname;
      } catch {
        // Se queda la URL entera como nombre.
      }
      return {
        name: `${item.method} ${path}`,
        request: {
          method: item.method,
          url: item.url,
          header: Object.entries(item.requestHeaders).map(([key, value]) => ({ key, value })),
          ...(item.requestBody
            ? {
                body: {
                  mode: "raw",
                  raw: item.requestBody,
                  ...(/json/i.test(requestType) ? { options: { raw: { language: "json" } } } : {}),
                },
              }
            : {}),
        },
      };
    }),
  };
  return { text: JSON.stringify(collection), steps: steps.length };
}
