/**
 * Un ejemplo guardado: lo que este endpoint contestó una vez, con la petición que lo provocó.
 *
 * **Es un par, no una respuesta.** Un 404 suelto no significa nada; un 404 junto a la petición que
 * lo produjo es documentación. Postman lo guarda así y es lo correcto, y además es lo que permite
 * las tres cosas para las que sirve un ejemplo: documentar el endpoint, alimentar un mock, y
 * comparar «lo que contesta hoy» contra «lo que contestaba».
 *
 * Hasta ahora eso no existía. La pregunta *«qué devolvía esto la semana pasada»* solo se respondía
 * buceando en el historial de una corrida, y una colección de Postman con ejemplos entraba aquí
 * perdiéndolos: el array `response` de cada `item` no se leía en ningún sitio.
 *
 * ## Los secretos no se guardan, y esta es la parte que importa
 *
 * Un ejemplo es exactamente donde una credencial se queda dormida para siempre. Se guarda una vez,
 * nadie la vuelve a mirar, y sale en la exportación, en la documentación y en el `git log` del
 * repositorio donde alguien commitea el fichero. Postman los guarda en claro y es un pie en un
 * charco conocido; aquí no.
 *
 * Tres capas, porque el secreto entra por tres sitios distintos:
 *
 * 1. **Las cabeceras de la petición.** `Authorization`, `Cookie`, una clave de API. Se van y se
 *    nombran: un ejemplo al que le falta la cabecera y no lo dice es un ejemplo que parece que
 *    funcionaba sin credencial.
 * 2. **El `Set-Cookie` de la respuesta.** Es la sesión que el servidor acababa de abrir.
 * 3. **El cuerpo de la respuesta.** Esta es la difícil, porque el cuerpo *es* el valor del
 *    ejemplo y no se puede tirar. Así que se conserva la forma —que es para lo que sirve— y se
 *    tapa el valor: los campos cuyo nombre suena a credencial, y cualquier JWT suelto, que se
 *    reconoce por su propia estructura y no por cómo se llame el campo que lo lleva.
 *
 * Lo tapado se nombra siempre. Un ejemplo que ha perdido algo en silencio es peor que uno que no
 * existe: alguien lo va a leer como el contrato del endpoint.
 */
import { randomUUID } from "node:crypto";

import type { EndpointHeader } from "./model";

/** Local, como en `model.ts` y en `send-request.ts`: el detalle de un campo inválido. */
type Problem = { field: string; detail: string };

export const MAX_EXAMPLE_NAME = 200;
/** Un cuerpo más largo que esto no es un ejemplo, es un volcado: no documenta nada y llena la
 * tabla. El límite es generoso a propósito — una respuesta de lista real ocupa bastante. */
export const MAX_EXAMPLE_BODY = 256 * 1024;
export const MAX_EXAMPLE_HEADERS = 60;
/** Cuántos caben por endpoint. Postman no pone límite y acaba con listas de cien que nadie lee. */
export const MAX_EXAMPLES_PER_ENDPOINT = 50;

export const EXAMPLE_ORIGINS = ["manual", "import"] as const;
export type ExampleOrigin = (typeof EXAMPLE_ORIGINS)[number];

/** La petición que produjo el ejemplo, tal y como salió — con la URL ya resuelta. */
export type ExampleRequest = {
  method: string;
  /** Resuelta: un ejemplo con `{{baseUrl}}` dentro no dice contra qué se probó. */
  url: string;
  headers: EndpointHeader[];
  body: { text: string; contentType: string };
};

export type ExampleResponse = {
  status: number;
  headers: EndpointHeader[];
  body: string;
  contentType: string;
  durationMs: number;
};

export type EndpointExample = {
  id: string;
  projectId: string;
  endpointId: string;
  name: string;
  request: ExampleRequest;
  response: ExampleResponse;
  origin: ExampleOrigin;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
};

export type ExampleInput = {
  name?: string;
  request?: ExampleRequest;
  response?: ExampleResponse;
};

/* ------------------------------------------------------------------ *
 * La redacción
 * ------------------------------------------------------------------ */

/**
 * Las cabeceras que no se guardan.
 *
 * Distinta de la del importador de peticiones a propósito: ahí se tira también el `Content-Type`
 * porque el ejecutor lo deriva del cuerpo y uno viejo contradiría lo que de verdad se manda. Aquí
 * el `Content-Type` **es** parte del ejemplo: es la mitad de lo que documenta una respuesta.
 */
export const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|.*-api-key|.*-secret|.*-token|token|secret)$/i;

/** Los nombres de campo cuyo valor se tapa dentro de un cuerpo JSON. */
export const SECRET_FIELD =
  /^(password|passwd|pwd|secret|client_?secret|api_?key|apikey|access_?token|refresh_?token|id_?token|token|authorization|private_?key|session|session_?id|sessionid|cookie|credential|otp|pin)$/i;

