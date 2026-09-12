/**
 * An endpoint of the project, as a row of its own.
 *
 * Until now the endpoints were only ever the contract's operations: read-only, replaced whole on
 * every import, and absent in a project that had no OpenAPI document. The analyzer treats them as
 * something a team writes, edits, archives and imports from wherever it has them, and this is that.
 *
 * **The contract still counts.** Importing a contract creates or links an endpoint per operation
 * (`origin: "contract"`, `operationId`), so drift detection keeps working on the operations and the
 * endpoint list shows which rows the active contract no longer declares. Nothing here deletes an
 * endpoint because the contract moved: somebody may have spent an afternoon on its request.
 *
 * What the analyzer's editor lost on every reload is stored here: the body type, the form fields,
 * the value of each path parameter and which rows are switched off. A file chosen for an upload is
 * the exception — the bytes belong to whoever is at the keyboard, and only its field name is kept.
 */

export const ENDPOINT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type EndpointMethod = (typeof ENDPOINT_METHODS)[number];

export const ENDPOINT_STATUSES = ["active", "archived", "inactive"] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];

/** Where the row came from. Only `contract` rows are linked and refreshed by a contract import. */
export const ENDPOINT_ORIGINS = ["manual", "import", "contract"] as const;
export type EndpointOrigin = (typeof ENDPOINT_ORIGINS)[number];

export const PARAMETER_TYPES = ["string", "number", "boolean", "uuid", "array"] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export type EndpointPathParameter = {
  name: string;
  type: ParameterType;
  description: string;
  /** What is sent. `{{variable}}` allowed. */
  value: string;
};

export type EndpointQueryParameter = {
  name: string;
  type: ParameterType;
  required: boolean;
  description: string;
  value: string;
  enabled: boolean;
};

export type EndpointHeader = { name: string; value: string; enabled: boolean };

export type EndpointFormField = { name: string; value: string; kind: "text" | "file"; enabled: boolean };

export const BODY_MODES = ["none", "json", "raw", "form-data", "x-www-form-urlencoded", "binary"] as const;
export type BodyMode = (typeof BODY_MODES)[number];

/**
 * One object with every field, not a tagged union, and on purpose: the editor switches type back
 * and forth and what the other types held should still be there when it comes back. `mode` says
 * which part is sent.
 */
export type EndpointBody = {
  mode: BodyMode;
  /** JSON and raw text. Kept as text so `{"id": {{id}}}` — not JSON until substituted — survives. */
  text: string;
  /** For raw; JSON always goes as `application/json`. */
  contentType: string;
  /** form-data and urlencoded share the rows; a urlencoded body sends only the text ones. */
  fields: EndpointFormField[];
};

export const EMPTY_BODY: EndpointBody = { mode: "none", text: "", contentType: "text/plain", fields: [] };

export type Endpoint = {
  id: string;
  projectId: string;
  method: EndpointMethod;
  path: string;
  description: string;
  pathParameters: EndpointPathParameter[];
  query: EndpointQueryParameter[];
  headers: EndpointHeader[];
  body: EndpointBody;
  requiresAuth: boolean;
  tags: string[];
  status: EndpointStatus;
  origin: EndpointOrigin;
  /** The contract operation this row is, when a contract import created or linked it. */
  operationId: string | null;
  orderIndex: number;
  preRequestScript: string;
  postResponseScript: string;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
  deletedAt: Date | null;
};

/** Everything a person can write. Every field optional, so the same shape serves create and update. */
export type EndpointInput = Partial<
  Pick<
    Endpoint,
    | "method"
    | "path"
    | "description"
    | "pathParameters"
    | "query"
    | "headers"
    | "body"
    | "requiresAuth"
    | "tags"
    | "status"
    | "preRequestScript"
    | "postResponseScript"
  >
>;

export const MAX_PATH = 500;
export const MAX_SCRIPT = 50_000;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path the way this product writes it: `/users/{id}`.
 *
 * Every tool spells a placeholder differently — `:id` in Express and Postman, `<id>` in Flask,
 * `[id]` in Next — and an import that kept them all would list `/users/:id` and `/users/{id}` as
 * two endpoints. A raw UUID in a pasted cURL is a placeholder somebody forgot to write, and becomes
 * one named after the segment before it. The query string and the fragment are not part of a path.
 * `{{variables}}` are left exactly as they are.
 */
