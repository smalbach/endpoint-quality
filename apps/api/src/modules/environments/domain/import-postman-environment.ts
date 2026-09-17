/**
 * A Postman environment, read as an environment of this project.
 *
 * The third thing an export carries, after the URLs and the tests, and the one without which the
 * other two cannot run: a collection written against `{{baseUrl}}` and `{{access_token}}` is a
 * collection that does nothing until somebody supplies those two names. Retyping seven variables
 * per environment, across three environments, is exactly the work this exists to remove — and it
 * is work people get wrong quietly, because a missing variable does not look like a missing
 * variable, it looks like a request to the wrong host.
 *
 * Three decisions carry the rest:
 *
 * - **`type: "secret"` becomes `sensitive`**, which in this product is not a display hint: the
 *   value is encrypted in the column, it leaves the API as a mask, and the mask coming back means
 *   «unchanged». A secret imported as a plain variable would be a token in a `jsonb` column that
 *   every screen then shows.
 * - **A row switched off in Postman stays off here.** It is the same idea in both tools, and
 *   importing it as active would send something nobody asked for.
 * - **The base URL is a variable *and* the environment's base URL.** This product needs an
 *   absolute base URL on the row; Postman keeps it as just another variable, and the collections
 *   refer to it by name. Dropping the variable would break every `{{baseUrl}}/v1/x` in the flows,
 *   and not filling the column would make the environment unusable. So it is read into both.
 *
 * Pure: what the file says, and nothing about what the project already has.
 */

/** The names a Postman environment gives the API's address, in the order they are believed. */
const BASE_URL_KEYS = ["baseurl", "base_url", "baseuri", "base_uri", "host", "apiurl", "api_url", "url", "server"];

/** The same rule every variable name in this product follows. A Postman key that breaks it — a
 * space, a leading digit — cannot be substituted here, so it is reported instead of renamed. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export type ImportedVariable = { initial: string; sensitive: boolean };

export type PostmanEnvironmentDraft = {
  /** What the file calls itself, or empty when it does not say. */
  name: string;
  /** The absolute base URL found among the variables, or empty when there is none to find. */
  baseUrl: string;
  /** Which variable it came from, so the answer can say so rather than appear to invent it. */
  baseUrlFrom: string | null;
  variables: Record<string, ImportedVariable>;
  disabledVariables: Record<string, ImportedVariable>;
  /** Names this could not take, with the reason. */
  skipped: { name: string; reason: string }[];
  /** Worth knowing and not a failure: a secret with no value, a scope that is not an environment. */
  notes: string[];
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Whether a document is a Postman environment, a collection, or neither.
 *
 * Told apart by shape rather than by filename: what people drag in is whatever the download was
 * called, and `Catalog-API.json` is as likely to be either. An environment has `values` and no
 * `item`; a collection has `item`.
 */
export function postmanDocumentKind(text: string): "environment" | "collection" | null {
  const document = asRecord(safeJson(text));
  if (!document) return null;
  if (Array.isArray(document.item)) return "collection";
  if (Array.isArray(document.values)) return "environment";
  return null;
}

/**
 * The variables of a Postman export, whichever of the two it is.
 *
 * A collection carries its own `variable` array — the values its author pinned to the collection
 * rather than to an environment — and those are as necessary to a run as the environment's own.
 * Both are read here, because the engine has **one** flat map of variables and the distinction
 * Postman draws between the scopes does not survive into it.
 *
 * `null` when the text is not JSON, which is the one thing a reader cannot work around.
 */
export function readPostmanEnvironment(text: string): PostmanEnvironmentDraft | null {
  const document = asRecord(safeJson(text));
  if (!document) return null;

  const notes: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const variables: Record<string, ImportedVariable> = {};
  const disabledVariables: Record<string, ImportedVariable> = {};

  const scope = asString(document._postman_variable_scope);
  if (scope && scope !== "environment") {
    // `globals` is a legal export and reads identically; it is only worth saying out loud because
    // what comes out is an environment of this project, which globals were not.
    notes.push(`El fichero es del ámbito «${scope}» de Postman y entra como un entorno de este proyecto.`);
  }

  // A collection keeps its pinned values in `variable`; an environment keeps its own in `values`.
  const rows = [...asArray(document.values), ...asArray(document.variable)];
  for (const entry of rows) {
    const row = asRecord(entry);
    const name = asString(row?.key ?? row?.name).trim();
    if (!row || !name) continue;
    if (!VARIABLE_NAME.test(name)) {
      skipped.push({ name, reason: "el nombre no vale como variable: empieza por letra o «_»" });
      continue;
    }
    // Postman marks a secret with `type: "secret"`; older exports use `"password"`.
    const type = asString(row.type).toLowerCase();
    const sensitive = type === "secret" || type === "password";
    const value = asString(row.value);
    const target = row.enabled === false || row.disabled === true ? disabledVariables : variables;
    target[name] = { initial: value, sensitive };
  }

  const empties = Object.entries(variables)
    .filter(([, variable]) => variable.sensitive && !variable.initial)
    .map(([name]) => name);
  if (empties.length) {
    // The most common shape of a committed environment file: the secrets are blank on purpose, and
    // a run that substitutes an empty token fails on a 401 that says nothing about the endpoint.
    notes.push(`Sin valor y marcadas como secretas: ${empties.join(", ")}. Escríbelas antes de lanzar una corrida.`);
  }

  const found = Object.entries(variables).find(
    ([name, variable]) => BASE_URL_KEYS.includes(name.toLowerCase()) && isAbsoluteHttp(variable.initial),
  );

  return {
    name: asString(asRecord(document.info)?.name) || asString(document.name),
    baseUrl: found ? found[1].initial.replace(/\/+$/, "") : "",
    baseUrlFrom: found ? found[0] : null,
    variables,
    disabledVariables,
    skipped,
    notes,
  };
}

/** Absolute, and http(s) — the same rule the environment's own column enforces, applied here so
 * the pick is never a value that would be rejected two layers down. */
function isAbsoluteHttp(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
