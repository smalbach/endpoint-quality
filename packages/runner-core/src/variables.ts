/** Postman-style variable interpolation shared by generated cases and user-authored workflows. */

/**
 * What may name a variable. Declared once and imported by everything that validates one — the
 * environment's own map, and a flow's capture target — because two copies of a rule are two rules
 * that will disagree the first time one of them is widened.
 */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export type RuntimeVariables = Record<string, string>;

export function interpolateText(value: string, variables: RuntimeVariables): string {
  return value.replace(TOKEN, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : token,
  );
}

export function interpolateValue<T>(value: T, variables: RuntimeVariables): T {
  if (typeof value === "string") return interpolateText(value, variables) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, variables)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateValue(item, variables)]),
    ) as T;
  }
  return value;
}

/** Reads a dot path with optional array indexes, for example `data.items.0.id`. */
export function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current === null || current === undefined || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[segment];
    }, value);
}

/**
 * The tokens still standing after interpolation, so a request that would carry `{{userId}}` into
 * somebody's URL is blocked instead of sent.
 *
 * It decodes `%7B`/`%7D` first and `interpolateText` does not, which is deliberate and not an
 * oversight: a token that reached this point percent-encoded was encoded by `requestPathFor` after
 * the substitution pass, so it can no longer be replaced — but it is still a variable nobody
 * supplied, and that is what the caller needs to hear.
 */
export function unresolvedVariables(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      const decoded = entry.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
      for (const match of decoded.matchAll(new RegExp(TOKEN.source, "g"))) found.add(match[1]);
    } else if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  visit(value);
  return [...found];
}
