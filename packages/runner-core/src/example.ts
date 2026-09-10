/**
 * A request body built from the JSON Schema the contract already declares.
 *
 * Until now every write case sent whatever the project's `bodies` section said, and nothing when
 * it said nothing — so a project pointed at a fresh contract came back with all of its POSTs,
 * PUTs and PATCHes red on a 422, for want of a payload. The contract had the answer the whole
 * time: an operation with a `requestBody` describes exactly what it will accept.
 *
 * That is the difference between a product that works once you configure it and one that works
 * when you point it at something, which was the whole reason for taking the coupled dashboard
 * apart. **Configuration still wins** — see `resolveOperations` — because a schema says what is
 * *structurally* valid and a project knows what is *acceptable*: which store id exists, which EAN
 * is real, which name is already taken. This fills the gap; it does not replace the knowledge.
 *
 * What it deliberately does not do:
 *
 * - **Invent a conflict.** The 409 case needs a payload that collides with a row that is already
 *   there, which is knowledge about the data and not about the schema. `conflictBody` stays
 *   configuration, and without it there is no conflict case, as before.
 * - **Randomise.** A body that changes between runs makes two runs incomparable and a failure
 *   irreproducible. Everything here is a pure function of the schema.
 * - **Guess past the document.** A `string` with no `example`, `default`, `enum`, `format` or
 *   `pattern` gets a placeholder. If the API wanted a real EAN, the 422 that comes back is the
 *   truth about a contract that did not say so, and the fix is either the contract or the
 *   `bodies` section.
 */
import { exampleFromPattern } from "./pattern.ts";

/** Deep enough for a nested resource inside a nested collection, and short enough that a
 * recursive schema — a category with children, a comment with replies — stops instead of
 * building until it runs out of memory. */
const MAX_DEPTH = 6;

type Schema = Record<string, unknown>;

/**
 * The example this schema describes, or `undefined` when it describes nothing usable.
 *
 * `undefined` rather than `{}`: an empty object *is* the invalid-body case, and returning one here
 * would make the create case and the invalid-body case send the same payload and expect opposite
 * answers.
 */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  if (depth > MAX_DEPTH) return undefined;
  const rule = schema as Schema;

  // The document's own words come first, at every level. An `example` on the whole request body is
  // the author saying "send this", and there is nothing to improve on it.
  if ("example" in rule) return rule.example;
  if ("default" in rule) return rule.default;
  if ("const" in rule) return rule.const;
  if (Array.isArray(rule.examples) && rule.examples.length) return rule.examples[0];
  if (Array.isArray(rule.enum) && rule.enum.length) return rule.enum[0];

  // `allOf` is composition: the value has to satisfy every branch, so the branches are merged.
  // `oneOf`/`anyOf` is a choice, and the first branch is as good as any — with one exception
  // below, where a branch is plainly the null one.
  if (Array.isArray(rule.allOf) && rule.allOf.length) {
    const merged = rule.allOf.map((part) => exampleFromSchema(part, depth)).filter((value) => value && typeof value === "object" && !Array.isArray(value));
    if (merged.length) return Object.assign({}, ...(merged as object[]));
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = rule[key];
    if (Array.isArray(branches) && branches.length) {
      // A nullable field is usually written as `anyOf: [{…}, {type: null}]`, and answering `null`
      // to it would leave a required field empty for no reason.
      const useful = branches.find((branch) => (branch as Schema)?.type !== "null") ?? branches[0];
      return exampleFromSchema(useful, depth);
    }
  }

  const type = Array.isArray(rule.type) ? (rule.type as string[]).find((candidate) => candidate !== "null") : rule.type;

  if (type === "object" || (!type && rule.properties)) return objectExample(rule, depth);
  if (type === "array") return arrayExample(rule, depth);
  if (type === "string") return stringExample(rule);
  if (type === "integer" || type === "number") return numberExample(rule, type === "integer");
  if (type === "boolean") return true;
  if (type === "null") return null;
  return undefined;
}

/**
 * Required properties always; optional ones only when the document gave them a value — **unless
 * nothing is required at all**, and then every writable property.
 *
 * The minimal valid payload is the one most likely to be accepted. Filling in every optional field
 * with something invented gives an API more surface to reject, and a 422 caused by a field nobody
 * asked for reads as a fault in the endpoint.
 *
 * The exception is what a `PATCH` looks like. Declaring every field optional is the *point* of a
 * partial update, and the minimal valid payload for such a schema is `{}` — which is no payload,
 * and which several APIs correctly answer 422 to. So when a schema requires nothing, the fallback
 * is everything it declares: the document has said the operation accepts those fields, and a
 * mutation that changes every one of them is also what makes the read-back afterwards worth
 * anything.
 */
