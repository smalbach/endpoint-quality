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

export type Assertion = { label: string; pass: boolean; detail: string };
