/**
 * The vocabulary the engine speaks, with no project in it.
 *
 * `Operation` is the flat projection of one OpenAPI operation and replaces the generated
 * `contract-operations.ts` of the coupled dashboard: there it was 46 literals compiled into the
 * bundle, here it is whatever `spec-import` read at runtime.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type Operation = {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  tag: string;
  /** The status codes the contract declares. The 401/403 matrix is generated from this. */
  statuses: number[];
  /** Parameter names, path and query alike. A name that appears in `path` as `{name}` is a
   * path parameter; the generators tell them apart that way rather than by a second field. */
  parameters: string[];
  /** The JSON Schema of the request body, dereferenced, when the contract declares one. It is
   * what lets a project with no `bodies` section still send a payload — see `example.ts`. */
  requestSchema?: unknown;
};

/** An operation plus what a project adds to it: whether it is routed, its payloads, and the
 * envelope its successful response is expected to carry. */
export type ResolvedOperation = Operation & {
  implemented: boolean;
  responseShape: string;
  body?: Record<string, unknown>;
  conflictBody?: Record<string, unknown>;
  replaceBody?: Record<string, unknown>;
};

export type ScenarioFlow =
  "request" | "create-read" | "replace-read" | "patch-read" | "delete-read" | "deleted-read" | "bulk-read";

/**
 * Which credential a case presents, which is the thing the case is testing.
 *
 * `none` sends nothing on purpose — that is the 401. `insufficient` authenticates but does not
 * reach the required scope — that is the 403. `api-key` sends a key to an operation that does
 * not declare that security scheme, which is a 401 and not a 403.
 */
export type ScenarioAuth = "default" | "none" | "insufficient" | "api-key";

export type TestScenario = {
  id: string;
  name: string;
  description: string;
  expectedStatus: number;
  parameters?: Record<string, string>;
  body?: Record<string, unknown>;
  flow: ScenarioFlow;
  auth?: ScenarioAuth;
};

export type Budget = { ms: number; label: string; source: string };

/**
 * One claim about a response, and whether it held.
 *
 * `severity` is absent on almost all of them, and absent means «error»: a claim that does not hold
 * fails the case. The exception is drift — a field the API returned that its own document does not
 * declare. That is worth saying and is not a broken endpoint, so it is reported as a warning and
 * counted by {@link holds}, which is the one place that decides what «passed» means.
 */
export type Assertion = { label: string; pass: boolean; detail: string; severity?: "error" | "warning" };

/**
 * Whose problem a red case is.
 *
 * A run of 311 cases with 40 in red is a list nobody reads, because every row costs the same to
 * triage as the last. These are the answers that make the list sortable: a `network` and a
 * `contract` are the same colour and they go to different people on different days.
 *
 * - `network` — no hubo respuesta. La API no contestó, o la guarda de red se negó a llamarla.
 * - `config` — la corrida no llegó a enviar: faltaba una variable, o el entorno prohíbe escribir.
 * - `server` — contestó 5xx. El destino se rompió, sin más que decir sobre el contrato.
 * - `status` — contestó otro estado del esperado. El caso y la API no están de acuerdo en qué
 *   tenía que pasar, y esa discusión es sobre el contrato, no sobre la forma de la respuesta.
 * - `contract` — el estado era el esperado y la forma no: el envelope, el esquema declarado, el
 *   content-type, o los campos que un POST aceptó y no guardó.
 * - `check` — una comprobación que escribió quien montó el flujo.
 * - `flow` — la respuesta llegó y el flujo no pudo sacar de ella lo que necesitaba: una captura
 *   sin su campo, un login sin su token.
 * - `latency` — el presupuesto publicado. Lo único que falla sin que nada esté *mal*.
 */
export const FAILURE_KINDS = ["network", "config", "server", "status", "contract", "check", "flow", "latency"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * Whether a list of assertions amounts to a pass.
 *
 * A single function rather than `.every((assertion) => assertion.pass)` written in four places,
 * because the four had to agree the day one of them learned about warnings — and the failure mode
 * of them not agreeing is a case reported green in one screen and red in another.
 */
export const holds = (assertions: Assertion[]): boolean =>
  assertions.every((assertion) => assertion.pass || assertion.severity === "warning");
