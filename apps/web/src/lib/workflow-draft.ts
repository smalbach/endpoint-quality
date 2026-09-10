/**
 * The logic behind the flow editor, kept out of the components.
 *
 * Same reason as `config-draft.ts`: this is the part worth asserting. A graph editor is mostly
 * invariants — an edge must not survive the node it pointed at, a step must not depend on itself,
 * a cycle must be caught before it is saved — and none of them are display concerns. Tested here,
 * with no renderer in sight.
 */
import type { RequestTemplateView, WorkflowStepView } from "@/lib/types";
import { slugId } from "@/lib/config-draft";

export type OperationSummary = { id: string; method: string; path: string; summary: string };

/** Where a new node lands: three per row, in the order they were added. */
export const positionFor = (index: number) => ({ x: 40 + (index % 3) * 310, y: 60 + Math.floor(index / 3) * 170 });

/**
 * A readable, unique step id derived from the request's name.
 *
 * Derived and not random: it travels into `run_cases.scenarioId`, so `workflow:…:crear-pedido` is
 * what somebody reads in a failed case. It also makes this function testable, which
 * `Date.now().toString(36)` was not.
 */
export const nextStepId = (templateName: string, taken: string[]): string => slugId(templateName, taken);

export function addStep(steps: WorkflowStepView[], template: RequestTemplateView): WorkflowStepView[] {
  const id = nextStepId(
    template.name,
    steps.map((step) => step.id),
  );
  return [...steps, { id, requestTemplateId: template.id, position: positionFor(steps.length) }];
}

/**
 * Removing a node removes the edges into it too.
 *
 * Leaving them behind is the state the whole document-shaped storage exists to prevent, and the
 * server would refuse the save — with a message about an id nobody typed.
 */
export function removeStep(steps: WorkflowStepView[], stepId: string): WorkflowStepView[] {
  return steps
    .filter((step) => step.id !== stepId)
    .map((step) =>
      withDependencies(
        step,
        (step.dependsOn ?? []).filter((id) => id !== stepId),
      ),
    );
}

export function connectStep(steps: WorkflowStepView[], source: string, target: string): WorkflowStepView[] {
  if (!source || !target || source === target) return steps;
  return steps.map((step) =>
    step.id === target ? withDependencies(step, [...new Set([...(step.dependsOn ?? []), source])]) : step,
  );
}

export function disconnectEdges(
  steps: WorkflowStepView[],
  removed: { source: string; target: string }[],
): WorkflowStepView[] {
  return steps.map((step) =>
    withDependencies(
      step,
      (step.dependsOn ?? []).filter(
        (source) => !removed.some((edge) => edge.source === source && edge.target === step.id),
      ),
    ),
  );
}

/** Folds what the canvas reports back into the document, so the layout is saved with the flow. */
export function applyPositions(
  steps: WorkflowStepView[],
  moved: { id: string; position: { x: number; y: number } }[],
): WorkflowStepView[] {
  const byId = new Map(moved.map((change) => [change.id, change.position]));
  return steps.map((step) => (byId.has(step.id) ? { ...step, position: byId.get(step.id)! } : step));
}

export function replaceStep(steps: WorkflowStepView[], next: WorkflowStepView): WorkflowStepView[] {
  return steps.map((step) => (step.id === next.id ? next : step));
}

export function toEdges(steps: WorkflowStepView[]) {
  return steps.flatMap((step) =>
    (step.dependsOn ?? []).map((source) => ({ id: `${source}-${step.id}`, source, target: step.id, animated: true })),
  );
}

export function toNodes(steps: WorkflowStepView[], templates: RequestTemplateView[], operations: OperationSummary[]) {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  return steps.map((step, index) => {
    const template = templateById.get(step.requestTemplateId);
    return {
      id: step.id,
      type: "step",
      // A flow authored over the API carries no coordinates; it still has to render.
      position: step.position ?? positionFor(index),
      data: {
        name: template?.name ?? "Prueba eliminada",
        expectedStatus: template?.expectedStatus ?? 0,
        method: template ? (operationById.get(template.operationId)?.method ?? "?") : "?",
        path: template ? (operationById.get(template.operationId)?.path ?? template.operationId) : "?",
        captures: step.captures?.length ?? 0,
        checks: step.checks?.length ?? 0,
        loops: Boolean(step.forEach),
        conditional: Boolean(step.runIf),
      },
    };
  });
}

/**
 * The same three things the server refuses, said before the request leaves.
 *
 * Not instead of the server's check — that one is the rule — but so the editor can point at the
 * node instead of showing a 422 about a path into a JSON document.
 */
export function problemsWith(steps: WorkflowStepView[]): string[] {
  const problems: string[] = [];
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) problems.push("Hay pasos con el mismo id.");
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) problems.push(`El paso «${step.id}» depende de sí mismo.`);
      else if (!ids.includes(dependency))
        problems.push(`El paso «${step.id}» depende de «${dependency}», que no existe.`);
    }
  }

  const pending = new Set(ids);
  while (pending.size) {
    const ready = steps.filter(
      (step) => pending.has(step.id) && (step.dependsOn ?? []).every((id) => !pending.has(id)),
    );
    if (!ready.length) {
      problems.push("El flujo tiene un ciclo: ningún paso puede empezar.");
      break;
    }
    ready.forEach((step) => pending.delete(step.id));
  }
  return problems;
}

/** `dependsOn: []` and no `dependsOn` mean the same thing, and only one of them is worth storing. */
function withDependencies(step: WorkflowStepView, dependsOn: string[]): WorkflowStepView {
  const { dependsOn: _previous, ...rest } = step;
  return dependsOn.length ? { ...rest, dependsOn } : rest;
}
