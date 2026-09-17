/**
 * A file somebody already has, read as endpoints.
 *
 * The four formats the analyzer accepts: an OpenAPI document, a Postman collection, an Insomnia
 * export, and a markdown (or plain text) full of `curl` commands. The readers of the last three are
 * the ones the saved requests already use — one parser per format in the product, not two that
 * disagree about a quoted space.
 *
 * Unlike a saved request, an endpoint does **not** have to land on an operation of the contract:
 * making endpoints out of what a team has is the point. What this does refuse is a second copy — a
 * method and path the project already has, or that appears twice in the same file, is reported as
 * skipped with its reason instead of silently doubling the list.
 */
import { importSpec, type ImportedOperation } from "@eq/spec-import";
import { exampleFromSchema, type RequestBody } from "@eq/runner-core";

import {
  parseCurl,
  parseCurlDocument,
  parseHar,
  parseInsomniaExport,
  parsePostmanCollection,
  pathOf,
  queryOf,
  type ParsedRequest,
  type PostmanExample,
} from "@/modules/workflows/domain/import-requests";
import { importableHeaders } from "@/modules/workflows/application/commands/import-request-templates";
import {
  MAX_EXAMPLES_PER_ENDPOINT,
  blankExample,
  defaultExampleName,
  exampleProblems,
  redactExample,
  uniqueExampleName,
  type EndpointExample,
  type ExampleRequest,
  type ExampleResponse,
} from "./examples";
import {
  EMPTY_BODY,
  ENDPOINT_METHODS,
  normalizePath,
  reconcilePathParameters,
  type EndpointBody,
  type EndpointInput,
  type EndpointMethod,
  INHERIT_AUTH,
} from "./model";

export const IMPORT_FILE_FORMATS = ["openapi", "postman", "insomnia", "har", "markdown"] as const;
export type ImportFileFormat = (typeof IMPORT_FILE_FORMATS)[number];

/** An endpoint as read, before it belongs to a project. */
export type EndpointDraft = EndpointInput & {
  method: EndpointMethod;
  path: string;
  operationId: string | null;
  /**
   * Los ejemplos que el fichero guardaba para esta petición.
   *
   * Vienen con el borrador y no en un segundo viaje porque se guardan en la misma operación: un
   * endpoint importado con sus ejemplos a medias —el endpoint sí, los ejemplos no— sería un estado
   * que nadie puede ver ni arreglar.
   */
  examples?: PostmanExample[];
};

export type ImportSkip = { method: string; path: string; name: string; reason: string };

export type ParsedFile = { format: ImportFileFormat; drafts: EndpointDraft[]; skipped: ImportSkip[] };

/**
 * Which format a file is, from its name first and its content second.
 *
 * `null` when it is none of them — said as a 422 rather than guessed, because a JSON file that is
 * not a collection read as markdown finds nothing and reports an empty import as a success.
 */
export function detectFormat(filename: string, text: string): ImportFileFormat | null {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (extension === "yaml" || extension === "yml") return "openapi";
  if (extension === "md" || extension === "markdown" || extension === "txt") return "markdown";

  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
    const info = document.info as Record<string, unknown> | undefined;
    if (typeof info?.schema === "string" && info.schema.includes("postman")) return "postman";
    // Antes que el resto: la raíz de un HAR solo tiene `log`, así que no choca con nada, y su
    // `log.version` no es el `openapi`/`swagger` de un contrato.
    const log = document.log as Record<string, unknown> | undefined;
    if (log && Array.isArray(log.entries)) return "har";
    if (document._type === "export" || Array.isArray(document.resources)) return "insomnia";
    if (typeof document.openapi === "string" || typeof document.swagger === "string") return "openapi";
    return null;
  }
  if (/^(openapi|swagger)\s*:/m.test(trimmed)) return "openapi";
  if (/^\s*curl[\s\\]/m.test(trimmed)) return "markdown";
  return null;
}

