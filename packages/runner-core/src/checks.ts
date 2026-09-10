/**
 * What the author of a step claims about its response, on top of what the contract already says.
 *
 * The generated matrix asserts the things a contract can be held to: the status, the envelope, the
 * declared schema, the published budget. Those are the same for every project because they come
 * from the document. **A check is the other kind of claim** — «this list is never empty», «the
 * total equals the sum», «it answers in under 300 ms» — which nothing in an OpenAPI document
 * expresses and which is exactly what somebody building a flow wants to say.
 *
 * Pure, and separate from `assertions.ts` for one reason: those are derived, and these are
 * *written*. A derived assertion changes when the contract changes; a check changes when a person
 * decides it should, so it is stored with the step and travels with it.
 *
 * Every check produces an assertion whether it passes or not. A check that vanishes when it
 * succeeds is a check nobody can tell you ran.
 */
import type { ActualResponse } from "./assertions.ts";
import type { Assertion } from "./types.ts";
import { valueAtPath } from "./variables.ts";

/** Where the value being judged comes from. */
export const CHECK_SOURCES = ["status", "body", "header", "durationMs"] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

export const CHECK_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "less_than",
  "exists",
  "not_exists",
  "matches",
  "is_array",
  "is_not_empty",
  "has_length",
] as const;
export type CheckOperator = (typeof CHECK_OPERATORS)[number];

export type StepCheck = {
  /** What to call it in the report. Generated from the rest when it is not given, because naming
   * twelve checks by hand is how people stop writing the twelfth. */
  label?: string;
  source: CheckSource;
  /** A dot path into the JSON body, or the name of a header. Ignored by `status` and `durationMs`. */
  path?: string;
  operator: CheckOperator;
  /** The right-hand side. Absent for the operators that take none. */
  value?: unknown;
  /** `warning` records the check and does not fail the case. Absent means it fails it. */
  severity?: "error" | "warning";
};

/** What a check was actually run against: the response, plus what only the runner knows. */
export type CheckContext = { response: ActualResponse; durationMs: number };

export function evaluateChecks(checks: StepCheck[], context: CheckContext): Assertion[] {
  return checks.map((check) => evaluateCheck(check, context));
}

function evaluateCheck(check: StepCheck, context: CheckContext): Assertion {
  const actual = actualFor(check, context);
  let pass: boolean;
  try {
    pass = applyOperator(check.operator, actual, check.value);
  } catch (caught) {
    // A malformed regular expression is the author's mistake and the report is where they will see
    // it. Throwing would take the whole run down over one badly typed check.
    return {
      label: labelFor(check),
      pass: false,
      ...(check.severity ? { severity: check.severity } : {}),
      detail: caught instanceof Error ? caught.message : "La comprobación no se pudo evaluar",
    };
  }
  return {
    label: labelFor(check),
    pass,
    ...(check.severity ? { severity: check.severity } : {}),
    detail: `Obtenido ${describe(actual)}`,
  };
}

/** `where` is what the check points at, and it is half of every label and every message. */
function where(check: StepCheck): string {
  if (check.source === "status") return "status";
  if (check.source === "durationMs") return "duración";
  if (check.source === "header") return `cabecera ${check.path ?? ""}`.trim();
  return check.path ? `body.${check.path}` : "body";
}

const OPERATOR_TEXT: Record<CheckOperator, string> = {
  equals: "es",
  not_equals: "no es",
  contains: "contiene",
  not_contains: "no contiene",
  greater_than: "es mayor que",
  less_than: "es menor que",
  exists: "existe",
  not_exists: "no existe",
  matches: "cumple",
  is_array: "es una lista",
  is_not_empty: "no está vacío",
  has_length: "tiene longitud",
};

const NO_OPERAND: CheckOperator[] = ["exists", "not_exists", "is_array", "is_not_empty"];

function labelFor(check: StepCheck): string {
  if (check.label?.trim()) return check.label.trim();
  const operand = NO_OPERAND.includes(check.operator) ? "" : ` ${describe(check.value)}`;
  return `${where(check)} ${OPERATOR_TEXT[check.operator]}${operand}`;
}

function actualFor(check: StepCheck, { response, durationMs }: CheckContext): unknown {
  switch (check.source) {
    case "status":
      return response.status;
    case "durationMs":
      return durationMs;
    case "header":
      // Header names are case-insensitive by the spec and lowercased by every client that
      // normalizes them; looking under both is cheaper than making the author remember which.
      return check.path ? (response.headers[check.path.toLowerCase()] ?? response.headers[check.path]) : undefined;
    case "body":
      return check.path ? valueAtPath(response.body, check.path) : response.body;
  }
}

function applyOperator(operator: CheckOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    // Compared as text on purpose: `status equals "200"` typed into a form and `200` read off the
    // wire are the same claim, and failing it on the type of a field nobody chose is a puzzle.
    case "equals":
      return sameValue(actual, expected);
    case "not_equals":
      return !sameValue(actual, expected);
    case "contains":
      return Array.isArray(actual)
        ? actual.some((item) => sameValue(item, expected))
        : text(actual).includes(text(expected));
    case "not_contains":
      return !(Array.isArray(actual)
        ? actual.some((item) => sameValue(item, expected))
        : text(actual).includes(text(expected)));
    case "greater_than":
      return Number(actual) > Number(expected);
    case "less_than":
      return Number(actual) < Number(expected);
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "matches":
      return new RegExp(String(expected)).test(text(actual));
    case "is_array":
      return Array.isArray(actual);
    case "is_not_empty":
      return sizeOf(actual) > 0;
    case "has_length":
      return sizeOf(actual) === Number(expected);
  }
}

/** Deep for structures, textual for scalars. `"200"` and `200` are the same claim. */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
  return String(actual) === String(expected);
}

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** Length of a list or a string; the number of keys of an object. Anything else has no size. */
function sizeOf(value: unknown): number {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

/** What goes in the report. Long structures are cut: a detail line nobody can read is not one. */
function describe(value: unknown): string {
  if (value === undefined) return "nada";
  if (value === null) return "null";
  const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}
