/**
 * An endpoint as the editor holds it, and the three things it becomes: what is saved, what is
 * sent, and the cURL somebody pastes into a ticket.
 *
 * Kept out of the component because each of these has an edge that is invisible until a target
 * rejects it — a blank row, a file field with no file, a sensitive variable that must not end up in
 * a copied command — and all of them are assertions, not renders.
 */
import { shellQuote } from "@/lib/curl";
import { parseTags } from "@/lib/project-auth";
import type {
  EndpointBodyView,
  EndpointMethod,
  EndpointPathParameterView,
  EndpointQueryParameterView,
  EndpointHeaderView,
  EndpointStatus,
  EndpointView,
  Environment,
  RequestAuthView,
} from "@/lib/types";

export const METHODS: EndpointMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export const BLOCKED_EXTENSIONS = [".exe", ".bat", ".sh", ".cmd", ".ps1", ".msi", ".dll"];
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type EndpointDraft = {
  method: EndpointMethod;
  path: string;
  description: string;
  pathParameters: EndpointPathParameterView[];
  query: EndpointQueryParameterView[];
  headers: EndpointHeaderView[];
  body: EndpointBodyView;
  requiresAuth: boolean;
  /** Cómo entra: se guarda con el endpoint, como Postman guarda el auth con la petición. */
  auth: RequestAuthView;
  /** As typed: comma separated. */
  tags: string;
  status: EndpointStatus;
  preRequestScript: string;
  postResponseScript: string;
};

export const EMPTY_BODY: EndpointBodyView = { mode: "none", text: "", contentType: "text/plain", fields: [] };
export const INHERIT_AUTH: RequestAuthView = { type: "inherit", params: {} };

/** Los parámetros que van a la fila. Los secretos son los que el servidor vacía al guardar. */
const SECRET_PARAMS = new Set([
  "password",
  "secret",
  "secretKey",
  "clientSecret",
  "consumerSecret",
  "tokenSecret",
  "authKey",
  "token",
  "accessToken",
  "apiKey",
  "value",
  "privateKey",
]);

/**
 * Lo que se guarda de la autenticación.
 *
 * Un campo de texto en blanco no se guarda. Un **secreto** vacío sí: ese vacío dice que la
 * credencial existe y que su valor no está aquí, que es lo que hace que el fichero exportado
 * enseñe qué falta en vez de una petición que parece no necesitar nada. La misma regla vive en el
 * servidor, que es quien decide de verdad; esta es para que la pantalla no se contradiga con él.
 */
export function storableParams(auth: RequestAuthView): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.params)) {
    const secret = SECRET_PARAMS.has(key) && (key !== "value" || auth.type === "apikey");
    if (value !== "" || secret) params[key] = value;
  }
  return params;
}

export const NEW_ENDPOINT: EndpointDraft = {
  method: "GET",
  path: "/",
  description: "",
  pathParameters: [],
  query: [],
  headers: [],
  body: EMPTY_BODY,
  requiresAuth: false,
  auth: INHERIT_AUTH,
  tags: "",
  status: "active",
  preRequestScript: "",
  postResponseScript: "",
};

export function draftFrom(view: EndpointView): EndpointDraft {
  return {
    method: view.method,
    path: view.path,
    description: view.description,
    pathParameters: view.pathParameters,
    query: view.query,
    headers: view.headers,
    body: view.body,
    requiresAuth: view.requiresAuth,
    auth: view.auth ?? INHERIT_AUTH,
    tags: view.tags.join(", "),
    status: view.status,
    preRequestScript: view.preRequestScript,
    postResponseScript: view.postResponseScript,
  };
}

/** `{name}` placeholders, in order. `{{variables}}` are not parameters. */
export function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)].map((match) => match[1]);
}

/** A new path, with its parameter rows following it and keeping the values already typed. */
export function withPath(draft: EndpointDraft, path: string): EndpointDraft {
  // `:id` is how most people type a parameter; the list follows it before the API normalizes it.
  const names = pathParameterNames(path.replace(/\/:([A-Za-z_][\w-]*)/g, "/{$1}"));
  return {
    ...draft,
    path,
    pathParameters: names.map(
      (name) =>
        draft.pathParameters.find((parameter) => parameter.name === name) ?? {
          name,
          type: /uuid/i.test(name) ? "uuid" : "string",
          description: "",
          value: "",
        },
    ),
  };
}

