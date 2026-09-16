/**
 * A Postman `test` script, read as the checks and captures it actually is.
 *
 * What people write in those scripts is a short list repeated everywhere: «el estado es 201», «el
 * cuerpo trae un id», «tardó menos de 300 ms», «guarda el id para el siguiente». All four are
 * *claims about a response* and this product already has a first-class way to say each one — a
 * {@link StepCheck} and a {@link WorkflowCapture} — which a person can read in the inspector, edit
 * without writing code, and see named one by one in the report. A script node would run the same
 * assertions and show one green line.
 *
 * So the script is translated when it can be, and **kept verbatim when it cannot**. That is the
 * rule that makes this safe to trust: this is not a JavaScript engine, and a half-understood script
 * is worse than an untouched one — it would drop the assertion nobody noticed it could not read,
 * and the flow would go green over a response nobody checked. There is no partial translation:
 * either every statement was understood, or {@link ScriptTranslation.untranslatable} says which one
 * was not and the caller wires the original code into a `script` node, where the sandbox's `pm` API
 * runs it as Postman would.
 *
 * Pure text in, plain data out. Nothing here executes a line of what it reads.
 */
import type { CheckOperator, CheckSource, StepCheck, WorkflowCapture } from "@eq/runner-core";

export type ScriptTranslation = {
  checks: StepCheck[];
  captures: WorkflowCapture[];
  /** The first statement this could not read, said in words, or null when all of it was read. */
  untranslatable: string | null;
};

/** The schema's ceiling on a step's checks. Past it the script is kept instead of truncated: a
 * check that was dropped is a claim nobody can tell you stopped making. */
const MAX_CHECKS = 50;

const UNDERSTOOD = { checks: [], captures: [], untranslatable: null } as const;

export function translatePostmanScript(code: string): ScriptTranslation {
  if (!code.trim()) return { ...UNDERSTOOD, checks: [], captures: [] };

  const units = readUnits(stripComments(code));
  if (typeof units === "string") return { checks: [], captures: [], untranslatable: units };

  const checks: StepCheck[] = [];
  const captures: WorkflowCapture[] = [];
  /**
   * The names bound to the response body, each with the path it points at.
   *
   * `jsonData`, `body`, whatever the author called it — and **what part of it**: a collection is at
   * least as likely to write `const data = pm.response.json().data` as to bind the root, and reading
   * that as «the whole body» would put every later check one level off. A path only means «into the
   * response» when it hangs off one of these names.
   */
  const bodyNames = new Map<string, string>();

  for (const unit of units) {
    const produced = { checks: 0, captures: 0 };
    for (const statement of unit.statements) {
      const read = readStatement(statement, unit.label, bodyNames);
      if (read === null) {
        return { checks: [], captures: [], untranslatable: describe(statement) };
      }
      if (read === "ignored") continue;
      if ("variable" in read) {
        captures.push(read);
        produced.captures += 1;
      } else {
        checks.push(read);
        produced.checks += 1;
      }
    }
    // A `pm.test` that produced nothing is the dangerous case: its assertions were read as noise,
    // so translating it would silently delete the only claim it made.
    if (unit.label !== null && produced.checks + produced.captures === 0) {
      return { checks: [], captures: [], untranslatable: `pm.test «${unit.label}» no declara nada reconocible` };
    }
  }

  if (checks.length > MAX_CHECKS) {
    return { checks: [], captures: [], untranslatable: `el script declara ${checks.length} comprobaciones` };
  }
  return { checks, captures, untranslatable: null };
}

const describe = (statement: string): string =>
  statement.length > 120 ? `${statement.slice(0, 120).trim()}…` : statement.trim();

// -----------------------------------------------------------------------------------------------
// Cutting the script into statements
// -----------------------------------------------------------------------------------------------

/** A `pm.test(...)` block, or the statements outside every block. `label` is the test's name, and
 * null for the loose ones — which is also what says «this is not a test» above. */
