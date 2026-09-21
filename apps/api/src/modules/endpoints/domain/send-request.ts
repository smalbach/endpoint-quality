/**
 * «Send» in the endpoint editor: what is on screen, turned into bytes for the target.
 *
 * Pure on purpose. The handler owns the I/O — the environment, the project's credential, the
 * network — and everything that decides what goes on the wire lives here, where a quoted space or a
 * multipart boundary is a test and not a debugging session.
 *
 * What the analyzer's `/test` did differently, and why this does not copy it:
 *
 * - **The body type is honoured.** There, a urlencoded body was never sent and «none» still sent
 *   the text. Here each mode sends what it says and nothing else.
 * - **A variable nobody defined stops the request.** There, `{{userId}}` travelled to the target as
 *   literal text and came back as a 400 about a value the person never meant to send.
 * - **The request goes through the SSRF guard**, like every other address a customer types.
 */
import { graphqlBody, isAuthType, parseGraphqlVariables, type RequestAuth } from "@eq/runner-core";

import { BODY_MODES, MAX_AUTH_PARAM, MAX_SCRIPT, type EndpointBody, type EndpointHeader, type EndpointMethod } from "./model";

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const BLOCKED_EXTENSIONS = [".exe", ".bat", ".sh", ".cmd", ".ps1", ".msi", ".dll"];

/** A file as multer hands it over, memory storage. */
export type UploadedPart = { fieldname: string; originalname: string; mimetype: string; size: number; buffer: Buffer };

/** The part name a file travels under: `file:<field>` for a form-data field, `binary` for the body. */
export const filePartName = (field: string): string => `file:${field}`;
export const BINARY_PART = "binary";

/**
 * Los modos que aceptaba el botón de enviar antes de que existieran los demás.
 *
 * Se siguen leyendo porque un cliente que no se haya recargado los manda: `{mode:"bearer",token}`
 * se traduce a `{type:"bearer",params:{token}}` y sigue funcionando. Los tipos nuevos llegan ya con
 * la forma de `RequestAuth`.
 */
export const SEND_AUTH_MODES = ["inherit", "none", "bearer"] as const;
export type SendAuthMode = (typeof SEND_AUTH_MODES)[number];

export type SendInput = {
  environmentId: string | null;
  method: EndpointMethod;
  path: string;
  pathParameters: { name: string; value: string }[];
  query: { name: string; value: string; enabled: boolean }[];
  headers: EndpointHeader[];
  body: EndpointBody;
  /** Cómo entra: los mismos tipos que Postman. `inherit` usa la cadena del proyecto. */
  auth: RequestAuth;
  /** What is in the editor, saved or not: «Enviar» runs the scripts on screen. */
  preRequestScript: string;
  postResponseScript: string;
  /**
   * Los valores con los que entra la petición, y que `pm.variables` —y `pm.collectionVariables`,
   * que es el mismo almacén— lee.
   *
   * Vacío cuando quien envía es el editor: una petición suelta empieza sin nada escrito. Lo llena
   * el runner de una colección, que es lo que hace que el `chk_product_a` que guardó el `Setup` lo
   * lea el filtro que viene después: sin esto cada petición de la corrida empezaría en blanco y la
   * mitad de una colección de verdad no tendría con qué correr.
   */
  variables: Record<string, string>;
};