/** What goes to POST / PATCH. Blank rows are a row being typed, not a parameter. */
export function savePayload(draft: EndpointDraft) {
  const named = <T extends { name: string }>(rows: T[]) => rows.filter((row) => row.name.trim());
  return {
    method: draft.method,
    path: draft.path.trim(),
    description: draft.description,
    pathParameters: draft.pathParameters,
    query: named(draft.query),
    headers: named(draft.headers),
    body: {
      ...draft.body,
      fields: named(draft.body.fields).map((field) => (field.kind === "file" ? { ...field, value: "" } : field)),
    },
    requiresAuth: draft.requiresAuth,
    auth: { type: draft.auth.type, params: storableParams(draft.auth) },
    tags: parseTags(draft.tags),
    status: draft.status,
    preRequestScript: draft.preRequestScript,
    postResponseScript: draft.postResponseScript,
  };
}

export function isDirty(draft: EndpointDraft, saved: EndpointDraft | null): boolean {
  if (!saved) return true;
  return JSON.stringify(savePayload(draft)) !== JSON.stringify(savePayload(saved));
}

/** Lo que el botón de enviar manda. Es el del borrador: se guarda con el endpoint. */
export type SendAuth = RequestAuthView;

/** The files chosen for this request, which never reach the saved row. */
export type ChosenFiles = { fields: Record<string, File>; binary: File | null };
export const NO_FILES: ChosenFiles = { fields: {}, binary: null };

/** Why a file cannot go, said before the upload rather than after it. */
export function fileProblem(file: File): string | null {
  const name = file.name.toLowerCase();
  const blocked = BLOCKED_EXTENSIONS.find((extension) => name.endsWith(extension));
  if (blocked) return `No se admiten ficheros ${blocked}`;
  if (file.size > MAX_FILE_BYTES) return "Como mucho 10 MB por fichero";
  return null;
}

/** The files the body needs and does not have. */
export function missingFiles(body: EndpointBodyView, files: ChosenFiles): string[] {
  if (body.mode === "binary") return files.binary ? [] : ["cuerpo binario"];
  if (body.mode !== "form-data") return [];
  return body.fields
    .filter((field) => field.enabled && field.kind === "file" && field.name.trim() && !files.fields[field.name.trim()])
    .map((field) => field.name.trim());
}

/** The multipart form «Send» posts: the request as JSON, and one part per file. */
export function sendForm(draft: EndpointDraft, environmentId: string | null, files: ChosenFiles): FormData {
  const payload = savePayload(draft);
  const form = new FormData();
  form.append(
    "request",
    JSON.stringify({
      environmentId,
      method: payload.method,
      path: payload.path,
      pathParameters: payload.pathParameters.map(({ name, value }) => ({ name, value })),
      query: payload.query,
      headers: payload.headers,
      body: payload.body,
      auth: payload.auth,
      preRequestScript: payload.preRequestScript,
      postResponseScript: payload.postResponseScript,
    }),
  );
  if (payload.body.mode === "form-data") {
    for (const field of payload.body.fields) {
      const file = field.kind === "file" && field.enabled ? files.fields[field.name] : undefined;
      if (file) form.append(`file:${field.name}`, file, file.name);
    }
  }
  if (payload.body.mode === "binary" && files.binary) form.append("binary", files.binary, files.binary.name);
  return form;
}

export type ResolvedVariable = { value: string; sensitive: boolean };

/** The variables of an environment as a run would substitute them: enabled ones, current over initial. */
export function variablesOf(environment: Environment | null | undefined): Record<string, ResolvedVariable> {
  if (!environment) return {};
  return Object.fromEntries(
    Object.entries(environment.variables).map(([name, variable]) => [
      name,
      { value: variable.current || variable.initial, sensitive: variable.sensitive },
    ]),
  );
}

export type PathPart = { text: string; kind: "literal" | "known" | "unknown" | "secret" };

/** The path split around its `{{variables}}`, for the «Resuelta:» line under the input. */
export function resolvedParts(path: string, variables: Record<string, ResolvedVariable>): PathPart[] {
  const parts: PathPart[] = [];
  let last = 0;
  for (const match of path.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
    if (match.index > last) parts.push({ text: path.slice(last, match.index), kind: "literal" });
    const variable = variables[match[1]] ?? variables[match[1].replace(/^env\./, "")];
    if (!variable) parts.push({ text: match[0], kind: "unknown" });
    else if (variable.sensitive) parts.push({ text: "••••", kind: "secret" });
    else parts.push({ text: variable.value, kind: "known" });
    last = match.index + match[0].length;
  }
  if (last < path.length) parts.push({ text: path.slice(last), kind: "literal" });
  return parts;
}

/**
 * The request as a `curl`.
 *
 * Non-sensitive variables are substituted, so the command runs as it is; a sensitive one stays as
 * `{{name}}`, because a command copied into a ticket is exactly where a token must not travel.
 */