export function parseEndpointFile(format: ImportFileFormat, text: string): ParsedFile {
  if (format === "openapi") return parseOpenApi(text);
  const read =
    format === "postman"
      ? parsePostmanCollection(text)
      : format === "insomnia"
        ? parseInsomniaExport(text)
        : format === "har"
          ? parseHar(text)
          : parseCurlDocument(text);
  const drafts: EndpointDraft[] = [];
  const skipped: ImportSkip[] = read.skipped.map((entry) => ({
    method: entry.method,
    path: entry.url ? pathOf(entry.url) : "",
    name: entry.name,
    reason: entry.reason,
  }));
  for (const request of read.requests) {
    const draft = draftFromRequest(request);
    if (typeof draft === "string")
      skipped.push({ method: request.method, path: pathOf(request.url), name: request.name, reason: draft });
    else drafts.push(draft);
  }
  // A markdown doc is not only a pile of `curl`: an API is as often written as a table of
  // «MÉTODO /ruta» or a list of `GET /users`. Those are read too, and merged with the curl ones,
  // deduped so a route documented both ways lands once.
  if (format === "markdown") {
    const seen = new Set(drafts.map((draft) => `${draft.method} ${draft.path}`));
    for (const draft of parseMarkdownRoutes(text)) {
      const key = `${draft.method} ${draft.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        drafts.push(draft);
      }
    }
  }
  return { format, drafts, skipped };
}

const METHOD = new RegExp(`^(${ENDPOINT_METHODS.join("|")})$`, "i");

/**
 * The `MÉTODO /ruta` pairs written into a markdown document, from tables and from lists alike.
 *
 * A table row reaches here as its cells; a list item as a line. In both, the method is one token and
 * the path is the next one that starts with `/`. NestJS's `:id` is rewritten to `{id}` so it matches
 * the way this product writes a path, and `normalizePath` settles the rest.
 */
export function parseMarkdownRoutes(text: string): EndpointDraft[] {
  const drafts: EndpointDraft[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    // A fenced code line is left to the curl reader; a table/list line is tokenised on pipes, spaces
    // and backticks, and the first method token paired with the next path token becomes a route.
    const tokens = rawLine.split(/[|`\s]+/).filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      if (!METHOD.test(tokens[index])) continue;
      const pathToken = tokens.slice(index + 1).find((token) => token.startsWith("/"));
      if (!pathToken) continue;
      const method = tokens[index].toUpperCase() as EndpointMethod;
      const path = normalizePath(pathToken.replace(/:([A-Za-z0-9_]+)/g, "{$1}"));
      const key = `${method} ${path}`;
      if (path.length > 1 && !seen.has(key)) {
        seen.add(key);
        drafts.push({ method, path, operationId: null, description: "" });
      }
      break;
    }
  }
  return drafts;
}

/** One `curl`, as an endpoint, or the reason it cannot be one. */
export function draftFromCurl(command: string): EndpointDraft | string {
  const request = parseCurl(command);
  if (!request) return "El comando no lleva ninguna URL";
  return draftFromRequest(request);
}

function draftFromRequest(request: ParsedRequest): EndpointDraft | string {
  const method = request.method.toUpperCase();
  if (!(ENDPOINT_METHODS as readonly string[]).includes(method)) return `El método ${method} no se admite`;
  const path = normalizePath(pathOf(request.url));
  const lowered = Object.keys(request.headers).map((name) => name.toLowerCase());
  return {
    method: method as EndpointMethod,
    path,
    // A cURL has no name; the one the reader derives is the method and path, which says nothing.
    description: request.name.startsWith(`${method} `) || request.name === "curl" ? "" : request.name,
    pathParameters: reconcilePathParameters(path, []),
    query: Object.entries(queryOf(request.url)).map(([name, value]) => ({
      name,
      type: "string",
      required: false,
      description: "",
      value,
      enabled: true,
    })),
    headers: Object.entries(importableHeaders(request.headers)).map(([name, value]) => ({
      name,
      value,
      enabled: true,
    })),
    body: bodyFrom(request.body),
    // The credential itself is dropped with the header; that the request carried one is kept.
    requiresAuth:
      lowered.some((name) => ["authorization", "x-api-key", "api-key", "apikey"].includes(name)) ||
      (request.auth.type !== "inherit" && request.auth.type !== "none"),
    // Cómo entra, leído del bloque `auth` del fichero. Sin secretos literales: los quitó el lector.
    auth: request.auth,
    operationId: null,
    examples: request.examples,
  };
}

function bodyFrom(body: RequestBody): EndpointBody {
  switch (body.type) {
    case "none":
      return EMPTY_BODY;
    case "json":
      return { ...EMPTY_BODY, mode: "json", text: JSON.stringify(body.json, null, 2), contentType: "application/json" };
    case "raw":
      return /json/i.test(body.contentType)
        ? { ...EMPTY_BODY, mode: "json", text: body.text, contentType: "application/json" }
        : { ...EMPTY_BODY, mode: "raw", text: body.text, contentType: body.contentType || "text/plain" };
    default: {
      const rows = (map: Record<string, string>, enabled: boolean) =>
        Object.entries(map).map(([name, value]) => ({ name, value, kind: "text" as const, enabled }));
      return {
        ...EMPTY_BODY,
        mode: body.type,
        fields: [...rows(body.fields, true), ...rows(body.disabledFields, false)],
      };
    }
  }
}