type Problem = { field: string; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/**
 * El bloque de autenticación, en su forma nueva o en la vieja.
 *
 * La vieja es `{mode, token}` y llega de un navegador que no se ha recargado. Traducirla cuesta
 * tres líneas y evita que enviar una petición falle mientras alguien tiene la pestaña abierta.
 */
function readAuth(value: unknown): { auth: RequestAuth } | { problem: Problem } {
  const block = isRecord(value) ? value : {};
  const mode = text(block.mode);
  if (mode) {
    if (!(SEND_AUTH_MODES as readonly string[]).includes(mode))
      return { problem: { field: "auth.mode", detail: "inherit, none o bearer" } };
    return { auth: { type: mode as SendAuthMode, params: { token: text(block.token) } } };
  }
  const type = text(block.type) || "inherit";
  if (!isAuthType(type)) return { problem: { field: "auth.type", detail: "Tipo de autenticación no válido" } };
  const params: Record<string, string> = {};
  const given = isRecord(block.params) ? block.params : {};
  for (const [key, item] of Object.entries(given)) {
    const asText = text(item);
    if (asText.length > MAX_AUTH_PARAM) return { problem: { field: `auth.params.${key}`, detail: "Demasiado largo" } };
    params[key] = asText;
  }
  return { auth: { type, params } };
}

/**
 * The `request` part of the multipart form, read without trusting it.
 *
 * It arrives as a JSON string next to the files, so the validation pipe never sees it as an object;
 * this is that validation, written out.
 */
export function readSendInput(raw: string | undefined): { input: SendInput } | { problems: Problem[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "");
  } catch {
    return { problems: [{ field: "request", detail: "Tiene que ser JSON" }] };
  }
  if (!isRecord(value)) return { problems: [{ field: "request", detail: "Tiene que ser un objeto JSON" }] };

  const problems: Problem[] = [];
  const method = text(value.method).toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method))
    problems.push({ field: "method", detail: "Método no válido" });
  const path = text(value.path).trim();
  if (!path.startsWith("/") && !/^https?:\/\//i.test(path) && !path.startsWith("{{"))
    problems.push({ field: "path", detail: "Una ruta que empiece por / o una URL http(s)" });

  const body = isRecord(value.body) ? value.body : {};
  const mode = text(body.mode) || "none";
  if (!(BODY_MODES as readonly string[]).includes(mode))
    problems.push({ field: "body.mode", detail: "Tipo de cuerpo no válido" });

  const authRead = readAuth(value.auth);
  if ("problem" in authRead) problems.push(authRead.problem);

  const headers = rows(value.headers).map((row) => ({
    name: text(row.name).trim(),
    value: text(row.value),
    enabled: row.enabled !== false,
  }));
  headers.forEach((header, index) => {
    if (header.enabled && /[\r\n]/.test(header.value))
      problems.push({ field: `headers.${index}.value`, detail: "Una cabecera no lleva saltos de línea" });
  });

  for (const field of ["preRequestScript", "postResponseScript"] as const) {
    if (text(value[field]).length > MAX_SCRIPT) problems.push({ field, detail: `Como mucho ${MAX_SCRIPT} caracteres` });
  }

  // A problem with the auth block is already in `problems`; the second test only narrows the type.
  if (problems.length || !("auth" in authRead)) return { problems };
  return {
    input: {
      environmentId: text(value.environmentId) || null,
      method: method as EndpointMethod,
      path,
      pathParameters: rows(value.pathParameters).map((row) => ({ name: text(row.name), value: text(row.value) })),
      query: rows(value.query).map((row) => ({
        name: text(row.name).trim(),
        value: text(row.value),
        enabled: row.enabled !== false,
      })),
      headers,
      body: {
        mode: mode as EndpointBody["mode"],
        text: text(body.text),
        contentType: text(body.contentType) || "text/plain",
        fields: rows(body.fields).map((row) => ({
          name: text(row.name).trim(),
          value: text(row.value),
          kind: row.kind === "file" ? "file" : "text",
          enabled: row.enabled !== false,
        })),
        variables: text(body.variables),
      },
      auth: authRead.auth,
      preRequestScript: text(value.preRequestScript),
      postResponseScript: text(value.postResponseScript),
      variables: readVariables(value.variables),
    },
  };
}

/** Las variables que entran, solo cadenas: lo que no lo sea no es un valor que pueda ir a una URL. */
function readVariables(value: unknown): Record<string, string> {
  const given = isRecord(value) ? value : {};
  const variables: Record<string, string> = {};
  for (const [name, item] of Object.entries(given)) if (typeof item === "string") variables[name] = item;
  return variables;
}

