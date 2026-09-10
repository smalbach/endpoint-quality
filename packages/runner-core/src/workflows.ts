/**
 * User-authored flows: a graph of reusable requests, where a value read from one response becomes
 * a variable the next request can spend.
 *
 * This module is the algorithm half and knows nothing about storage. A workflow and its request
 * templates are rows the API owns — not part of `ProjectConfig` — because a template is
 * referenced by several flows, and «delete it» has to be answerable by a query.
 */
import { valueAtPath, type RuntimeVariables } from "./variables.ts";
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

export type WorkflowStep = {
  id: string;
  requestTemplateId: string;
  /** The visual editor stores graph edges explicitly. Empty means this is a start node. */
  dependsOn?: string[];
  captures?: WorkflowCapture[];
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

export function applyCaptures(
  captures: WorkflowCapture[],
  response: { body: unknown; headers: Record<string, string> },
  variables: RuntimeVariables,
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
    captured.push(capture.variable);
  }
  return { captured, missing };
}
