/**
 * The `mock` node: an answer written by hand, and no network.
 *
 * Two reasons somebody reaches for it. The service the flow needs does not exist yet, and the rest of
 * the flow can still be built and run against what it *will* answer. Or the service exists and one
 * answer has to be pinned — the 409 that is hard to provoke, the list with exactly one element.
 *
 * What makes it worth a node and not a fixture is that the answer is an {@link ActualResponse} like
 * any other: an If, a validation, a schema, a script, a loop or a capture downstream reads it without
 * knowing it was simulated. The report is where it has to say so, and it does.
 */
import type { ActualResponse } from "./assertions.ts";
import { interpolateValue, unresolvedVariables, type ComputedSeed, type RuntimeVariables } from "./variables.ts";

/** Every `{{…}}` token, computed ones included, innermost first. */
const ANY_TOKEN = /\{\{[^{}]*\}\}/g;

/** The content type a mock declares, whatever the case of the header name. */
export function mockContentType(headers: Record<string, string> | undefined): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "content-type");
  return entry?.[1];
}

/**
 * Why a mock's body cannot be the JSON its content type promises, or null.
 *
 * Judged before the variables exist, so every `{{token}}` stands in as `0`: that keeps
 * `{"id": "{{thingId}}"}` and `{"count": {{total}}}` valid and still catches the missing brace. Only
 * a body that *declares* JSON is held to it — a mock with no content type is plain text unless its
 * body happens to parse.
 */
export function mockBodyProblem(mock: {
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}): string | null {
  const body = mock.body ?? "";
  if (!body.trim() || !mockContentType(mock.headers)?.toLowerCase().includes("json")) return null;
  let placeholder = body;
  for (let previous = ""; previous !== placeholder; ) {
    previous = placeholder;
    placeholder = placeholder.replace(ANY_TOKEN, "0");
  }
  try {
    JSON.parse(placeholder);
    return null;
  } catch {
    return "el body del mock no es JSON válido y su content-type dice JSON";
  }
}

export type SimulatedMock =
  | { ok: true; actual: ActualResponse }
  | { ok: false; missing: string[]; problem: string };

/**
 * The response a mock node gives, with its templates resolved.
 *
 * Header names are lower-cased, the way the HTTP client hands back a real answer, so a capture or a
 * check on `content-type` reads the same thing from both. With no content type, one is inferred —
 * `application/json` for a body that parses, `text/plain` otherwise — and added to the headers.
 *
 * It fails rather than answers when a template names a variable nobody defined (the same rule as a
 * `set` node: a token must not travel on as if it were data) or when the resolved body is not the
 * JSON the content type promises — a value with a quote in it is enough.
 */
export function simulateMock(
  mock: { status: number; headers?: Record<string, string> | undefined; body?: string | undefined },
  variables: RuntimeVariables,
  seed?: ComputedSeed,
): SimulatedMock {
  const headers = interpolateValue(
    Object.fromEntries(Object.entries(mock.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    variables,
    seed,
  );
  const raw = interpolateValue(mock.body ?? "", variables, seed);
  const missing = unresolvedVariables([headers, raw]);
  if (missing.length) return { ok: false, missing, problem: `Faltan variables: ${missing.join(", ")}` };

  let parsed: unknown;
  let parses = false;
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
      parses = true;
    } catch {
      parses = false;
    }
  }
  const declared = headers["content-type"];
  if (declared === undefined && raw.trim()) headers["content-type"] = parses ? "application/json" : "text/plain";
  const contentType = headers["content-type"] ?? "";
  const json = contentType.toLowerCase().includes("json");
  if (json && raw.trim() && !parses) {
    return { ok: false, missing: [], problem: "El body resuelto no es JSON válido y el content-type dice JSON" };
  }
  return {
    ok: true,
    actual: { status: mock.status, statusText: "", contentType, headers, body: json && parses ? parsed : raw, raw },
  };
}