/** The first file whose extension is refused, as a message; `null` when all of them are fine. */
export function blockedUpload(files: UploadedPart[]): string | null {
  for (const file of files) {
    const name = file.originalname.toLowerCase();
    const blocked = BLOCKED_EXTENSIONS.find((extension) => name.endsWith(extension));
    if (blocked) return `No se admiten ficheros ${blocked}: ${file.originalname}`;
  }
  return null;
}

/**
 * The URL, with `{name}` placeholders filled and the enabled query rows appended.
 *
 * A path that is already absolute ignores the base, which is how a request to a different host is
 * written. Placeholders are encoded as values; `{{variables}}` were substituted before this runs.
 */
export function buildUrl(
  base: string,
  path: string,
  pathParameters: { name: string; value: string }[],
  query: { name: string; value: string; enabled: boolean }[],
): string {
  const filled = path.replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (token, name: string) => {
    const value = pathParameters.find((parameter) => parameter.name === name)?.value;
    return value ? encodeURIComponent(value) : token;
  });
  const absolute = /^https?:\/\//i.test(filled) ? filled : `${base.replace(/\/+$/, "")}${filled}`;
  const search = new URLSearchParams();
  for (const row of query) if (row.enabled && row.name) search.append(row.name, row.value);
  if (!search.size) return absolute;
  return `${absolute}${absolute.includes("?") ? "&" : "?"}${search.toString()}`;
}

/**
 * Una operación GraphQL mandada por `GET`: `query`, `variables` (JSON) y `operationName` en la
 * query de la URL, como dice GraphQL sobre HTTP. `payload` es el cuerpo que {@link serializeBody}
 * ya escribió, así que las dos formas mandan exactamente la misma operación.
 */
export function graphqlOverGet(url: string, payload: string): string {
  const operation = JSON.parse(payload) as { query: string; variables?: unknown; operationName?: string };
  const search = new URLSearchParams({ query: operation.query });
  if (operation.variables !== undefined) search.set("variables", JSON.stringify(operation.variables));
  if (operation.operationName) search.set("operationName", operation.operationName);
  return `${url}${url.includes("?") ? "&" : "?"}${search.toString()}`;
}

/**
 * Placeholders a path still has after filling, so the person is told instead of the target. A URL's
 * pathname always percent-encodes the braces, so `%7B...%7D` is the only shape they can have there.
 */
export const unfilledPlaceholders = (url: string): string[] =>
  [...new URL(url, "http://placeholder").pathname.matchAll(/%7B([^%]+)%7D/gi)].map((match) => match[1]);

export type SerializedPayload = { contentType: string | null; payload: string | Uint8Array; preview: string };

/** Why a body could not be written: its 422, with the message and the code the handler throws. */
export type BodyFailure = { ok: false; problem: Problem; message: string; code: string };

/**
 * The body as it goes on the wire, or `null` for none.
 *
 * `interpolate` is applied to every piece of text before it is encoded, never after: substituting
 * into an already-encoded form would put a raw `&` into it.
 */