/**
 * Un JWT suelto, reconocido por su estructura y no por cómo se llame el campo.
 *
 * Es la parte que salva el caso real: un login devuelve el token en un campo que se llama `data`,
 * `jwt`, `t`, o directamente en la raíz del cuerpo, y una lista de nombres no lo va a atrapar. Tres
 * segmentos en base64url con el primero decodificando a algo que dice `"alg"` es un JWT y no una
 * coincidencia.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

export function looksLikeJwt(value: string): boolean {
  if (!JWT_SHAPE.test(value)) return false;
  try {
    const header = JSON.parse(Buffer.from(value.split(".")[0]!, "base64url").toString("utf8")) as unknown;
    return typeof header === "object" && header !== null && "alg" in header;
  } catch {
    // Tres segmentos que no decodifican a una cabecera JWT son tres segmentos. Un identificador
    // con dos puntos dentro no es una credencial y taparlo rompería el ejemplo.
    return false;
  }
}

export const MASK = "••••••••";

/** Las cabeceras sin las que son credenciales, y el nombre de las que se fueron. */
export function redactHeaders(headers: EndpointHeader[]): { headers: EndpointHeader[]; dropped: string[] } {
  const kept: EndpointHeader[] = [];
  const dropped: string[] = [];
  for (const header of headers) {
    if (SECRET_HEADER.test(header.name.trim())) dropped.push(header.name);
    else kept.push(header);
  }
  return { headers: kept, dropped };
}

/**
 * El cuerpo con los valores que son credenciales tapados, conservando la forma.
 *
 * Solo entra en JSON. Un cuerpo que no parsea se deja **tal cual**: adivinar dónde está el secreto
 * dentro de un XML o de un HTML con una expresión regular es la clase de cosa que corta el ejemplo
 * por la mitad o tapa un identificador que hacía falta. Lo que sí se hace es avisar, para que quien
 * guarde una respuesta que no es JSON sepa que ahí no se ha mirado.
 */
export function redactBody(body: string, contentType: string): { body: string; masked: string[]; scanned: boolean } {
  const looksJson = /json/i.test(contentType) || /^\s*[{[]/.test(body);
  if (!looksJson) return { body, masked: [], scanned: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, masked: [], scanned: false };
  }

  const masked: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      if (looksLikeJwt(value)) {
        masked.push(`${path || "(raíz)"} (JWT)`);
        return MASK;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]): [string, unknown] => {
          const here = path ? `${path}.${key}` : key;
          // Un campo que se llama como una credencial se tapa sea lo que sea su valor: un
          // `"password": ""` también dice algo, y un número puede ser un PIN.
          if (SECRET_FIELD.test(key) && item !== null) {
            masked.push(here);
            return [key, MASK];
          }
          return [key, walk(item, here)];
        }),
      );
    }
    return value;
  };

  const clean = walk(parsed, "");
  // Se vuelve a serializar indentado: un ejemplo se lee, y esta es la única vez que se toca.
  return { body: JSON.stringify(clean, null, 2), masked, scanned: true };
}

export type Redaction = {
  /** Nombres de cabecera que no se guardaron, de la petición y de la respuesta. */
  droppedHeaders: string[];
  /** Rutas del cuerpo cuyo valor se tapó. */
  maskedFields: string[];
  /** Falso cuando el cuerpo no es JSON y por tanto no se ha mirado dentro. */
  bodyScanned: boolean;
};