function parseOpenApi(text: string): ParsedFile {
  const parsed = importSpec(text);
  const errors = parsed.problems.filter((problem) => problem.severity === "error");
  if (errors.length && !parsed.operations.length) {
    return {
      format: "openapi",
      drafts: [],
      skipped: errors.map((problem) => ({ method: "", path: problem.pointer, name: "", reason: problem.message })),
    };
  }
  return {
    format: "openapi",
    drafts: parsed.operations.map((operation) => draftFromOperation(operation, false)),
    skipped: [],
  };
}

/**
 * An operation of an OpenAPI document as an endpoint.
 *
 * `linked` is whether the endpoint *is* that operation of the project's own contract (a contract
 * import) or merely came from a document somebody uploaded (a file import). Only the first keeps
 * the operation id.
 */
export function draftFromOperation(
  operation: Pick<
    ImportedOperation,
    "id" | "method" | "path" | "summary" | "tag" | "parameters" | "security" | "requestSchema"
  >,
  linked: boolean,
): EndpointDraft {
  const path = normalizePath(operation.path);
  const inPath = new Set(reconcilePathParameters(path, []).map((parameter) => parameter.name));
  const example = operation.requestSchema ? exampleFromSchema(operation.requestSchema) : undefined;
  return {
    method: operation.method.toUpperCase() as EndpointMethod,
    path,
    description: operation.summary,
    pathParameters: reconcilePathParameters(path, []),
    // Declared, and off: the contract says the parameter exists, not what to send in it, and an
    // enabled row with no value would send `?name=` on every request.
    query: operation.parameters
      .filter((name) => !inPath.has(name))
      .map((name) => ({ name, type: "string", required: false, description: "", value: "", enabled: false })),
    headers: [],
    body:
      example === undefined
        ? EMPTY_BODY
        : { ...EMPTY_BODY, mode: "json", text: JSON.stringify(example, null, 2), contentType: "application/json" },
    requiresAuth: operation.security.length > 0,
    // Un contrato dice que la operación necesita autenticación, no cuál de las suyas: eso lo
    // decide el proyecto, y por eso hereda.
    auth: INHERIT_AUTH,
    tags: operation.tag ? [operation.tag] : [],
    operationId: linked ? operation.id : null,
  };
}

/**
 * Los ejemplos de un fichero, como filas de este proyecto.
 *
 * La petición del ejemplo se resuelve aquí y no se deja para después: un ejemplo sin la petición que
 * lo produjo es media documentación, y cuando el fichero no trae `originalRequest` la que vale es
 * la de la petición actual, que es lo que Postman enseña.
 *
 * La redacción se aplica **al importar**, no solo al guardar a mano. Un fichero de Postman llega con
 * los tokens en claro —es lo que ese producto guarda— y entrar por el importador no puede ser la
 * puerta por la que un token se cuela en la base de datos.
 */
export function examplesFromFile(fields: {
  projectId: string;
  endpointId: string;
  draft: EndpointDraft;
  from: PostmanExample[];
  now: Date;
  actorId: string;
}): { examples: EndpointExample[]; redacted: string[] } {
  const examples: EndpointExample[] = [];
  const redacted = new Set<string>();
  const taken = new Set<string>();

  for (const [index, entry] of fields.from.slice(0, MAX_EXAMPLES_PER_ENDPOINT).entries()) {
    const own = entry.request;
    const request: ExampleRequest = {
      method: own?.method || fields.draft.method,
      url: own?.url || fields.draft.path,
      headers: Object.entries(own?.headers ?? {}).map(([name, value]) => ({ name, value, enabled: true })),
      body: { text: own?.body ?? "", contentType: own?.contentType ?? "application/json" },
    };
    const response: ExampleResponse = {
      status: entry.status,
      headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value, enabled: true })),
      body: entry.body,
      contentType: entry.contentType,
      // Un fichero no guarda cuánto tardó: cero, que se lee como «no se sabe» y no como «fue
      // instantáneo». Inventar un número sería afirmar algo sobre la API de alguien.
      durationMs: 0,
    };
    if (exampleProblems({ request, response }).length) continue;

    const clean = redactExample(request, response);
    for (const name of clean.redaction.droppedHeaders) redacted.add(name);
    for (const field of clean.redaction.maskedFields) redacted.add(field);

    const name = uniqueExampleName(entry.name.trim() || defaultExampleName(entry.status), taken);
    taken.add(name);
    examples.push(
      blankExample({
        projectId: fields.projectId,
        endpointId: fields.endpointId,
        name,
        request: clean.request,
        response: clean.response,
        origin: "import",
        orderIndex: index,
        now: fields.now,
        actorId: fields.actorId,
      }),
    );
  }
  return { examples, redacted: [...redacted] };
}