export function normalizePath(raw: string): string {
  const trimmed = raw.trim().split("#")[0].split("?")[0];
  if (!trimmed) return "/";
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  const taken = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${name}${suffix}`;
    taken.add(candidate);
    return candidate;
  };

  const normalized = segments.map((segment, index) => {
    if (segment.startsWith("{{")) return segment;
    const placeholder = /^(?::(.+)|<(?:[^:>]+:)?([^>]+)>|\[(.+)\]|\{([^{}]+)\})$/.exec(segment);
    if (placeholder)
      return `{${unique((placeholder[1] ?? placeholder[2] ?? placeholder[3] ?? placeholder[4]).trim())}}`;
    if (UUID_SEGMENT.test(segment)) return `{${unique(idNameAfter(segments[index - 1]))}}`;
    return segment;
  });
  return `/${normalized.join("/")}`;
}

/** `users` → `userId`; nothing before it → `id`. */
function idNameAfter(previous: string | undefined): string {
  if (!previous || previous.startsWith("{")) return "id";
  const word = previous.replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) => (next ?? "").toUpperCase());
  const singular = word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("s") ? word.slice(0, -1) : word;
  return `${singular.charAt(0).toLowerCase()}${singular.slice(1)}Id`;
}

/** The `{name}` placeholders of a path, in order. `{{variables}}` are not parameters. */
export function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)].map((match) => match[1]);
}

/** The path's placeholders, keeping what was already typed for the ones that are still there. */
export function reconcilePathParameters(path: string, previous: EndpointPathParameter[]): EndpointPathParameter[] {
  return pathParameterNames(path).map(
    (name) =>
      previous.find((parameter) => parameter.name === name) ?? {
        name,
        type: /uuid/i.test(name) ? "uuid" : "string",
        description: "",
        value: "",
      },
  );
}

/**
 * What makes two endpoints the same route: the method and the path **with the placeholder names
 * erased**. `/users/{id}` and `/users/{userId}` answer the same requests, and an import that named
 * the parameter differently must not add the route a second time.
 */
export const endpointKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${normalizePath(path).replace(/(?<!\{)\{[^{}]+\}(?!\})/g, "{}")}`;

type Problem = { field: string; detail: string };

/** What is wrong with an input, field by field. Assumes nothing about which fields are present. */
export function endpointProblems(input: EndpointInput): Problem[] {
  const problems: Problem[] = [];
  const problem = (field: string, detail: string) => problems.push({ field, detail });

  if (input.method !== undefined && !(ENDPOINT_METHODS as readonly string[]).includes(input.method))
    problem("method", `Uno de ${ENDPOINT_METHODS.join(", ")}`);
  if (input.path !== undefined) {
    const path = input.path.trim();
    if (!path) problem("path", "Falta la ruta");
    else if (path.length > MAX_PATH) problem("path", `Como mucho ${MAX_PATH} caracteres`);
    else if (!path.startsWith("/")) problem("path", "Empieza por /, la URL base la pone el entorno o el proyecto");
    else if (/\s/.test(path)) problem("path", "Una ruta no lleva espacios");
  }
  if (input.status !== undefined && !(ENDPOINT_STATUSES as readonly string[]).includes(input.status))
    problem("status", `Uno de ${ENDPOINT_STATUSES.join(", ")}`);

  input.pathParameters?.forEach((parameter, index) => {
    if (!parameter?.name?.trim()) problem(`pathParameters.${index}.name`, "Falta el nombre");
    if (parameter && !(PARAMETER_TYPES as readonly string[]).includes(parameter.type))
      problem(`pathParameters.${index}.type`, `Uno de ${PARAMETER_TYPES.join(", ")}`);
  });
  duplicates(input.query?.map((row) => row?.name?.trim() ?? "")).forEach((index) =>
    problem(`query.${index}.name`, "Ya hay un parámetro con ese nombre"),
  );
  input.query?.forEach((parameter, index) => {
    if (parameter && !(PARAMETER_TYPES as readonly string[]).includes(parameter.type))
      problem(`query.${index}.type`, `Uno de ${PARAMETER_TYPES.join(", ")}`);
  });
  input.headers?.forEach((header, index) => {
    const name = header?.name?.trim() ?? "";
    if (name && !HEADER_NAME.test(name)) problem(`headers.${index}.name`, "No es un nombre de cabecera válido");
    if (/[\r\n]/.test(header?.value ?? "")) problem(`headers.${index}.value`, "Una cabecera no lleva saltos de línea");
  });

  if (input.body !== undefined) {
    if (!(BODY_MODES as readonly string[]).includes(input.body?.mode))
      problem("body.mode", `Uno de ${BODY_MODES.join(", ")}`);
    input.body?.fields?.forEach((field, index) => {
      if (field && field.kind !== "text" && field.kind !== "file") problem(`body.fields.${index}.kind`, "text o file");
    });
  }
  if (input.tags !== undefined) {
    if (input.tags.length > 30) problem("tags", "Como mucho 30 etiquetas");
    if (input.tags.some((tag) => typeof tag !== "string" || tag.length > 40))
      problem("tags", "Cada etiqueta, texto de 40 caracteres como mucho");
  }
  for (const field of ["preRequestScript", "postResponseScript"] as const) {
    if ((input[field]?.length ?? 0) > MAX_SCRIPT) problem(field, `Como mucho ${MAX_SCRIPT} caracteres`);
  }
  return problems;
}

/** Indexes of every repeated non-empty value after its first appearance. */
function duplicates(values: string[] | undefined): number[] {
  const seen = new Set<string>();
  const repeated: number[] = [];
  values?.forEach((value, index) => {
    if (!value) return;
    if (seen.has(value)) repeated.push(index);
    seen.add(value);
  });
  return repeated;
}

/**
 * The input, cleaned: trimmed names, blank rows dropped, the path normalized and its parameters
 * reconciled with it. Assumes {@link endpointProblems} returned nothing.
 */
export function applyEndpointInput(current: Endpoint, input: EndpointInput): Endpoint {
  const path = input.path !== undefined ? normalizePath(input.path) : current.path;
  const named = <T extends { name: string }>(rows: T[]) =>
    rows.map((row) => ({ ...row, name: row.name.trim() })).filter((row) => row.name);

  return {
    ...current,
    method: input.method ?? current.method,
    path,
    description: input.description?.trim() ?? current.description,
    pathParameters: reconcilePathParameters(path, input.pathParameters ?? current.pathParameters),
    query: input.query
      ? named(input.query).map((row) => ({
          name: row.name,
          type: row.type,
          required: Boolean(row.required),
          description: row.description ?? "",
          value: row.value ?? "",
          enabled: row.enabled !== false,
        }))
      : current.query,
    headers: input.headers
      ? named(input.headers).map((row) => ({ name: row.name, value: row.value ?? "", enabled: row.enabled !== false }))
      : current.headers,
    body: input.body
      ? {
          mode: input.body.mode,
          text: input.body.text ?? "",
          contentType: input.body.contentType?.trim() || "text/plain",
          fields: named(input.body.fields ?? []).map((field) => ({
            name: field.name,
            // A file field keeps its name only: the bytes never reach the row.
            value: field.kind === "file" ? "" : (field.value ?? ""),
            kind: field.kind,
            enabled: field.enabled !== false,
          })),
        }
      : current.body,
    requiresAuth: input.requiresAuth ?? current.requiresAuth,
    tags: input.tags ? [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))] : current.tags,
    status: input.status ?? current.status,
    preRequestScript: input.preRequestScript ?? current.preRequestScript,
    postResponseScript: input.postResponseScript ?? current.postResponseScript,
  };
}

export function blankEndpoint(fields: {
  id: string;
  projectId: string;
  origin: EndpointOrigin;
  orderIndex: number;
  now: Date;
  actorId: string;
}): Endpoint {
  return {
    id: fields.id,
    projectId: fields.projectId,
    method: "GET",
    path: "/",
    description: "",
    pathParameters: [],
    query: [],
    headers: [],
    body: EMPTY_BODY,
    requiresAuth: false,
    tags: [],
    status: "active",
    origin: fields.origin,
    operationId: null,
    orderIndex: fields.orderIndex,
    preRequestScript: "",
    postResponseScript: "",
    createdAt: fields.now,
    updatedAt: fields.now,
    updatedBy: fields.actorId,
    deletedAt: null,
  };
}

export type EndpointView = Omit<Endpoint, "projectId" | "deletedAt"> & {
  /** Whether the active contract declares this method and path. `null` without a contract. */
  inContract: boolean | null;
};

export function viewEndpoint(endpoint: Endpoint, contractKeys: Set<string> | null): EndpointView {
  const { projectId: _projectId, deletedAt: _deletedAt, ...rest } = endpoint;
  return { ...rest, inContract: contractKeys ? contractKeys.has(endpointKey(endpoint.method, endpoint.path)) : null };
}
