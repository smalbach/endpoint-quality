/**
 * An OpenAPI document, flattened into the operation table the engine runs on.
 *
 * This replaces `scripts/gen_dashboard_endpoints.py` — a build step in a *different repository*
 * that wrote a TypeScript file into the dashboard, which then compiled it into its bundle. The
 * arrangement worked and had one fatal property: when the contract moved to a new version, the
 * generated copy went stale in silence and the dashboard reported green against a spec that no
 * longer existed. A drift detector that cannot detect its own drift is the worst possible
 * version of the tool.
 *
 * Here the document is read at runtime, into a snapshot with a hash. Nothing is compiled in.
 *
 * **Problems are collected, not thrown.** One operation missing an `operationId` must not stop
 * the other forty-five from importing; the import returns what it understood plus a list of what
 * it could not, and the caller decides. A parser that refuses the whole document over one bad
 * node makes the tool unusable against exactly the imperfect specs it is most needed for.
 */
import { parse as parseYaml } from "yaml";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ImportedOperation = {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  tag: string;
  statuses: number[];
  parameters: string[];
  /** The security schemes the operation declares, or the document's default when it declares
   * none. Empty means the operation is explicitly public. Used to decide which authorization
   * cases are worth generating. */
  security: string[];
  /** True when `operationId` was absent and the id below was derived from method and path. The
   * id is stable, but it is not the contract's own name for the operation, and configuration
   * keyed by it would break the day the author adds a real one. */
  derivedId: boolean;
};

export type ImportProblem = {
  severity: "error" | "warning";
  pointer: string;
  message: string;
};

export type ImportedSpec = {
  openapiVersion: string;
  title: string;
  version: string;
  operations: ImportedOperation[];
  problems: ImportProblem[];
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Parses YAML or JSON. OpenAPI documents are served as both, and telling them apart by
 * extension fails on a URL that has none. YAML is a superset of JSON, so one parser covers it —
 * but JSON is tried first because its errors are far more precise. */
export function parseDocument(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`El documento no es JSON válido: ${error instanceof Error ? error.message : "sin detalle"}`);
    }
  }
  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("El documento no contiene un objeto en la raíz");
  return parsed as Record<string, unknown>;
}

/**
 * Follows `$ref` until it lands on a real node.
 *
 * Only local pointers. A document that still refers to a neighbouring file has not been bundled,
 * and resolving it would mean fetching whatever URL the document names — which turns spec import
 * into a request forger. The caller is told to bundle it instead.
 */
function resolve(node: unknown, root: Record<string, unknown>, seen: Set<string> = new Set()): unknown {
  let current = node;
  while (current && typeof current === "object" && "$ref" in current) {
    const pointer = (current as { $ref: unknown }).$ref;
    if (typeof pointer !== "string" || !pointer.startsWith("#/")) return undefined;
    if (seen.has(pointer)) return undefined;
    seen.add(pointer);
    let target: unknown = root;
    for (const part of pointer.slice(2).split("/")) {
      target = (target as Record<string, unknown> | undefined)?.[decodePointerSegment(part)];
    }
    current = target;
  }
  return current;
}

/** JSON Pointer escapes `/` as `~1` and `~` as `~0`. A schema named `application/json` in
 * `components` is the common case, and getting this wrong silently resolves to nothing. */
function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Derives a stable id for an operation the document did not name.
 *
 * `operationId` is optional in OpenAPI and plenty of real documents omit it. Without one there
 * is nothing to key configuration by, so an id is derived from the method and path — the same
 * input produces the same id on every import, which is what matters for the configuration to
 * survive a re-import.
 */
export function deriveOperationId(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith("{") ? `by-${segment.slice(1, -1)}` : segment));
  // Underscores survive: `{store_id}` is what the contract calls the parameter, and folding it
  // to `store-id` both loses that trace and lets two distinct parameters collide on one id.
  return [method.toLowerCase(), ...segments].join("-").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function securitySchemes(node: unknown): string[] | undefined {
  if (!Array.isArray(node)) return undefined;
  return node.flatMap((requirement) => (requirement && typeof requirement === "object" ? Object.keys(requirement) : []));
}

/**
 * Reads one document into operations.
 *
 * The order is **path, then method**, and it is deliberate rather than incidental: it is the
 * "contract" order an operator can choose in the UI, and a stable order is what makes the
 * difference between two imports of the same document a real diff instead of a reshuffle.
 */