/** El ejemplo sin nada que sea una credencial, y el parte de lo que se fue. */
export function redactExample(
  request: ExampleRequest,
  response: ExampleResponse,
): { request: ExampleRequest; response: ExampleResponse; redaction: Redaction } {
  const fromRequest = redactHeaders(request.headers);
  const fromResponse = redactHeaders(response.headers);
  const requestBody = redactBody(request.body.text, request.body.contentType);
  const responseBody = redactBody(response.body, response.contentType);

  return {
    request: {
      ...request,
      headers: fromRequest.headers,
      body: { ...request.body, text: requestBody.body },
    },
    response: { ...response, headers: fromResponse.headers, body: responseBody.body },
    redaction: {
      droppedHeaders: [...new Set([...fromRequest.dropped, ...fromResponse.dropped])],
      maskedFields: [...requestBody.masked, ...responseBody.masked],
      // Lo que se enseña es si se miró dentro **de la respuesta**, que es el cuerpo que se guarda
      // para que alguien lo lea como contrato.
      bodyScanned: responseBody.scanned,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Validación y construcción
 * ------------------------------------------------------------------ */

/**
 * Una cabecera guardada con un salto de línea dentro.
 *
 * Es la misma regla que en `endpointProblems`, y aquí hace más falta: el valor de un ejemplo no lo
 * escribió una persona, lo contestó otro servidor o lo trajo un HAR. Y un ejemplo se vuelve a
 * servir —por el mock, por la exportación— así que un salto de línea guardado es una respuesta
 * partida en dos esperando a que alguien la lea.
 */
function headerBreakProblems(headers: EndpointHeader[], where: "request" | "response"): Problem[] {
  return headers.flatMap((header, index) =>
    /[\r\n]/.test(header?.value ?? "") || /[\r\n]/.test(header?.name ?? "")
      ? [{ field: `${where}.headers.${index}`, detail: "Una cabecera no lleva saltos de línea" }]
      : [],
  );
}

export function exampleProblems(input: ExampleInput): Problem[] {
  const problems: Problem[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) problems.push({ field: "name", detail: "El ejemplo necesita un nombre" });
    else if (name.length > MAX_EXAMPLE_NAME)
      problems.push({ field: "name", detail: `Como mucho ${MAX_EXAMPLE_NAME} caracteres` });
  }
  if (input.response !== undefined) {
    const { status, body, headers } = input.response;
    if (!Number.isInteger(status) || status < 100 || status > 599)
      problems.push({ field: "response.status", detail: "Un código de estado HTTP entre 100 y 599" });
    if (Buffer.byteLength(body, "utf8") > MAX_EXAMPLE_BODY)
      problems.push({
        field: "response.body",
        detail: `El cuerpo pasa de ${Math.round(MAX_EXAMPLE_BODY / 1024)} KB: eso es un volcado, no un ejemplo`,
      });
    if (headers.length > MAX_EXAMPLE_HEADERS)
      problems.push({ field: "response.headers", detail: `Como mucho ${MAX_EXAMPLE_HEADERS} cabeceras` });
    problems.push(...headerBreakProblems(headers, "response"));
  }
  if (input.request !== undefined) {
    problems.push(...headerBreakProblems(input.request.headers, "request"));
    if (!input.request.method.trim()) problems.push({ field: "request.method", detail: "Falta el método" });
    if (!input.request.url.trim()) problems.push({ field: "request.url", detail: "Falta la URL" });
    if (Buffer.byteLength(input.request.body.text, "utf8") > MAX_EXAMPLE_BODY)
      problems.push({ field: "request.body", detail: "El cuerpo de la petición pasa del límite" });
  }
  return problems;
}

/**
 * Un nombre que ningún otro ejemplo de este endpoint tenga.
 *
 * Numerado, que es lo que haría una persona. La alternativa —machacar el que ya estaba— descartaría
 * en silencio un ejemplo que alguien había ajustado a mano.
 */
export function uniqueExampleName(wanted: string, taken: Set<string>): string {
  const base = wanted.trim() || "Ejemplo";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${randomUUID().slice(0, 8)}`;
}

/**
 * El nombre que se pone solo cuando nadie escribe uno.
 *
 * El código de estado y no «Ejemplo 1», porque es lo que alguien busca en la lista: se guardan
 * ejemplos precisamente para tener el 200, el 404 y el 422 al lado.
 */
export function defaultExampleName(status: number): string {
  const label: Record<number, string> = {
    200: "200 correcto",
    201: "201 creado",
    204: "204 sin contenido",
    400: "400 petición inválida",
    401: "401 sin autenticar",
    403: "403 sin permiso",
    404: "404 no encontrado",
    409: "409 conflicto",
    422: "422 no procesable",
    429: "429 demasiadas peticiones",
    500: "500 error del servidor",
  };
  return label[status] ?? `${status}`;
}

export function blankExample(fields: {
  projectId: string;
  endpointId: string;
  name: string;
  request: ExampleRequest;
  response: ExampleResponse;
  origin: ExampleOrigin;
  orderIndex: number;
  now: Date;
  actorId: string;
}): EndpointExample {
  return {
    id: randomUUID(),
    projectId: fields.projectId,
    endpointId: fields.endpointId,
    name: fields.name,
    request: fields.request,
    response: fields.response,
    origin: fields.origin,
    orderIndex: fields.orderIndex,
    createdAt: fields.now,
    updatedAt: fields.now,
    createdBy: fields.actorId,
  };
}

/** El ejemplo como sale de la API: sin el proyecto, que ya está en la URL. */
export type ExampleView = Omit<EndpointExample, "projectId" | "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
};

export function viewExample(example: EndpointExample): ExampleView {
  const { projectId: _projectId, ...rest } = example;
  return {
    ...rest,
    createdAt: example.createdAt.toISOString(),
    updatedAt: example.updatedAt.toISOString(),
    sizeBytes: Buffer.byteLength(example.response.body, "utf8"),
  };
}
