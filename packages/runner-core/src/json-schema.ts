/**
 * JSON Schema validation against the target's own OpenAPI document.
 *
 * This is the assertion that makes the difference between "the API answered 200" and "the API
 * answered what it promised". It is deliberately a small, dependency-free validator rather than
 * Ajv: it runs identically in the API process and in the browser preview, it reports *every*
 * failure instead of the first, and its messages name the JSON path an operator can look at.
 *
 * It does not implement all of JSON Schema. It implements what OpenAPI 3 documents actually
 * use, and an unknown keyword is ignored rather than treated as a failure — a validator that
 * invents errors is worse than one that misses some.
 */

/**
 * Resolves `$ref` pointers into inline schemas.
 *
 * `seen` breaks recursive schemas: a self-referencing node resolves to `{}`, which validates
 * anything, rather than looping forever.
 */
export function dereference(node: unknown, root: Record<string, unknown>, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(node)) return node.map((item) => dereference(item, root, seen));
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
    if (seen.has(record.$ref)) return {};
    let target: unknown = root;
    for (const part of record.$ref.slice(2).split("/")) target = (target as Record<string, unknown> | undefined)?.[part];
    return dereference(target, root, new Set(seen).add(record.$ref));
  }
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, dereference(value, root, seen)]));
}

/** Validates a value against a dereferenced schema, collecting every failure. Empty means it
 * conforms. */
export function validateJson(value: unknown, schema: unknown, path = "$", errors: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return errors;
  const rule = schema as Record<string, unknown>;
  if (Array.isArray(rule.allOf)) rule.allOf.forEach((part) => validateJson(value, part, path, errors));
  if (Array.isArray(rule.anyOf) && !rule.anyOf.some((part) => validateJson(value, part, path, []).length === 0)) errors.push(`${path}: no coincide con ninguna alternativa`);
  if (Array.isArray(rule.oneOf) && rule.oneOf.filter((part) => validateJson(value, part, path, []).length === 0).length !== 1) errors.push(`${path}: debe coincidir con una alternativa`);
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${path}: valor fuera del enum`);
  const types = Array.isArray(rule.type) ? (rule.type as string[]) : typeof rule.type === "string" ? [rule.type] : [];
  if (types.length) {
    const matches = types.some((type) =>
      type === "null" ? value === null
      : type === "array" ? Array.isArray(value)
      : type === "object" ? Boolean(value) && typeof value === "object" && !Array.isArray(value)
      : type === "integer" ? Number.isInteger(value)
      : type === "number" ? typeof value === "number"
      : typeof value === type);
    if (!matches) { errors.push(`${path}: tipo esperado ${types.join(" | ")}`); return errors; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (rule.properties ?? {}) as Record<string, unknown>;
    for (const required of (rule.required ?? []) as string[]) if (!(required in record)) errors.push(`${path}.${required}: campo requerido`);
    for (const [key, child] of Object.entries(record)) {
      if (properties[key]) validateJson(child, properties[key], `${path}.${key}`, errors);
      else if (rule.additionalProperties === false) errors.push(`${path}.${key}: campo adicional no permitido`);
    }
  }
  if (Array.isArray(value) && rule.items) value.forEach((item, index) => validateJson(item, rule.items, `${path}[${index}]`, errors));
  if (typeof value === "number") {
    if (typeof rule.minimum === "number" && value < rule.minimum) errors.push(`${path}: menor que ${rule.minimum}`);
    if (typeof rule.maximum === "number" && value > rule.maximum) errors.push(`${path}: mayor que ${rule.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof rule.minLength === "number" && value.length < rule.minLength) errors.push(`${path}: longitud menor que ${rule.minLength}`);
    if (typeof rule.maxLength === "number" && value.length > rule.maxLength) errors.push(`${path}: longitud mayor que ${rule.maxLength}`);
    if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(value)) errors.push(`${path}: no cumple el patrón`);
  }
  return errors;
}

/**
 * The dereferenced response schema a document declares for one operation and status, or
 * `undefined` when it declares none.
 *
 * `undefined` is a legitimate answer and not a failure: an API can answer 422 on a corrupt
 * cursor without having declared it, which is a finding about the contract rather than about
 * the response. The caller checks the error envelope in that case instead.
 */
export function responseSchema(spec: Record<string, unknown>, operationPath: string, method: string, status: number, contentType = "application/json"): unknown | undefined {
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  const operation = (paths[operationPath] as Record<string, unknown> | undefined)?.[method.toLowerCase()] as Record<string, unknown> | undefined;
  const declared = (operation?.responses as Record<string, unknown> | undefined)?.[String(status)] as Record<string, unknown> | undefined;
  const content = (declared?.content ?? {}) as Record<string, unknown>;
  const media = (content[contentType.split(";")[0]] ?? content["application/json"]) as Record<string, unknown> | undefined;
  return media?.schema ? dereference(media.schema, spec) : undefined;
}
