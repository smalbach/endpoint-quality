import type { RequestBody, ScenarioAuth, TestScenario, WorkflowDocument } from "@eq/runner-core";

/**
 * What a project owns beyond the generated matrix: named requests, and the graphs built from them.
 *
 * Written out rather than derived from the engine's `RequestTemplate`, because a row and a value
 * disagree about absence: a column is `null`, and the engine's optional field is absent. Deriving
 * one from the other would leave `exactOptionalPropertyTypes` arguing at every boundary;
 * converting once, where the scenario is built, is cheaper and says what it does.
 */
export type RequestTemplateRow = {
  id: string;
  projectId: string;
  name: string;
  operationId: string;
  description: string | null;
  expectedStatus: number;
  parameters: Record<string, string>;
  /**
   * The rows somebody switched off: kept, and not sent.
   *
   * A second map beside the first, exactly as an environment stores its disabled variables and for
   * the same reason — a parameter you are not sending this week is not one you want to retype next
   * week, and the only way to say so used to be deleting it. Keeping them apart means `parameters`
   * and `headers` go on meaning what a request sends, everywhere, and {@link scenarioFor} has
   * nothing to filter: the engine never learns the concept.
   */
  disabledParameters: Record<string, string>;
  /** What the contract cannot declare and the request still needs: an `X-Tenant`, an
   * `Accept-Language`, the idempotency key a POST is supposed to carry. */
  headers: Record<string, string>;
  disabledHeaders: Record<string, string>;
  /** `{ type: "none" }` is «no payload»; a `json` body of `{}` is «an empty one on purpose», and
   * the engine sends the second. */
  body: RequestBody;
  auth: ScenarioAuth;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

/** The document is the engine's own, so what was validated on write is what the orchestrator orders. */
export type WorkflowRow = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  definition: WorkflowDocument;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

/**
 * A table of values a flow is run once per row of.
 *
 * What turns «crear un producto» into «crear estos cuarenta», which is the difference between a
 * smoke test and a suite. The columns reach the steps as `{{dataset.nombre}}`, so a flow written
 * against one row works against a thousand without being edited.
 *
 * Attached to a flow rather than to the project: a dataset's columns only mean anything next to
 * the steps that spend them, and the same column name in another flow would be a coincidence
 * rather than reuse.
 */
export type DatasetRow = {
  id: string;
  projectId: string;
  workflowId: string;
  name: string;
  /** Name to value, per row. Text only, because a variable is what goes into a URL or a body. */
  rows: Record<string, string>[];
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

/**
 * An ordered list of flows run as one, with one verdict.
 *
 * The nine flows somebody runs by hand before a release, in the order they have to run in, as a
 * single row in the history. Without it «¿estaba todo verde?» is nine answers somebody has to
 * remember to collect.
 */
export type SuiteRow = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  workflowIds: string[];
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

/**
 * A saved request as the scenario the engine executes.
 *
 * Lives here, next to the row it converts, because two callers need it and they must not disagree
 * about what a template means: the orchestrator walking a flow, and the preview that sends one
 * request from the editor. An editor that built the scenario slightly differently would be a
 * second engine, and the symptom would be a request that passes on screen and fails in the run.
 *
 * The spreads are the reason this is a function and not an object literal. The row says absence
 * with an empty map and with `{ type: "none" }`; the engine says it by leaving the field out.
 *
 * The body is also the one place the conversion is not a rename. A JSON payload becomes
 * `scenario.body`, because that is the field the persistence assertion reads back field by field;
 * anything else becomes `scenario.payload`, which the executor serialises once the variables in it
 * have been substituted. **This is the single place that decides which**, which is what keeps the
 * orchestrator and the preview from disagreeing about what a saved request means.
 *
 * It takes the fields of a row and not the row, so the editor can rehearse a request that has
 * never been saved and therefore has no id, no author and no timestamps.
 */
export function scenarioFor(template: TemplateScenarioFields): TestScenario {
  return {
    id: template.id,
    name: template.name,
    description: template.description ?? "Paso de un flujo reutilizable",
    expectedStatus: template.expectedStatus,
    ...(Object.keys(template.parameters ?? {}).length ? { parameters: template.parameters } : {}),
    ...(Object.keys(template.headers ?? {}).length ? { headers: template.headers } : {}),
    ...bodyOf(template.body),
    flow: "request",
    auth: template.auth,
  };
}

/** JSON is `body`, everything else is `payload`, and «none» is neither. See {@link scenarioFor}. */
function bodyOf(body: RequestBody | null): Pick<TestScenario, "body" | "payload"> {
  if (!body || body.type === "none") return {};
  return body.type === "json" ? { body: body.json } : { payload: body };
}

export type TemplateScenarioFields = Pick<
  RequestTemplateRow,
  "id" | "name" | "description" | "expectedStatus" | "parameters" | "headers" | "body" | "auth"
>;