type Unit = { label: string | null; statements: string[] };

/**
 * Comments out, without touching what is inside a string.
 *
 * A `//` inside `"https://x"` is not a comment, and cutting there would turn a URL into a syntax
 * error nobody can see. Tracked character by character for that one reason.
 */
export function stripComments(code: string): string {
  let out = "";
  let quote: '"' | "'" | "`" | null = null;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += code[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && code[index + 1] === "/") {
      while (index < code.length && code[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && code[index + 1] === "*") {
      const end = code.indexOf("*/", index + 2);
      index = end === -1 ? code.length : end + 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

/** The units of a script, or the reason it could not be cut into any. */
function readUnits(code: string): Unit[] | string {
  const units: Unit[] = [];
  let rest = code;

  for (;;) {
    const at = indexOfTop(rest, /pm\s*\.\s*test\s*\(/);
    if (at === -1) {
      pushLoose(units, rest);
      return units;
    }
    pushLoose(units, rest.slice(0, at.index));

    const open = at.index + at.length - 1;
    const close = matching(rest, open);
    if (close === -1) return "un pm.test sin cerrar";
    const args = splitTop(rest.slice(open + 1, close), ",");
    const name = args[0] === undefined ? null : literalOf(args[0]);
    if (typeof name !== "string") return "un pm.test sin nombre literal";
    const callback = args.slice(1).join(",").trim();
    const body = callbackBody(callback);
    if (body === null) return `pm.test «${name}» no lleva una función que se pueda leer`;
    units.push({ label: name, statements: splitStatements(body) });
    rest = rest.slice(close + 1);
  }
}

function pushLoose(units: Unit[], chunk: string): void {
  const statements = splitStatements(chunk);
  if (statements.length) units.push({ label: null, statements });
}

/** The body of `function () { … }`, `() => { … }` or `async () => { … }`. Null for anything else —
 * a named function reference, a chained promise — which is a script this cannot read. */
function callbackBody(callback: string): string | null {
  const open = callback.indexOf("{");
  if (open === -1) return null;
  const head = callback.slice(0, open);
  if (!/^(async\s+)?(function\s*\w*\s*\([^)]*\)|\([^)]*\)\s*=>|\w+\s*=>)\s*$/.test(head.trim())) return null;
  const close = matching(callback, open);
  return close === -1 ? null : callback.slice(open + 1, close);
}

/** Where a pattern matches outside quotes and outside any bracket. */
function indexOfTop(text: string, pattern: RegExp): { index: number; length: number } | -1 {
  const source = new RegExp(pattern.source, "g");
  for (let match = source.exec(text); match; match = source.exec(text)) {
    if (depthAt(text, match.index) === 0) return { index: match.index, length: match[0].length };
  }
  return -1;
}

/** Bracket depth at an offset, quotes skipped. Recomputed from the start rather than carried, which
 * is slower and impossible to get out of step with the offset it is asked about. */
function depthAt(text: string, offset: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < offset; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
  }
  return depth;
}

/** The bracket closing the one at `open`, or -1. */
function matching(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closer = pairs[text[open]];
  if (!closer) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Splits on a separator that is outside quotes and outside every bracket. */
export function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === "\\") {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * The statements of a chunk.
 *
 * On `;` **and** on a newline, because half the scripts in the world are written without
 * semicolons. A newline inside brackets is not a break, which is what keeps a multi-line
 * `pm.expect(…)` chain in one piece.
 */
export function splitStatements(chunk: string): string[] {
  return splitTop(chunk, ";")
    .flatMap((part) => splitTop(part, "\n"))
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// -----------------------------------------------------------------------------------------------
// One statement
// -----------------------------------------------------------------------------------------------

/** What a statement turned into: a check, a capture, nothing at all, or — as `null` — a statement
 * this cannot read, which is what sends the whole script to a `script` node untouched. */
type Read = StepCheck | WorkflowCapture | "ignored" | null;

/** `pm.environment.set`, and the three other stores Postman offers. All four write a name the rest
 * of the run reads, which is exactly what a capture is; where the value is stored beyond the run is
 * a distinction this engine does not have — a capture is run-scoped, always. */
const STORES = /^pm\s*\.\s*(environment|collectionVariables|globals|variables)\s*\.\s*set$/;

/** The reason phrases people write instead of a number. Only the ones a test would assert. */
const STATUS_NAMES: Record<string, number> = {
  ok: 200,
  created: 201,
  accepted: 202,
  "no content": 204,
  "bad request": 400,
  unauthorized: 401,
  forbidden: 403,
  "not found": 404,
  "method not allowed": 405,
  conflict: 409,
  gone: 410,
  "unprocessable entity": 422,
  "too many requests": 429,
  "internal server error": 500,
  "bad gateway": 502,
  "service unavailable": 503,
};

function readStatement(statement: string, label: string | null, bodyNames: Map<string, string>): Read {
  const text = statement.trim().replace(/;+$/, "");
  if (!text) return "ignored";

  // `const jsonData = pm.response.json()`. Not a claim about anything — it is the name every later
  // path hangs off, so it is registered and dropped.
  const binding = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(text);
  if (binding) {
    const path = boundPath(binding[2], bodyNames);
    if (path === null) return null;
    bodyNames.set(binding[1], path);
    return "ignored";
  }
  // An unqualified reassignment of a name already bound to the body is the same thing again.
  const reassigned = /^([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(text);
  if (reassigned) {
    const path = boundPath(reassigned[2], bodyNames);
    if (path === null) return null;
    bodyNames.set(reassigned[1], path);
    return "ignored";
  }

  // A log line says nothing about the response. Dropped rather than refused: keeping a whole script
  // because it prints something would send almost every real collection down the script path.
  if (/^console\s*\.\s*(log|info|debug|warn|error)\s*\(/.test(text)) return "ignored";

  const call = readCall(text);
  if (call) {
    if (STORES.test(call.callee)) return readCapture(call.args, bodyNames);
    if (/^pm\s*\.\s*test$/.test(call.callee)) return null; // a nested pm.test: not read here
  }

  // `pm.response.to.have.status(…)` and `pm.response.to.have.header(…)`, which are the two
  // assertions Postman itself generates and therefore the two that appear most.
  const onResponse = /^pm\s*\.\s*response\s*\.\s*to\s*\.(.+)$/.exec(text);
  if (onResponse) return readResponseAssertion(onResponse[1], label);

  // `pm.expect(actual).to…`, the general form.
  const expect = /^pm\s*\.\s*expect\s*\(/.exec(text);
  if (expect) {
    const open = text.indexOf("(", expect[0].length - 1);
    const close = matching(text, open);
    if (close === -1) return null;
    // Chai's second argument is the message it prints, which this replaces with the test's name.
    const actual = splitTop(text.slice(open + 1, close), ",")[0]?.trim() ?? "";
    const tail = text.slice(close + 1).replace(/^\s*\./, "");
    return readExpect(actual, tail, label, bodyNames);
  }

  return null;
}

/**
 * The part of the body a binding points at, or null when it does not point at the body.
 *
 * `pm.response.json()` is the root (`""`), `pm.response.json().data` is `data`, and a name already
 * bound extends whatever it was bound to — which is how `const data = …json().data` followed by
 * `const rows = data.items` lands on `data.items`. `JSON.parse(pm.response.text())` is the same
 * root written the long way.
 */
function boundPath(expression: string, bodyNames: Map<string, string>): string | null {
  const text = expression.trim().replace(/;+$/, "");
  const parsed = /^JSON\s*\.\s*parse\s*\(\s*pm\s*\.\s*response\s*\.\s*text\s*\(\s*\)\s*\)$/.exec(text);
  return parsed ? "" : bodyPath(text, bodyNames);
}

/** A plain `callee(args)`, with the arguments split at the top level. Null when the statement is
 * not one call and nothing else. */
function readCall(text: string): { callee: string; args: string[] } | null {
  const open = text.indexOf("(");
  if (open <= 0) return null;
  const close = matching(text, open);
  if (close === -1 || text.slice(close + 1).trim() !== "") return null;
  const callee = text.slice(0, open).trim();
  if (!/^[A-Za-z_$][\w$.\s]*$/.test(callee)) return null;
  return { callee: callee.replace(/\s+/g, " "), args: splitTop(text.slice(open + 1, close), ",") };
}

/** `pm.environment.set("id", jsonData.id)` as the capture it is. */
function readCapture(args: string[], bodyNames: Map<string, string>): Read {
  const name = args[0] === undefined ? null : literalOf(args[0]);
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) return null;
  const source = args.slice(1).join(",").trim();
  if (!source) return null;

  const body = bodyPath(source, bodyNames);
  // A capture needs a path: `pm.environment.set("x", jsonData)` would store the whole body, which
  // a capture refuses on purpose (`[object Object]` in a URL is worse than a step that says so).
  if (body !== null && body !== "") return { variable: name, from: "body", path: body };

  const header = headerName(source);
  if (header) return { variable: name, from: "header", path: header };
  return null;
}

/** `pm.response.headers.get("X-Total")`, in the two spellings people write it. */
function headerName(expression: string): string | null {
  const match =
    /^pm\s*\.\s*response\s*\.\s*headers\s*\.\s*get\s*\((.+)\)$/.exec(expression.trim()) ??
    /^pm\s*\.\s*response\s*\.\s*headers\s*\.\s*get\s*\((.+)\)\s*$/.exec(expression.trim());
  if (!match) return null;
  const name = literalOf(match[1]);
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * The dot path a body expression points at, `""` for the body itself, and `null` when the
 * expression is not about the body at all.
 *
 * `jsonData.items[0].id` and `jsonData["items"][0]["id"]` are the same path, and both become
 * `items.0.id` — which is what {@link valueAtPath} walks, arrays included, because an array
 * indexed by `"0"` is still that element.
 */
export function bodyPath(expression: string, bodyNames: Map<string, string>): string | null {
  let rest = expression.trim();
  const segments: string[] = [];
  const json = /^pm\s*\.\s*response\s*\.\s*json\s*\(\s*\)/.exec(rest);
  if (json) rest = rest.slice(json[0].length);
  else {
    const head = /^([A-Za-z_$][\w$]*)/.exec(rest);
    const bound = head ? bodyNames.get(head[1]) : undefined;
    if (!head || bound === undefined) return null;
    if (bound) segments.push(...bound.split("."));
    rest = rest.slice(head[0].length);
  }
  while (rest.length) {
    const property = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (property) {
      segments.push(property[1]);
      rest = rest.slice(property[0].length);
      continue;
    }
    const indexed = /^\s*\[([^[\]]+)\]/.exec(rest);
    if (indexed) {
      const key = literalOf(indexed[1]);
      if (typeof key !== "string" && typeof key !== "number") return null;
      segments.push(String(key));
      rest = rest.slice(indexed[0].length);
      continue;
    }
    if (!rest.trim()) break;
    // Anything else — a call, an operator, `.length` arithmetic — is not a path.
    return null;
  }
  return segments.join(".");
}

/** `have.status(201)`, `have.header("X")`, `not.have.header("X")`. */
function readResponseAssertion(tail: string, label: string | null): Read {
  const tokens = splitTop(tail, ".").map((token) => token.trim());
  const negate = tokens.includes("not");
  const last = tokens[tokens.length - 1] ?? "";
  const call = /^([A-Za-z]+)\s*\((.*)\)$/.exec(last);
  if (!call) return null;
  const args = splitTop(call[2], ",").map((argument) => argument.trim());

  if (call[1] === "status") {
    if (negate) return null;
    const value = literalOf(args[0] ?? "");
    const code =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? STATUS_NAMES[value.trim().toLowerCase()]
          : undefined;
    if (code === undefined) return null;
    return withLabel({ source: "status", operator: "equals", value: code }, label);
  }
  if (call[1] === "header") {
    const name = literalOf(args[0] ?? "");
    if (typeof name !== "string" || !name.trim()) return null;
    if (args.length > 1) {
      const expected = literalOf(args[1]);
      if (expected === undefined) return null;
      return withLabel(
        { source: "header", path: name.trim(), operator: negate ? "not_equals" : "equals", value: expected },
        label,
      );
    }
    return withLabel({ source: "header", path: name.trim(), operator: negate ? "not_exists" : "exists" }, label);
  }
  return null;
}

/** Where the value being judged comes from, when this can tell. */
function subjectOf(actual: string, bodyNames: Map<string, string>): { source: CheckSource; path?: string } | null {
  const text = actual.trim();
  if (/^pm\s*\.\s*response\s*\.\s*(code|status|statusCode)$/.test(text)) return { source: "status" };
  if (/^pm\s*\.\s*response\s*\.\s*responseTime$/.test(text)) return { source: "durationMs" };
  if (/^pm\s*\.\s*response\s*\.\s*text\s*\(\s*\)$/.test(text)) return { source: "body" };
  const header = headerName(text);
  if (header) return { source: "header", path: header };
  const path = bodyPath(text, bodyNames);
  if (path === null) return null;
  return path ? { source: "body", path } : { source: "body" };
}

/** Tokens a chain carries that say nothing about what is being asserted. */
const NOISE = new Set([
  "to",
  "be",
  "been",
  "is",
  "that",
  "which",
  "and",
  "has",
  "have",
  "with",
  "deep",
  "own",
  "still",
]);

const OPERATORS: Record<string, { operator: CheckOperator; argument: boolean }> = {
  equal: { operator: "equals", argument: true },
  equals: { operator: "equals", argument: true },
  eql: { operator: "equals", argument: true },
  eqls: { operator: "equals", argument: true },
  include: { operator: "contains", argument: true },
  includes: { operator: "contains", argument: true },
  contain: { operator: "contains", argument: true },
  contains: { operator: "contains", argument: true },
  above: { operator: "greater_than", argument: true },
  greaterThan: { operator: "greater_than", argument: true },
  gt: { operator: "greater_than", argument: true },
  below: { operator: "less_than", argument: true },
  lessThan: { operator: "less_than", argument: true },
  lt: { operator: "less_than", argument: true },
  length: { operator: "has_length", argument: true },
  lengthOf: { operator: "has_length", argument: true },
  match: { operator: "matches", argument: true },
  exist: { operator: "exists", argument: false },
  undefined: { operator: "not_exists", argument: false },
};

/** What a `not` in the chain turns each operator into. The ones missing have no negation this can
 * express, and a check that means the opposite of what was written is the one outcome worth
 * refusing the whole script over. */
const NEGATED: Partial<Record<CheckOperator, CheckOperator>> = {
  equals: "not_equals",
  not_equals: "equals",
  contains: "not_contains",
  not_contains: "contains",
  exists: "not_exists",
  not_exists: "exists",
};

function readExpect(actual: string, tail: string, label: string | null, bodyNames: Map<string, string>): Read {
  const subject = subjectOf(actual, bodyNames);
  if (!subject) return null;

  const tokens = splitTop(tail, ".")
    .map((token) => token.trim())
    .filter(Boolean);
  const negate = tokens.includes("not");
  const significant = tokens.filter((token) => token !== "not" && !NOISE.has(token));
  if (significant.length !== 1) return null;
  const token = significant[0];
  const call = /^([A-Za-z]+)\s*\((.*)\)$/.exec(token);
  const name = call ? call[1] : token;
  const args = call ? splitTop(call[2], ",").map((argument) => argument.trim()) : [];

  // `to.be.true` / `to.be.false` — a claim about the value and not about its existence.
  if (name === "true" || name === "false") {
    const operator: CheckOperator = negate ? "not_equals" : "equals";
    return withLabel({ ...subject, operator, value: name === "true" }, label);
  }
  // `to.not.be.empty` is «trae algo»; `to.be.empty` has no operator here, and guessing one
  // backwards is exactly the mistake this refuses to make.
  if (name === "empty") {
    return negate ? withLabel({ ...subject, operator: "is_not_empty" }, label) : null;
  }
  // `to.be.an("array")`. Any other type name is a claim this cannot express.
  if (name === "a" || name === "an") {
    const type = literalOf(args[0] ?? "");
    if (negate || typeof type !== "string" || type.trim().toLowerCase() !== "array") return null;
    return withLabel({ ...subject, operator: "is_array" }, label);
  }
  // `to.have.property("id")` — the path of the check grows by the property being asserted.
  if (name === "property") {
    const property = literalOf(args[0] ?? "");
    if (typeof property !== "string" || !property.trim()) return null;
    if (subject.source !== "body") return null;
    const path = [subject.path, property.trim()].filter(Boolean).join(".");
    if (args.length > 1) {
      const expected = literalOf(args[1]);
      if (expected === undefined) return null;
      return withLabel({ source: "body", path, operator: negate ? "not_equals" : "equals", value: expected }, label);
    }
    return withLabel({ source: "body", path, operator: negate ? "not_exists" : "exists" }, label);
  }

  const known = OPERATORS[name];
  if (!known) return null;
  const operator = negate ? NEGATED[known.operator] : known.operator;
  if (!operator) return null;
  if (!known.argument) return withLabel({ ...subject, operator }, label);

  // `to.match(/^ORD-/)` carries a regular expression rather than a value.
  if (known.operator === "matches") {
    const pattern = regexOf(args[0] ?? "");
    if (pattern === null) return null;
    return withLabel({ ...subject, operator, value: pattern }, label);
  }
  const value = literalOf(args[0] ?? "");
  if (value === undefined) return null;
  return withLabel({ ...subject, operator, value }, label);
}

/** The test's name becomes the check's label, which is what the report shows. A loose assertion
 * has none, and `labelFor` in the engine writes one from the check itself. */
function withLabel(check: Omit<StepCheck, "label">, label: string | null): StepCheck {
  return label?.trim() ? { label: label.trim().slice(0, 120), ...check } : check;
}

/**
 * A literal as its value, `undefined` for anything that is not one.
 *
 * `undefined` rather than a `{ ok }` wrapper because a check's `value` is never legitimately
 * `undefined` — every operator that takes one takes something. An expression, a variable, a
 * template string with a `${}` in it: all are «not a literal», and all send the script to a
 * `script` node where they still work.
 */
export function literalOf(text: string): unknown {
  const value = text.trim();
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^"([^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  // A JSON array or object literal — `to.eql([])`, `to.eql({ a: 1 })` written as JSON. Parsed
  // rather than pattern-matched: a literal this cannot parse is one it must not guess at.
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (/^'([^'\\]|\\.)*'$/.test(value) || /^`([^`\\$]|\\.)*`$/.test(value)) {
    try {
      return JSON.parse(`"${value.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A `/pattern/flags` literal as its source, or a quoted string as itself. Null otherwise. The
 * flags are dropped: a check's `matches` compiles the source with none, and claiming otherwise
 * would be a check that does not mean what it says. */
function regexOf(text: string): string | null {
  const value = text.trim();
  const literal = /^\/(.+)\/[a-z]*$/s.exec(value);
  if (literal) {
    try {
      new RegExp(literal[1]);
      return literal[1];
    } catch {
      return null;
    }
  }
  const quoted = literalOf(value);
  if (typeof quoted !== "string") return null;
  try {
    new RegExp(quoted);
    return quoted;
  } catch {
    return null;
  }
}