/**
 * La autenticación como la escribiría `curl`, y lo que `curl` no puede escribir.
 *
 * `curl` sabe hacer Basic, Bearer, una clave en una cabecera y Digest —ese con `--digest`, que
 * negocia el 401 él mismo—. Una firma de AWS o de Hawk no: se calculan sobre la petición y el
 * comando no las lleva. Poner la cabecera sin firmar daría un comando que falla sin decir por qué,
 * así que sale un comentario que dice qué le falta.
 */
function curlAuth(
  auth: RequestAuthView,
  hasAuthorization: boolean,
  substitute: (text: string) => string,
): string[] {
  if (hasAuthorization || auth.type === "inherit" || auth.type === "none") return [];
  const of = (name: string) => substitute(auth.params[name] ?? "");
  switch (auth.type) {
    case "bearer":
      return of("token") ? [`  -H ${shellQuote(`Authorization: Bearer ${of("token")}`)}`] : [];
    case "basic":
      return [`  -u ${shellQuote(`${of("username")}:${of("password")}`)}`];
    case "digest":
      return [`  --digest -u ${shellQuote(`${of("username")}:${of("password")}`)}`];
    case "apikey":
      return of("key")
        ? [
            (auth.params.in ?? "header") === "query"
              ? `  --url-query ${shellQuote(`${of("key")}=${of("value")}`)}`
              : `  -H ${shellQuote(`${of("key")}: ${of("value")}`)}`,
          ]
        : [];
    case "oauth2":
    case "jwt":
      return of("accessToken") || of("token")
        ? [`  -H ${shellQuote(`Authorization: Bearer ${of("accessToken") || of("token")}`)}`]
        : [`  # falta el token de ${auth.type === "jwt" ? "JWT" : "OAuth 2.0"}`];
    default:
      return [`  # ${auth.type}: la firma se calcula sobre la petición y curl no la lleva`];
  }
}

export function endpointCurl(
  draft: EndpointDraft,
  context: { baseUrl: string; variables: Record<string, ResolvedVariable>; files: ChosenFiles },
): string {
  const substitute = (text: string) =>
    text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (token, name: string) => {
      const variable = context.variables[name] ?? context.variables[name.replace(/^env\./, "")];
      return variable && !variable.sensitive ? variable.value : token;
    });

  const payload = savePayload(draft);
  let path = substitute(payload.path);
  for (const parameter of payload.pathParameters) {
    if (parameter.value) path = path.replace(`{${parameter.name}}`, encodeURIComponent(substitute(parameter.value)));
  }
  const base = substitute(context.baseUrl || "{{baseUrl}}").replace(/\/+$/, "");
  const query = new URLSearchParams();
  for (const row of payload.query) if (row.enabled) query.append(row.name, substitute(row.value));
  const url = `${/^https?:\/\//i.test(path) ? "" : base}${path}${query.size ? `?${query.toString()}` : ""}`;

  const lines = [`curl ${payload.method === "GET" ? "" : `-X ${payload.method} `}${shellQuote(url)}`];
  const headers = payload.headers.filter((header) => header.enabled);
  for (const header of headers) lines.push(`  -H ${shellQuote(`${header.name}: ${substitute(header.value)}`)}`);
  const hasHeader = (name: string) => headers.some((header) => header.name.toLowerCase() === name);
  lines.push(...curlAuth(payload.auth, hasHeader("authorization"), substitute));

  const body = payload.body;
  if (body.mode === "json" || body.mode === "raw") {
    if (!hasHeader("content-type"))
      lines.push(`  -H ${shellQuote(`Content-Type: ${body.mode === "json" ? "application/json" : body.contentType}`)}`);
    lines.push(`  --data ${shellQuote(substitute(body.text))}`);
  } else if (body.mode === "x-www-form-urlencoded") {
    for (const field of body.fields)
      if (field.enabled && field.kind === "text")
        lines.push(`  --data-urlencode ${shellQuote(`${field.name}=${substitute(field.value)}`)}`);
  } else if (body.mode === "form-data") {
    for (const field of body.fields) {
      if (!field.enabled) continue;
      const value =
        field.kind === "file" ? `@${context.files.fields[field.name]?.name ?? "fichero"}` : substitute(field.value);
      lines.push(`  -F ${shellQuote(`${field.name}=${value}`)}`);
    }
  } else if (body.mode === "binary") {
    lines.push(`  --data-binary ${shellQuote(`@${context.files.binary?.name ?? "fichero"}`)}`);
  }
  return lines.join(" \\\n");
}

/** A response body as something readable: indented when it is JSON, as it came otherwise. */
export function prettyBody(text: string): { text: string; json: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
}