export function importSpec(raw: string): ImportedSpec {
  const document = parseDocument(raw);
  const problems: ImportProblem[] = [];

  const openapiVersion = typeof document.openapi === "string" ? document.openapi : typeof document.swagger === "string" ? document.swagger : "";
  if (!openapiVersion) problems.push({ severity: "error", pointer: "#/openapi", message: "El documento no declara una versión de OpenAPI" });
  else if (openapiVersion.startsWith("2.")) {
    // Swagger 2.0 is a different document shape, not an older spelling of the same one:
    // `definitions` instead of `components`, `produces` instead of media types. Reading it with
    // this parser would silently produce an operation table with no schemas attached.
    problems.push({ severity: "error", pointer: "#/swagger", message: "Swagger 2.0 no está soportado: convierte el documento a OpenAPI 3.x" });
  }

  const info = (document.info ?? {}) as Record<string, unknown>;
  const defaultSecurity = securitySchemes(document.security) ?? [];
  const paths = (document.paths ?? {}) as Record<string, unknown>;
  if (!document.paths) problems.push({ severity: "warning", pointer: "#/paths", message: "El documento no declara rutas" });

  const operations: ImportedOperation[] = [];
  const seenIds = new Map<string, string>();

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(rawItem, document) as Record<string, unknown> | undefined;
    if (!item) {
      problems.push({ severity: "warning", pointer: `#/paths/${path}`, message: "No se pudo resolver la ruta" });
      continue;
    }

    // OpenAPI lets a path item declare parameters shared by every operation under it, and most
    // documents put the path ids there. They belong to each operation, and reading only the
    // operation-level list loses `{store_id}` on every endpoint that has one.
    const shared = parameterNames(item.parameters, document, `#/paths/${path}/parameters`, problems);

    for (const method of METHODS) {
      const operation = item[method] as Record<string, unknown> | undefined;
      if (!operation || typeof operation !== "object") continue;
      const pointer = `#/paths/${path}/${method}`;

      const declaredId = typeof operation.operationId === "string" ? operation.operationId.trim() : "";
      const id = declaredId || deriveOperationId(method, path);
      if (!declaredId) {
        problems.push({ severity: "warning", pointer, message: `Sin operationId; se derivó "${id}" a partir del método y la ruta` });
      }
      const previous = seenIds.get(id);
      if (previous) {
        // Two operations under one id would silently share configuration, and the second would
        // overwrite the first's results in every view keyed by it.
        problems.push({ severity: "error", pointer, message: `operationId duplicado "${id}"; ya lo usa ${previous}` });
        continue;
      }
      seenIds.set(id, pointer);

      const responses = (operation.responses ?? {}) as Record<string, unknown>;
      const statuses = Object.keys(responses)
        .filter((code) => /^\d+$/.test(code))
        .map(Number)
        .sort((a, b) => a - b);
      if (statuses.length === 0) {
        // Every generated case asserts a declared status. An operation with none produces no
        // cases at all, which looks like coverage rather than absence unless it is reported.
        problems.push({ severity: "warning", pointer, message: "No declara ningún código de estado numérico; no generará casos" });
      }

      const tags = Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [];

      operations.push({
        id,
        method: method.toUpperCase() as HttpMethod,
        path,
        summary: typeof operation.summary === "string" ? operation.summary : "",
        tag: tags[0] ?? "",
        statuses,
        parameters: [...shared, ...parameterNames(operation.parameters, document, `${pointer}/parameters`, problems)],
        // An operation-level `security: []` means explicitly public and must not fall back to
        // the document default, so the presence of the key is what decides — not its emptiness.
        security: securitySchemes(operation.security) ?? defaultSecurity,
        derivedId: !declaredId,
      });
    }
  }

  operations.sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method));

  return {
    openapiVersion,
    title: typeof info.title === "string" ? info.title : "",
    version: typeof info.version === "string" ? info.version : "",
    operations,
    problems,
  };
}

/**
 * Codepoint order, not `localeCompare`.
 *
 * Collation is locale-dependent: under `en-US` it treats `{` as punctuation and sorts
 * `/v1/products/{product_id}` *before* `/v1/products/bulk`, while a codepoint comparison puts
 * `b` (0x62) before `{` (0x7B). The execution order of a run would then depend on the locale of
 * the machine that imported the contract, which is not a property anybody would look for while
 * debugging a matrix that runs in a different order on the server than on a laptop.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parameterNames(node: unknown, root: Record<string, unknown>, pointer: string, problems: ImportProblem[]): string[] {
  if (!Array.isArray(node)) return [];
  const names: string[] = [];
  for (const [index, entry] of node.entries()) {
    const parameter = resolve(entry, root) as Record<string, unknown> | undefined;
    if (!parameter || typeof parameter.name !== "string") {
      // Usually an unbundled `$ref` to a neighbouring file. Reported rather than skipped in
      // silence: a lost path parameter turns every case over that endpoint into a wrong URL.
      problems.push({ severity: "warning", pointer: `${pointer}/${index}`, message: "Parámetro no resoluble; ¿el documento está sin empaquetar?" });
      continue;
    }
    names.push(parameter.name);
  }
  return names;
}
