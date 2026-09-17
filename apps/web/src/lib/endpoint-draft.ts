/**
 * An endpoint as the editor holds it, and the three things it becomes: what is saved, what is
 * sent, and the cURL somebody pastes into a ticket.
 *
 * Kept out of the component because each of these has an edge that is invisible until a target
 * rejects it — a blank row, a file field with no file, a sensitive variable that must not end up in
 * a copied command — and all of them are assertions, not renders.
 */
import { parseTags } from "@/lib/project-auth";
import type { SnippetBody, SnippetRequest } from "@/lib/snippets";
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
 * La petición del editor, resuelta y sin lenguaje: lo que los generadores de código escriben.
 *
 * Esto es lo que antes hacía el `curl` para él solo. Sacarlo aparte es lo que permite que haya
 * dieciséis lenguajes y **un** sitio donde se resuelve la petición: sustituir variables, meter los
 * parámetros en la ruta, montar la cadena de consulta y decidir qué cuerpo va. Si eso viviera
 * dentro de cada generador habría dieciséis sitios donde equivocarse distinto, y quince de ellos
 * sin una prueba que lo mire.
 *
 * Las variables no sensibles se sustituyen, así que el fragmento corre tal cual; una sensible se
 * queda como `{{nombre}}`, porque un fragmento de código se pega en un ticket y es exactamente
 * donde un token no debe viajar.
 */
export function snapshotRequest(
  draft: EndpointDraft,
  context: { baseUrl: string; variables: Record<string, ResolvedVariable>; files: ChosenFiles },
): SnippetRequest {
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

  const source = payload.body;
  const enabled = source.fields.filter((field) => field.enabled);
  let body: SnippetBody = { kind: "none" };
  if (source.mode === "json" || source.mode === "raw") {
    body = {
      kind: "text",
      text: substitute(source.text),
      contentType: source.contentType,
      json: source.mode === "json",
    };
  } else if (source.mode === "x-www-form-urlencoded") {
    body = {
      kind: "form",
      fields: enabled
        .filter((field) => field.kind === "text")
        .map((field) => ({ name: field.name, value: substitute(field.value) })),
    };
  } else if (source.mode === "form-data") {
    body = {
      kind: "multipart",
      fields: enabled.map((field) => ({
        name: field.name,
        // Un campo de fichero sale con el nombre del fichero elegido: el contenido no cabe en un
        // fragmento de código, y quien lo pegue tiene el fichero en su disco, no aquí.
        value: field.kind === "file" ? (context.files.fields[field.name]?.name ?? "fichero") : substitute(field.value),
        file: field.kind === "file",
      })),
    };
  } else if (source.mode === "binary") {
    body = { kind: "binary", filename: context.files.binary?.name ?? "fichero" };
  }

  return {
    method: payload.method,
    url,
    headers: payload.headers
      .filter((header) => header.enabled)
      .map((header) => ({ name: header.name, value: substitute(header.value) })),
    body,
    auth: {
      type: payload.auth.type,
      params: Object.fromEntries(
        Object.entries(payload.auth.params).map(([name, value]) => [name, substitute(value)]),
      ),
    },
  };
}

/** A response body as something readable: indented when it is JSON, as it came otherwise. */
export function prettyBody(text: string): { text: string; json: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
}