function objectExample(rule: Schema, depth: number): Record<string, unknown> | undefined {
  const properties = rule.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== "object") return undefined;
  const required = new Set(Array.isArray(rule.required) ? (rule.required as string[]) : []);
  const nothingRequired = required.size === 0;

  const body: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const definition = (property ?? {}) as Schema;
    // `readOnly` marks a field the server produces — an id, a timestamp. OpenAPI says it must not
    // be sent in a request, and an API that validates strictly answers 422 to one that is.
    if (definition.readOnly === true) continue;
    const stated = "example" in definition || "default" in definition || "const" in definition;
    if (!nothingRequired && !required.has(name) && !stated) continue;
    const value = exampleFromSchema(definition, depth + 1);
    if (value !== undefined) body[name] = value;
  }
  // Every property was read-only, or none could be built. An empty object here would be the
  // invalid-body case wearing the create case's name.
  return Object.keys(body).length ? body : undefined;
}

function arrayExample(rule: Schema, depth: number): unknown[] | undefined {
  const item = exampleFromSchema(rule.items, depth + 1);
  if (item === undefined) return undefined;
  // `minItems` and not one element always: a bulk endpoint that demands at least two rows would
  // otherwise be handed one and answer 422 about the array rather than about the payload.
  const count = Math.max(1, Math.min(typeof rule.minItems === "number" ? rule.minItems : 1, 10));
  return Array.from({ length: count }, () => item);
}

/**
 * A value the format asks for, and a visibly synthetic one otherwise.
 *
 * The placeholder says what it is on purpose. When one of these reaches an API's logs, or a person
 * reading a failed case, "ejemplo" is a better thing to find than a plausible-looking name that
 * gets mistaken for real data.
 */
function stringExample(rule: Schema): string {
  const format = typeof rule.format === "string" ? rule.format : "";
  const byFormat: Record<string, string> = {
    "date-time": "2024-01-01T00:00:00Z",
    date: "2024-01-01",
    time: "00:00:00",
    duration: "P1D",
    email: "ejemplo@example.com",
    "idn-email": "ejemplo@example.com",
    hostname: "example.com",
    ipv4: "192.0.2.1",
    ipv6: "2001:db8::1",
    uri: "https://example.com/ejemplo",
    "uri-reference": "/ejemplo",
    url: "https://example.com/ejemplo",
    uuid: "00000000-0000-4000-8000-000000000000",
    byte: "ZWplbXBsbw==",
    password: "ejemplo-de-contraseña",
  };
  const formatted = byFormat[format];

  const base = "ejemplo";
  const minimum = typeof rule.minLength === "number" ? rule.minLength : 0;
  const maximum = typeof rule.maxLength === "number" ? rule.maxLength : Number.POSITIVE_INFINITY;

  /**
   * A `pattern` is the contract stating, in full, what it will accept — so a placeholder that
   * ignores it is this tool writing the 422 itself. It outranks the format table, and only when
   * the format's own value already satisfies it does that value win: `2024-01-01` says more than
   * a string assembled character by character.
   *
   * The generated value is checked against the real `RegExp` before it is used. `exampleFromPattern`
   * covers a subset and can be wrong; what it cannot do is slip a wrong value through.
   */
  const pattern = typeof rule.pattern === "string" ? rule.pattern : "";
  const regex = pattern ? safeRegExp(pattern) : undefined;
  if (regex) {
    if (formatted && regex.test(formatted) && formatted.length >= minimum && formatted.length <= maximum) return formatted;
    const generated = exampleFromPattern(pattern, minimum);
    if (generated !== undefined && generated.length >= minimum && generated.length <= maximum && regex.test(generated)) return generated;
    // Neither the format nor the pattern could be honoured. The placeholder below is returned
    // anyway, on purpose: a 422 naming this field is the truth about a contract this cannot
    // satisfy, and it points at the `bodies` section, which can.
  }

  if (formatted) return formatted;

  // Padded up to `minLength` and cut down to `maxLength`, in that order: a field declaring both
  // gets a value inside the range instead of one that fails the very constraint the contract
  // published.
  const padded = base.length >= minimum ? base : base.padEnd(minimum, "-");
  return padded.length <= maximum ? padded : padded.slice(0, Math.max(0, maximum));
}

/** A `pattern` arrives from somebody else's document, and `new RegExp` throws on syntax this
 * engine's own regular-expression flavour does not accept. */
function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function numberExample(rule: Schema, integer: boolean): number {
  const exclusive = typeof rule.exclusiveMinimum === "number" ? rule.exclusiveMinimum + (integer ? 1 : 0.01) : undefined;
  const minimum = typeof rule.minimum === "number" ? rule.minimum : exclusive;
  const maximum = typeof rule.maximum === "number" ? rule.maximum : undefined;

  // 1 rather than 0: an amount, a quantity or a price of zero is a valid number and a suspicious
  // payload, and plenty of contracts declare `minimum: 1` without saying so.
  let value = minimum ?? 1;
  if (maximum !== undefined && value > maximum) value = maximum;

  const step = typeof rule.multipleOf === "number" && rule.multipleOf > 0 ? rule.multipleOf : undefined;
  if (step) {
    const rounded = Math.ceil(value / step) * step;
    value = maximum !== undefined && rounded > maximum ? Math.floor(maximum / step) * step : rounded;
  }
  // Floating point: `0.1 * 3` is not `0.3`, and a body carrying `0.30000000000000004` where the
  // contract said `multipleOf: 0.1` fails a validator for a reason that has nothing to do with
  // the API.
  return integer ? Math.round(value) : Number(value.toFixed(10));
}
