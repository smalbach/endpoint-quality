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
import { BODY_MODES, type EndpointBody, type EndpointHeader, type EndpointMethod } from "./model";

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const BLOCKED_EXTENSIONS = [".exe", ".bat", ".sh", ".cmd", ".ps1", ".msi", ".dll"];

/** A file as multer hands it over, memory storage. */
export type UploadedPart = { fieldname: string; originalname: string; mimetype: string; size: number; buffer: Buffer };

/** The part name a file travels under: `file:<field>` for a form-data field, `binary` for the body. */
export const filePartName = (field: string): string => `file:${field}`;
export const BINARY_PART = "binary";

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
  auth: { mode: SendAuthMode; token: string };
};

type Problem = { field: string; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

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

  const auth = isRecord(value.auth) ? value.auth : {};
  const authMode = text(auth.mode) || "inherit";
  if (!(SEND_AUTH_MODES as readonly string[]).includes(authMode))
    problems.push({ field: "auth.mode", detail: "inherit, none o bearer" });

  const headers = rows(value.headers).map((row) => ({
    name: text(row.name).trim(),
    value: text(row.value),
    enabled: row.enabled !== false,
  }));
  headers.forEach((header, index) => {
    if (header.enabled && /[\r\n]/.test(header.value))
      problems.push({ field: `headers.${index}.value`, detail: "Una cabecera no lleva saltos de línea" });
  });

  if (problems.length) return { problems };
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
      },
      auth: { mode: authMode as SendAuthMode, token: text(auth.token) },
    },
  };
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

/** Placeholders a path still has after filling, so the person is told instead of the target. */
export const unfilledPlaceholders = (url: string): string[] =>
  [...new URL(url, "http://placeholder").pathname.matchAll(/%7B([^%]+)%7D|\{([^{}]+)\}/gi)].map(
    (match) => match[1] ?? match[2],
  );

export type SerializedPayload = { contentType: string | null; payload: string | Uint8Array; preview: string };

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
): { ok: true; value: SerializedPayload | null } | { ok: false; problem: Problem } {
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
      if (!file) return { ok: false, problem: { field: "body", detail: "Elige el fichero que se envía como cuerpo" } };
      return {
        ok: true,
        value: {
          contentType: file.mimetype || "application/octet-stream",
          payload: new Uint8Array(file.buffer),
          preview: `<${file.originalname}, ${file.size} bytes>`,
        },
      };
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
        if (!file)
          return {
            ok: false,
            problem: { field: `body.fields.${field.name}`, detail: `Elige el fichero de «${field.name}»` },
          };
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
