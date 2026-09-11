/**
 * User-authored flows: a graph of reusable requests, where a value read from one response becomes
 * a variable the next request can spend.
 *
 * This module is the algorithm half and knows nothing about storage. A workflow and its request
 * templates are rows the API owns — not part of `ProjectConfig` — because a template is
 * referenced by several flows, and «delete it» has to be answerable by a query.
 */
import { valueAtPath, type RuntimeVariables } from "./variables.ts";
import type { StepCheck } from "./checks.ts";
import type { ScenarioAuth } from "./types.ts";

/**
 * A reusable request. Flows reference it by id, so changing a payload or an expectation updates
 * every flow that uses it instead of leaving copied steps behind.
 */
export type RequestTemplate = {
  id: string;
  name: string;
  operationId: string;
  description?: string;
  expectedStatus: number;
  parameters?: Record<string, string>;
  body?: Record<string, unknown>;
  auth?: ScenarioAuth;
};

export type WorkflowCapture = {
  variable: string;
  /** Dot path into the JSON body, or a response header name. */
  from: "body" | "header";
  path: string;
};

/**
 * What to do when a step does not pass.
 *
 * `skip-dependents` is the default and the honest one: «create failed, therefore read failed» is
 * one finding reported twice, so what depends on a failure is not attempted.
 *
 * `continue` is for the step whose failure the rest of the flow does not actually depend on — a
 * cleanup that 404s because there was nothing to clean, a metrics call nobody reads. The case is
 * still red; what changes is that its dependents run anyway.
 *
 * `stop` ends the flow there. For the step that leaves the target in a state the remaining ones
 * would report nonsense against: with no session, every later 401 is one fact restated.
 */
export const STEP_ON_ERROR = ["skip-dependents", "continue", "stop"] as const;
export type StepOnError = (typeof STEP_ON_ERROR)[number];

/**
 * Repeating a step that failed.
 *
 * Off unless asked for, and deliberately awkward to switch on for everything: **a retry is a
 * claim that the failure was not real**, and a suite that retries by default reports a flaky
 * target as a healthy one. It exists because some failures genuinely are not — a cold start, a
 * rate limiter, a queue that has not caught up — and re-running the whole suite by hand to find
 * out is worse.
 *
 * `onStatus` is the guard that keeps it honest: with it, only the answers listed are retried, so a
 * 500 can be retried while a 422 — which will never stop being a 422 — is reported the first time.
 * **A step that writes and is retried without `onStatus` will write twice.**
 */
export type StepRetry = {
  /** Extra attempts after the first. `2` means up to three requests in total. */
  attempts: number;
  /** Wait before the first retry. */
  delayMs: number;
  /** Multiplies the wait after each attempt. `1` keeps it constant. */
  backoff?: number;
  /** Only retry these response statuses. Empty or absent retries any failure. */
  onStatus?: number[];
};

/**
 * Whether this step runs at all, decided by something a previous one answered.
 *
 * The reason it is a property of the step and not a node of its own: a condition node has no
 * request, and every other thing a run records — a case, its steps, its timings, its verdict — is
 * about a request that was made. A node that produces a case with no HTTP in it would be a row
 * that means something different from every other row in the table.
 *
 * `from` has to be a dependency. That is not a formality: without the edge there is no guarantee
 * the step it names has answered yet, and a condition over a response that does not exist would
 * quietly read as false.
 */
export type StepCondition = {
  /** The step whose response decides. Must be in `dependsOn`. */
  from: string;
  check: StepCheck;
};

/**
 * Running one step once per element of a list a previous step returned.
 *
 * Each element is its own case, with its own request, response and verdict — «los 40 productos
 * del catálogo responden» is forty findings, not one, and a single case hiding thirty-nine
 * results is exactly the report this product exists to replace.
 *
 * `max` is not optional in spirit: the list comes from the target, so without a ceiling the size
 * of a run is decided by whoever is being tested.
 */
export type StepForEach = {
  /** The step whose response carries the list. Must be in `dependsOn`. */
  from: string;
  /** Dot path to the array inside that response's body, for example `data`. */
  path: string;
  /** What each element is bound to. An object binds field by field as well: `item.id`. */
  as: string;
  /** Hard ceiling on iterations. */
  max?: number;
};

export type WorkflowStep = {
  id: string;
  requestTemplateId: string;
  /** Wait before this step, in milliseconds. For the target that accepts a write and takes a
   * moment to make it readable — a retry says «that failure was not real», and this says «it was
   * not time yet», which are different claims about the same target. */
  waitMs?: number;
  runIf?: StepCondition;
  forEach?: StepForEach;
  /** The visual editor stores graph edges explicitly. Empty means this is a start node. */
  dependsOn?: string[];
  captures?: WorkflowCapture[];
  /** What this step's author claims about the response, beyond what the contract already says. */
  checks?: StepCheck[];
  retry?: StepRetry;
  onError?: StepOnError;
  /** Where the node sits on the canvas. **The engine never reads it** — it is stored beside the
   * step and not in a table of its own because a node and its coordinates are created, moved and
   * deleted together, and two places is one more way to orphan one. */
  position?: { x: number; y: number };
};

