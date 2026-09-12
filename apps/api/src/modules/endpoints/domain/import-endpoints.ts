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
  parseInsomniaExport,
  parsePostmanCollection,
  pathOf,
  queryOf,
  type ParsedRequest,
} from "@/modules/workflows/domain/import-requests";
import { importableHeaders } from "@/modules/workflows/application/commands/import-request-templates";
import {
  EMPTY_BODY,
  ENDPOINT_METHODS,
  normalizePath,
  reconcilePathParameters,
  type EndpointBody,
  type EndpointInput,
  type EndpointMethod,
} from "./model";

export const IMPORT_FILE_FORMATS = ["openapi", "postman", "insomnia", "markdown"] as const;
export type ImportFileFormat = (typeof IMPORT_FILE_FORMATS)[number];

/** An endpoint as read, before it belongs to a project. */
export type EndpointDraft = EndpointInput & {
  method: EndpointMethod;
  path: string;
  operationId: string | null;
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
  return { format, drafts, skipped };
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
    requiresAuth: lowered.some((name) => ["authorization", "x-api-key", "api-key", "apikey"].includes(name)),
    operationId: null,
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
    tags: operation.tag ? [operation.tag] : [],
    operationId: linked ? operation.id : null,
  };
}
