/**
 * The `graphql` node: one GraphQL operation sent over HTTP, and what makes its answer a verdict.
 *
 * A GraphQL server answers most failures with a 200 and an `errors` array, so the status a fetch
 * judges by says nothing — a query against a field that does not exist is a green 200. What the
 * node adds over a fetch is exactly that reading: the operation fails when `errors` is not empty,
 * unless the author says the errors are the point (`allowErrors`, for the test that asks «¿rechaza
 * este campo?»).
 *
 * Pure on purpose: the schema, the engine and the tests share these functions, and none of them
 * needs the network to decide what a body means.
 */
import type { Assertion } from "./types.ts";

/**
 * A `graphql` node's operation.
 *
 * It always goes out as `POST` with `application/json` and `{ query, variables, operationName }`,
 * through the same path as a fetch: `url` absolute or a path hung off the environment's base URL,
 * SAFE_FETCH, the session only when `useSession` says so, and an environment that forbids writes
 * refusing it when the URL is that environment's — a `POST` is a write to the guard, whatever the
 * operation inside it reads.
 *
 * `url`, `query`, `variables` and the headers accept `{{variables}}`. `variables` is JSON **text**,
 * substituted first and parsed second, so a bare `{{count}}` can stand for a number. `expectedStatus`
 * absent means any 2xx.
 */
export type StepGraphql = {
  url: string;
  query: string;
  /** A JSON object as text, with `{{templates}}`. Absent or blank sends no variables. */
  variables?: string;
  operationName?: string;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  useSession?: boolean;
  expectedStatus?: number;
  /** A non-empty `errors` array does not fail the node. */
  allowErrors?: boolean;
};

/** GraphQL's own `Name` grammar: what an `operationName` has to be for a server to find it. */
export const GRAPHQL_OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * The variables text with every `{{template}}` replaced by something JSON accepts in its place: a
 * letter inside a string literal, `null` outside one.
 *
 * That is how the shape is checked when the document is saved, before any value exists.
 * `{"id": "{{thingId}}"}` and `{"first": {{count}}}` are both valid templates of a JSON object, and
 * `{"id": {{thingId}}` (a brace missing) is not, whatever `thingId` turns out to be. What cannot be
 * known until the run is whether the substituted text still parses — a value with a quote in it
 * inside a string — and the engine checks that again, after substituting.
 */
function withoutTemplates(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (text.startsWith("{{", index)) {
      const end = text.indexOf("}}", index + 2);
      if (end !== -1) {
        out += inString ? "x" : "null";
        index = end + 1;
        continue;
      }
    }
    if (inString && char === "\\") {
      out += char + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') inString = !inString;
    out += char;
  }
  return out;
}

function objectProblem(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "las variables de GraphQL no son JSON válido";
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? null
    : "las variables de GraphQL tienen que ser un objeto JSON";
}

/** Why a node's variables text cannot be a JSON object once its templates are filled, or null.
 * Blank is fine: the operation is sent without variables. */
export function graphqlVariablesProblem(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  return objectProblem(withoutTemplates(text));
}

/** The variables after substitution, parsed — or why they are not an object any more. */
export function parseGraphqlVariables(
  text: string | undefined,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; problem: string } {
  if (!text?.trim()) return { ok: true, value: undefined };
  const problem = objectProblem(text);
  if (problem) return { ok: false, problem: `${problem} tras sustituir las variables` };
  return { ok: true, value: JSON.parse(text) as Record<string, unknown> };
}

/** The JSON body a GraphQL-over-HTTP server expects. Absent fields are left out, not sent as null. */
export function graphqlBody(input: { query: string; variables?: Record<string, unknown>; operationName?: string }): string {
  return JSON.stringify({
    query: input.query,
    ...(input.variables ? { variables: input.variables } : {}),
    ...(input.operationName ? { operationName: input.operationName } : {}),
  });
}

/** The messages of a GraphQL response's `errors`, and whether the body is shaped like a GraphQL
 * response at all (an object with `data` or `errors`). */
export function graphqlErrors(body: unknown): { shaped: boolean; messages: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { shaped: false, messages: [] };
  const record = body as Record<string, unknown>;
  const shaped = "data" in record || "errors" in record;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const messages = errors.map((error) =>
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : JSON.stringify(error),
  );
  return { shaped, messages };
}

const SHOWN_MESSAGES = 5;
const MESSAGE_LENGTH = 200;

/**
 * The assertion a GraphQL answer adds on top of the status: no `errors`, or errors the author allowed.
 *
 * A body that is not a GraphQL response at all — an HTML error page, a proxy's JSON — fails too:
 * «sin errores» about a body with no `data` would be a pass that proves nothing ran. The detail lists
 * the messages, a handful and each cut short, because that list is the reason the case is red.
 */
export function graphqlAssertion(body: unknown, allowErrors = false): Assertion {
  const label = "Errores GraphQL";
  const { shaped, messages } = graphqlErrors(body);
  if (!shaped) return { label, pass: false, detail: "La respuesta no es de GraphQL: no trae «data» ni «errors»" };
  if (!messages.length) return { label, pass: true, detail: "Sin errores" };
  const listed = messages
    .slice(0, SHOWN_MESSAGES)
    .map((message) => (message.length > MESSAGE_LENGTH ? `${message.slice(0, MESSAGE_LENGTH)}…` : message))
    .join(" · ");
  const more = messages.length > SHOWN_MESSAGES ? ` (y ${messages.length - SHOWN_MESSAGES} más)` : "";
  const count = messages.length === 1 ? "1 error" : `${messages.length} errores`;
  return allowErrors
    ? { label, pass: true, detail: `${count} permitidos: ${listed}${more}` }
    : { label, pass: false, detail: `${count}: ${listed}${more}` };
}
