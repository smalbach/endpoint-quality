/**
 * JSON Schema validation against the live `/openapi.json`.
 *
 * Plain `.mjs` on purpose: it is imported both by `app/api/run/route.ts`, which runs inside the
 * Worker, and by `tests/api-e2e.test.mjs`, which runs under `node --test` with no build step.
 * When these two disagree the dashboard turns green on cases the suite fails and the other way
 * round, so they share one implementation instead of two that drift.
 */

/**
 * Resolve `$ref` pointers into inline schemas.
 *
 * `seen` breaks recursive schemas: a self-referencing node resolves to `{}`, which validates
 * anything, rather than looping forever.
 *
 * @param {unknown} node
 * @param {Record<string, unknown>} root
 * @param {Set<string>} [seen]
 * @returns {unknown}
 */
export function dereference(node, root, seen = new Set()) {
  if (Array.isArray(node)) return node.map((item) => dereference(item, root, seen));
  if (!node || typeof node !== "object") return node;
  const record = /** @type {Record<string, unknown>} */ (node);
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
    if (seen.has(record.$ref)) return {};
    let target = /** @type {unknown} */ (root);
    for (const part of record.$ref.slice(2).split("/"))
      target = /** @type {Record<string, unknown>} */ (target)?.[part];
    return dereference(target, root, new Set(seen).add(record.$ref));
  }
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, dereference(value, root, seen)]));
}

/**
 * Validate a value against a dereferenced JSON Schema, collecting every failure.
 *
 * @param {unknown} value
 * @param {unknown} schema
 * @param {string} [path]
 * @param {string[]} [errors]
 * @returns {string[]} empty when the value conforms
 */
export function validateJson(value, schema, path = "$", errors = []) {
  if (!schema || typeof schema !== "object") return errors;
  const rule = /** @type {Record<string, unknown>} */ (schema);
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
  const types = Array.isArray(rule.type) ? rule.type : typeof rule.type === "string" ? [rule.type] : [];
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
    const record = /** @type {Record<string, unknown>} */ (value);
    const properties = /** @type {Record<string, unknown>} */ (rule.properties ?? {});
    for (const required of /** @type {string[]} */ (rule.required ?? []))
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
 * The dereferenced response schema the document declares for one operation and status, or
 * `undefined` when it declares none.
 *
 * `undefined` is a legitimate answer and not a failure: the API answers 422 on a corrupt cursor
 * and on an incomplete geographic trio without declaring it, which is D-12/D-27 and open. The
 * caller checks the Problem Details shape in that case instead of a schema.
 *
 * @param {Record<string, unknown>} spec
 * @param {string} operationPath the templated path, e.g. `/v1/stores/{store_id}/assortment`
 * @param {string} method
 * @param {number} status
 * @param {string} [contentType]
 * @returns {unknown | undefined}
 */
export function responseSchema(spec, operationPath, method, status, contentType = "application/json") {
  const paths = /** @type {Record<string, unknown>} */ (spec.paths ?? {});
  const operation = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (paths[operationPath])?.[method.toLowerCase()]
  );
  const declared = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (operation?.responses)?.[String(status)]
  );
  const content = /** @type {Record<string, unknown>} */ (declared?.content ?? {});
  const media = /** @type {Record<string, unknown>} */ (
    content[contentType.split(";")[0]] ?? content["application/json"]
  );
  return media?.schema ? dereference(media.schema, spec) : undefined;
}