export function serializeBody(
  body: EndpointBody,
  files: UploadedPart[],
  interpolate: (value: string) => string,
): { ok: true; value: SerializedPayload | null } | BodyFailure {
  const missingFile = (problem: Problem): BodyFailure => ({ ok: false, problem, message: "Falta un fichero", code: "file-missing" });
  switch (body.mode) {
    case "none":
      return { ok: true, value: null };
    case "json": {
      const textBody = interpolate(body.text);
      return { ok: true, value: { contentType: "application/json", payload: textBody, preview: textBody } };
    }
    case "raw": {
      const textBody = interpolate(body.text);
      return {
        ok: true,
        value: { contentType: body.contentType || "text/plain", payload: textBody, preview: textBody },
      };
    }
    case "x-www-form-urlencoded": {
      const search = new URLSearchParams();
      for (const field of body.fields)
        if (field.enabled && field.name && field.kind === "text") search.append(field.name, interpolate(field.value));
      const encoded = search.toString();
      return {
        ok: true,
        value: { contentType: "application/x-www-form-urlencoded", payload: encoded, preview: encoded },
      };
    }
    case "binary": {
      const file = files.find((part) => part.fieldname === BINARY_PART);
      if (!file) return missingFile({ field: "body", detail: "Elige el fichero que se envía como cuerpo" });
      return {
        ok: true,
        value: {
          contentType: file.mimetype || "application/octet-stream",
          payload: new Uint8Array(file.buffer),
          preview: `<${file.originalname}, ${file.size} bytes>`,
        },
      };
    }
    case "graphql": {
      // La operación se sustituye como texto y las variables se sustituyen **y después** se leen:
      // `{"first": {{count}}}` solo es JSON con el número dentro, y un valor con una comilla puede
      // romperlo, que se dice aquí y no como un 400 del servidor sobre un cuerpo que nadie escribió.
      const query = interpolate(body.text);
      if (!query.trim())
        return {
          ok: false,
          problem: { field: "body.text", detail: "Escribe la operación GraphQL" },
          message: "Falta la operación GraphQL",
          code: "graphql-query-missing",
        };
      const filled = interpolate(body.variables ?? "");
      // Una `{{variable}}` sin valor no es «JSON roto»: la nombra quien comprueba las variables
      // después, con el entorno en la frase. Se devuelve tal cual para que llegue hasta allí.
      if (/\{\{[^{}]+\}\}/.test(filled))
        return { ok: true, value: { contentType: "application/json", payload: filled, preview: `${query}\n${filled}` } };
      const variables = parseGraphqlVariables(filled);
      if (!variables.ok)
        return {
          ok: false,
          problem: { field: "body.variables", detail: variables.problem },
          message: "Las variables de GraphQL no son válidas",
          code: "graphql-variables-invalid",
        };
      const textBody = graphqlBody({ query, variables: variables.value });
      return { ok: true, value: { contentType: "application/json", payload: textBody, preview: textBody } };
    }
    case "form-data": {
      const parts: MultipartPart[] = [];
      for (const field of body.fields) {
        if (!field.enabled || !field.name) continue;
        if (field.kind === "text") {
          parts.push({ name: field.name, data: Buffer.from(interpolate(field.value), "utf8") });
          continue;
        }
        const file = files.find((part) => part.fieldname === filePartName(field.name));
        if (!file) return missingFile({ field: `body.fields.${field.name}`, detail: `Elige el fichero de «${field.name}»` });
        parts.push({ name: field.name, data: file.buffer, filename: file.originalname, contentType: file.mimetype });
      }
      const encoded = multipart(parts);
      return {
        ok: true,
        value: {
          contentType: `multipart/form-data; boundary=${encoded.boundary}`,
          payload: encoded.bytes,
          preview: parts
            .map((part) =>
              part.filename ? `${part.name}=@${part.filename}` : `${part.name}=${part.data.toString("utf8")}`,
            )
            .join("\n"),
        },
      };
    }
  }
}

type MultipartPart = { name: string; data: Buffer; filename?: string; contentType?: string };

const quoted = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ");

/** RFC 7578, by hand: a file is bytes, and the text serializer in `runner-core` only has text. */
export function multipart(parts: MultipartPart[]): { boundary: string; bytes: Uint8Array } {
  let boundary = "----EndpointQualityFormBoundary";
  while (parts.some((part) => part.data.includes(boundary))) boundary += "-";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${quoted(part.name)}"${part.filename === undefined ? "" : `; filename="${quoted(part.filename)}"`}`;
    const type =
      part.filename === undefined ? "" : `Content-Type: ${part.contentType || "application/octet-stream"}\r\n`;
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`, "utf8"),
      part.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { boundary, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

const SECRET_HEADER = /authorization|api[-_]?key|token|secret|cookie/i;

/** What is echoed back as «the request that was sent»: the credential never is. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, SECRET_HEADER.test(name) ? "••••••••" : value]),
  );
}

/** Where a login response usually keeps its token, tried in order when the project names no path. */
export const TOKEN_PATHS = [
  "token",
  "access_token",
  "accessToken",
  "data.token",
  "data.accessToken",
  "data.access_token",
  "jwt",
];
