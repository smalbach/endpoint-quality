/**
 * What a response has to satisfy, and why each check exists.
 *
 * This is the half of the coupled dashboard that lived inside `app/api/run/route.ts` — a single
 * 90-line function with the envelope shapes, the content types and the `/openapi.json` path
 * written into it. Here it is pure: given what was expected and what arrived, it returns the
 * assertions. No network, no framework, so the same verdicts can be produced in a test.
 *
 * The rule the whole product rests on: **a 200 is not a passing test.** Status, envelope,
 * content type, declared schema and published latency budget are separate assertions, and a case
 * passes only when every one of them that *applies* holds. The ones that do not apply produce
 * nothing at all rather than a green tick — a tick that asserts nothing is what this replaced.
 */
import { holds, type Assertion, type Budget } from "./types.ts";
import { latencyAssertion } from "./budgets.ts";
import { undeclaredPaths, validateJson } from "./json-schema.ts";

export type ActualResponse = {
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  /** Parsed when the content type says JSON, the raw string otherwise. */
  body: unknown;
  raw: string;
};

export type EvaluateInput = {
  method: string;
  operationPath: string;
  expectedStatus: number;
  /** The envelope the case expects: the project's shape for a success, its error shape for a 4xx
   * or 5xx. Only consulted where the contract declares no schema. */
  expectedShape: string;
  errorShape: string;
  actual: ActualResponse;
  /** The dereferenced schema the live document declares for this status, or `null` when it
   * declares none — which is a legitimate answer and not a failure. */
  schema: unknown | null;
  /** Why no schema was available, when that is worth telling the operator. */
  schemaDiagnostic?: string | null;
  budget: Budget | null;
  latencySamples: number[];
};

export type Evaluation = {
  ok: boolean;
  assertions: Assertion[];
  /** True when the API answered 405 to an operation the contract declares. It is its own
   * diagnosis and it suppresses the rest. */
  notImplemented: boolean;
};

/**
 * A 405 on a declared operation is a finding on its own, and it silences the others.
 *
 * Nothing downstream — envelope, schema, content type — says anything useful about a response the
 * API never produced. Reporting "envelope verificado (null)" next to it buries the one
 * actionable line under noise.
 */
const NOT_IMPLEMENTED = 405;

export function evaluateResponse(input: EvaluateInput): Evaluation {
  const { actual } = input;
  const notImplemented = actual.status === NOT_IMPLEMENTED && input.expectedStatus !== NOT_IMPLEMENTED;

  const statusMatches = actual.status === input.expectedStatus;
  const envelopeMatches = matchesShape(actual, input.expectedShape, input.errorShape);
  const contentTypeMatches = input.expectedShape === "No body" || actual.contentType.includes("json");

  const schemaErrors = input.schema === null ? null : validateJson(actual.body, input.schema);
  const schemaValid = schemaErrors === null ? null : schemaErrors.length === 0;
  // With no declared schema the envelope check is the assertion, not a fallback that always
  // passes: it is the only structural claim available for that status.
  const schemaPass = notImplemented ? false : (schemaValid ?? envelopeMatches);

  const assertions: Assertion[] = [
    {
      label: `Status ${input.expectedStatus}`,
      pass: statusMatches,
      detail: notImplemented
        ? `Recibido 405: ${input.method} ${input.operationPath} no está implementado en la API`
        : `Recibido ${actual.status}${actual.statusText ? ` ${actual.statusText}` : ""}`,
    },
    {
      label: "Schema OpenAPI",
      pass: schemaPass,
      detail: schemaDetail(input, notImplemented, schemaValid, schemaErrors),
    },
    { label: "Content-Type", pass: contentTypeMatches, detail: actual.contentType || "Sin Content-Type" },
  ];

  // The envelope check, **only when a schema was declared**, because otherwise `Schema OpenAPI`
  // above already is this check and says so in its own detail.
  //
  // It used to have no assertion at all while still counting towards the verdict, and the two
  // together produced the one thing this product exists to abolish: a red case whose every listed
  // assertion is green. `/health` is the endpoint that shows it — the contract declares a schema,
  // the response satisfies it, and the response is not the project's list envelope, so the case
  // failed and named no reason. Whoever met that had no move except to read the engine.
  if (schemaValid !== null && !notImplemented) {
    assertions.push({
      label: `Envelope ${input.expectedShape}`,
      pass: envelopeMatches,
      detail: envelopeMatches
        ? `La respuesta tiene la forma ${input.expectedShape}`
        : `La respuesta cumple el schema del contrato pero no la forma ${input.expectedShape} que este proyecto espera. Si la forma correcta es otra, la regla está en la sección envelope.`,
    });
  }

  // Drift, and only when the schema otherwise held: over a response that already failed
  // validation, «además trae campos no declarados» is noise on top of the real finding. Reported
  // as a warning because it does not make the endpoint wrong — it makes its document stale, which
  // is a different conversation with a different person.
  if (!notImplemented && schemaValid === true) {
    const undeclared = undeclaredPaths(actual.body, input.schema);
    if (undeclared.length)
      assertions.push({
        label: "Campos no declarados",
        pass: false,
        severity: "warning",
        detail: `La respuesta trae ${undeclared.length} campo(s) que el contrato no declara: ${undeclared.slice(0, 5).join(", ")}${undeclared.length > 5 ? "…" : ""}`,
      });
  }

  // No published budget means no assertion at all. The RFP sets no target for the writes, and a
  // green tick over a threshold nobody published is exactly what this replaced.
  const latency = notImplemented ? null : latencyAssertion(input.budget, input.latencySamples);
  if (latency) assertions.push(latency);

  return {
    // **Exactly "every assertion passed".** Not a parallel expression that happens to agree with
    // the list most of the time: an invariant, so a red case always carries its reason and cannot
    // stop doing so by somebody adding a term here and forgetting the assertion.
    //
    // The verdict is unchanged by writing it this way — with a declared schema the envelope is now
    // in the list, and without one `schemaPass` already *is* `envelopeMatches` — so this is
    // visibility, not leniency.
    ok: holds(assertions),
    assertions,
    notImplemented,
  };
}

