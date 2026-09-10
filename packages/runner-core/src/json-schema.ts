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
    for (const part of record.$ref.slice(2).split("/"))
      target = (target as Record<string, unknown> | undefined)?.[part];
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
  if (Array.isArray(rule.anyOf) && !rule.anyOf.some((part) => validateJson(value, part, path, []).length === 0))
    errors.push(`${path}: no coincide con ninguna alternativa`);
  if (
    Array.isArray(rule.oneOf) &&
    rule.oneOf.filter((part) => validateJson(value, part, path, []).length === 0).length !== 1
  )
    errors.push(`${path}: debe coincidir con una alternativa`);
  if (Array.isArray(rule.enum) && !rule.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))
    errors.push(`${path}: valor fuera del enum`);
  const types = Array.isArray(rule.type) ? (rule.type as string[]) : typeof rule.type === "string" ? [rule.type] : [];
  if (types.length) {
    const matches = types.some((type) =>
      type === "null"
        ? value === null
        : type === "array"
          ? Array.isArray(value)
          : type === "object"
            ? Boolean(value) && typeof value === "object" && !Array.isArray(value)
            : type === "integer"
              ? Number.isInteger(value)
              : type === "number"
                ? typeof value === "number"
                : typeof value === type,
    );
    if (!matches) {
      errors.push(`${path}: tipo esperado ${types.join(" | ")}`);
      return errors;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (rule.properties ?? {}) as Record<string, unknown>;
    for (const required of (rule.required ?? []) as string[])
      if (!(required in record)) errors.push(`${path}.${required}: campo requerido`);
    for (const [key, child] of Object.entries(record)) {
      if (properties[key]) validateJson(child, properties[key], `${path}.${key}`, errors);
      else if (rule.additionalProperties === false) errors.push(`${path}.${key}: campo adicional no permitido`);
    }
  }
  if (Array.isArray(value) && rule.items)
    value.forEach((item, index) => validateJson(item, rule.items, `${path}[${index}]`, errors));
  if (typeof value === "number") {
    if (typeof rule.minimum === "number" && value < rule.minimum) errors.push(`${path}: menor que ${rule.minimum}`);
    if (typeof rule.maximum === "number" && value > rule.maximum) errors.push(`${path}: mayor que ${rule.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof rule.minLength === "number" && value.length < rule.minLength)
      errors.push(`${path}: longitud menor que ${rule.minLength}`);
    if (typeof rule.maxLength === "number" && value.length > rule.maxLength)
      errors.push(`${path}: longitud mayor que ${rule.maxLength}`);
    if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(value))
      errors.push(`${path}: no cumple el patrón`);
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
export function responseSchema(
  spec: Record<string, unknown>,
  operationPath: string,
  method: string,
  status: number,
  contentType = "application/json",
): unknown | undefined {
  const paths = (spec.paths ?? {}) as Record<string, unknown>;
  const operation = (paths[operationPath] as Record<string, unknown> | undefined)?.[method.toLowerCase()] as
    Record<string, unknown> | undefined;
  const declared = (operation?.responses as Record<string, unknown> | undefined)?.[String(status)] as
    Record<string, unknown> | undefined;
  const content = (declared?.content ?? {}) as Record<string, unknown>;
  const media = (content[contentType.split(";")[0]] ?? content["application/json"]) as
    Record<string, unknown> | undefined;
  return media?.schema ? dereference(media.schema, spec) : undefined;
}

/**
 * The fields the API returned that its own document does not declare.
 *
 * The opposite direction of validation, and the one nobody checks: a missing required field is a
 * broken response, but an *extra* one is a contract that has moved without the document moving
 * with it. The consumer that starts depending on it is depending on something nobody promised, and
 * the day it disappears the breakage looks like it came from nowhere.
 *
 * It is not an error and is never reported as one — `additionalProperties: false` is what turns
 * «undeclared» into «forbidden», and that is the schema's call, made in the schema. What this
 * returns is a warning's worth of information: the paths, so an operator can look at them.
 *
 * A schema that declares no `properties` at all says nothing about its object, so it produces
 * nothing: reporting every field of a free-form object as drift is noise, not a finding.
 */
export function undeclaredPaths(value: unknown, schema: unknown, path = "$", found: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return found;
  const rule = schema as Record<string, unknown>;
  // `allOf` composes the declaration: a field declared by any branch is declared.
  const branches = [rule, ...((rule.allOf as unknown[]) ?? [])].filter(
    (branch): branch is Record<string, unknown> => Boolean(branch) && typeof branch === "object",
  );

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const declared = Object.assign({}, ...branches.map((branch) => (branch.properties ?? {}) as object)) as Record<
      string,
      unknown
    >;
    // `anyOf`/`oneOf` mean the shape is one of several and this validator does not know which, so
    // it declines to guess rather than calling every field of the other branches undeclared.
    const ambiguous = branches.some((branch) => Array.isArray(branch.anyOf) || Array.isArray(branch.oneOf));
    if (Object.keys(declared).length && !ambiguous) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key in declared) undeclaredPaths(child, declared[key], `${path}.${key}`, found);
        else found.push(`${path}.${key}`);
      }
    }
  }

  if (Array.isArray(value)) {
    const items = branches.find((branch) => branch.items)?.items;
    // Only the first element. A list of two hundred rows that all drifted the same way is one
    // finding, and reporting it two hundred times buries everything else in the run.
    if (items && value.length) undeclaredPaths(value[0], items, `${path}[0]`, found);
  }

  return found;
}