/** The whole graph, written as one unit. Its name and description live in the row that holds it. */
export type WorkflowDocument = { steps: WorkflowStep[] };

/** Stable topological ordering: independent nodes retain their order from the document. */
export function orderWorkflowSteps(workflow: WorkflowDocument, label = "el flujo"): WorkflowStep[] {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const pending = new Set(workflow.steps.map((step) => step.id));
  const ordered: WorkflowStep[] = [];
  while (pending.size) {
    const ready = workflow.steps.filter(
      (step) => pending.has(step.id) && (step.dependsOn ?? []).every((id) => !pending.has(id) && byId.has(id)),
    );
    if (!ready.length) throw new Error(`${label} contiene dependencias cíclicas o inexistentes`);
    for (const step of ready) {
      pending.delete(step.id);
      ordered.push(step);
    }
  }
  return ordered;
}

/**
 * The environment's variables, also reachable under `env.`.
 *
 * Namespaces without a resolver: `{{env.baseId}}` is just another name in the same flat map, and
 * the substitution that already existed finds it. That is the whole implementation, and it is the
 * reason the engine did not have to learn a second syntax — a name with a dot in it was always a
 * legal name.
 *
 * What the prefix buys is the one thing the flat map could not say: **where a value came from**.
 * In a flow of nine steps, `{{userId}}` might be the environment's or a capture from the second
 * step, and the two behave differently when a run is repeated. `{{env.userId}}` cannot be either
 * one by accident.
 */
export function withEnvironmentNamespace(variables: RuntimeVariables): RuntimeVariables {
  return {
    ...variables,
    ...Object.fromEntries(Object.entries(variables).map(([name, value]) => [`env.${name}`, value])),
  };
}

/**
 * Binds one element of a looped list.
 *
 * An object binds field by field — `item.id`, `item.name` — because that is what a step does with
 * it, and the whole element is bound to the bare name as JSON for the request that wants the lot.
 * A nested object under a field is not flattened further: two levels is the depth a request body
 * template actually uses, and every level after that is a path nobody can read.
 */
export function bindElement(as: string, element: unknown): RuntimeVariables {
  if (element === null || element === undefined) return { [as]: "" };
  if (typeof element !== "object") return { [as]: String(element) };
  const bound: RuntimeVariables = { [as]: JSON.stringify(element) };
  if (Array.isArray(element)) return bound;
  for (const [key, value] of Object.entries(element as Record<string, unknown>)) {
    if (value !== null && typeof value === "object") continue;
    bound[`${as}.${key}`] = value === null || value === undefined ? "" : String(value);
  }
  return bound;
}

/**
 * How much of a list a loop may actually walk.
 *
 * Two ceilings, and they say different things. `max` is the author's — «no more than fifty of
 * these, whatever the target returns» — and it is part of the flow. `extra` is the run's: every
 * limit in this product is local (rows in a dataset, flows in a suite, elements in a loop) and
 * they **multiply**, so something has to hold the total, and the total is only knowable while
 * walking because the list is as long as the target decided.
 *
 * The step's own case is already counted, so a loop of N costs N-1 more — which is why a list of
 * one is never truncated, even with no budget left at all.
 *
 * `dropped` is returned rather than swallowed: a loop that quietly walks nine of forty is a report
 * that is wrong about the target, and the whole product is an argument against those.
 */
export function withinBudget(list: unknown[], max: number, extra: number): { elements: unknown[]; dropped: number } {
  const wanted = list.slice(0, max);
  const allowed = wanted.length <= 1 ? wanted.length : Math.min(wanted.length, 1 + Math.max(0, extra));
  return { elements: wanted.slice(0, allowed), dropped: wanted.length - allowed };
}

/** The array a loop walks, or `null` when the path does not lead to one. */
export function listAt(body: unknown, path: string): unknown[] | null {
  const found = valueAtPath(body, path);
  return Array.isArray(found) ? found : null;
}

export function applyCaptures(
  captures: WorkflowCapture[],
  response: { body: unknown; headers: Record<string, string> },
  variables: RuntimeVariables,
  /** The step doing the capturing. Given, the value is also published as `<stepId>.<name>`, which
   * is what lets a later step say which answer it means when two steps capture the same name. */
  stepId?: string,
): { captured: string[]; missing: string[] } {
  const captured: string[] = [];
  const missing: string[] = [];
  for (const capture of captures) {
    const value =
      capture.from === "body"
        ? valueAtPath(response.body, capture.path)
        : (response.headers[capture.path.toLowerCase()] ?? response.headers[capture.path]);
    // An object is `missing` on purpose: a variable is text that goes into a URL or a body, and
    // `[object Object]` in a request path is a worse outcome than a step that says what it lacked.
    if (value === undefined || value === null || typeof value === "object") {
      missing.push(capture.variable);
      continue;
    }
    variables[capture.variable] = String(value);
    if (stepId) variables[`${stepId}.${capture.variable}`] = String(value);
    captured.push(capture.variable);
  }
  return { captured, missing };
}