/**
 * Whether the body carries the envelope the project declared.
 *
 * Deliberately shallow: it checks the shape's marker keys, not the resource inside. The schema
 * assertion is what checks the contents, and duplicating it here would report one failure twice
 * while adding a second place to get it wrong.
 */
export function matchesShape(actual: ActualResponse, expectedShape: string, errorShape: string): boolean {
  if (expectedShape === "No body") return actual.raw.length === 0;

  const isObject = typeof actual.body === "object" && actual.body !== null && !Array.isArray(actual.body);
  const record = isObject ? (actual.body as Record<string, unknown>) : null;
  if (!record) return false;

  if (expectedShape === errorShape) {
    // Problem Details, or whatever this project's error envelope is called. `title` and `status`
    // are the two RFC 9457 requires that a plain `{ "error": "..." }` will not have.
    return "status" in record && "title" in record && "type" in record;
  }
  if (expectedShape === "HealthStatus") return "status" in record && "checks" in record;
  // Everything else is "a resource under some key". The key is the project's, taken from the
  // shape string it configured: `{ data: Resource }` says `data`.
  const key = envelopeKey(expectedShape);
  return key ? key in record : true;
}

/** Reads the property name out of a shape like `{ data: [...], meta, links }`. A shape that
 * names no key — a project whose responses are bare resources — matches any object. */
export function envelopeKey(shape: string): string | null {
  const match = /^\{\s*([A-Za-z_$][\w$]*)\s*[:,}]/.exec(shape.trim());
  return match ? match[1] : null;
}

function schemaDetail(
  input: EvaluateInput,
  notImplemented: boolean,
  schemaValid: boolean | null,
  errors: string[] | null,
): string {
  if (notImplemented) return "No evaluado: la API respondió 405";
  if (input.schemaDiagnostic) return `${input.schemaDiagnostic}. Se verificó el envelope ${input.expectedShape}`;
  if (schemaValid === null)
    return `El contrato no declara ${input.expectedStatus} para esta operación; se verificó el envelope ${input.expectedShape}`;
  return schemaValid ? "JSON válido contra el schema" : (errors ?? []).join(" · ");
}

/**
 * Whether the fields a write sent actually persisted.
 *
 * The assertion that separates "the API accepted my POST" from "the API stored what I sent". An
 * endpoint that answers 201 and drops half the payload passes every check above and fails this
 * one, which is the entire point of reading the resource back.
 *
 * Compared by serialised value so `4900` and `"4900"` are a mismatch: a field that changes type
 * on the way through is a contract violation, not a formatting detail.
 */
export function verifyPersistedFields(
  received: Record<string, unknown> | undefined,
  sent: Record<string, unknown>,
): Assertion {
  const mismatches = Object.entries(sent)
    .filter(([key, value]) => JSON.stringify(received?.[key]) !== JSON.stringify(value))
    .map(([key]) => key);
  const pass = Boolean(received) && mismatches.length === 0;
  return {
    label: "Persistencia de campos",
    pass,
    detail: pass
      ? `${Object.keys(sent).length} campos coinciden con lo enviado`
      : received
        ? `No coinciden: ${mismatches.join(", ")}`
        : "La respuesta no contiene el recurso",
  };
}

/** The identifier a create returned, read out of the project's envelope. Without it the
 * read-back step has nothing to address, and the flow reports that rather than skipping it. */
export function capturedId(body: unknown, envelopeShape: string, field: string): string | undefined {
  const key = envelopeKey(envelopeShape);
  const container = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  const resource = key ? (container?.[key] as Record<string, unknown> | undefined) : container;
  const value = resource?.[field];
  return value === undefined || value === null ? undefined : String(value);
}
