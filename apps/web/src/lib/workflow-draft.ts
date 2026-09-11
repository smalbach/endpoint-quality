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

/**
 * The canvas's nodes, refreshed from the document without throwing away what was measured.
 *
 * React Flow keeps its own copy of each node, and it is not duplication: it stores the size it
 * measured, and a node it has not measured yet stays `visibility: hidden`. Rebuilding the array
 * from the document on every render threw that away and made the whole graph invisible, which is
 * why the carry-over exists at all.
 *
 * **What it must not carry over is the position.** That belongs to the document — it is
 * `step.position`, written on drag end and read back here — and keeping the previous node's
 * instead made switching between two flows show the wrong layout, silently, whenever they shared
 * a step id. `salud`, `crear` and `listar` are the names anybody gives those steps, so two flows
 * in the same project share them as a matter of course. And it did not stop at looking wrong:
 * dragging any node afterwards wrote the *other* flow's coordinates into this one's document.
 *
 * So: identity and measurement from the canvas, everything the document is authoritative about
 * from the document.
 */
export function mergeNodes<T extends { id: string; position: { x: number; y: number }; data: unknown }>(
  current: T[],
  fromDocument: T[],
): T[] {
  const measured = new Map(current.map((node) => [node.id, node]));
  return fromDocument.map((node) => {
    const previous = measured.get(node.id);
    return previous ? { ...previous, position: node.position, data: node.data } : node;
  });
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
        authorizes: Boolean(step.authorizes),
      },
    };
  });
}

/**
 * Every variable this step can actually spend, in the order they are worth offering.
 *
 * The environment's names first, because they are true for every step; then what the steps this
 * one depends on capture, transitively. **Only the upstream ones**, and that is the point of
 * walking the graph rather than listing every capture in the flow: a variable written by a step
 * that runs after this one, or beside it, is empty when this request goes out — offering it would
 * be the editor suggesting the bug.
 *
 * Duplicates collapse to the first occurrence, which is the environment's: a capture with the same
 * name overwrites the environment value for the rest of the run, so the two are one name and
 * showing it twice would only raise the question of which is which.
 *
 * The computed values come last and are always there. They need no environment and no upstream
 * step — `{{$uuid}}` works in a project that has never defined a variable — which is also why they
 * cannot be discovered any other way.
 */
/**
 * The computed values, offered alongside the names.
 *
 * They are the declarative answer to a pre-request script, and a feature nobody can use if nobody
 * knows it exists: there is no screen that lists them, so the `{{` menu is where they are found.
 * The two that take arguments are offered **with a sample argument in them** — `{{$base64}}` alone
 * does nothing, and a menu entry that inserts something inert teaches the wrong shape.
 *
 * Last in the list on purpose. What somebody is reaching for nine times out of ten is a variable
 * of their own, and these would otherwise sit on top of it.
 */
export const COMPUTED_VALUES = [
  "$uuid",
  "$now",
  "$now:unix",
  "$randomInt",
  "$randomInt:1:100",
  "$base64:texto",
  "$hmacSha256:clave:texto",
];

export function variablesFor(steps: WorkflowStepView[], stepId: string, environment: string[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const upstream: string[] = [];
  const seen = new Set<string>([stepId]);
  const pending = [...(byId.get(stepId)?.dependsOn ?? [])];
  while (pending.length) {
    const id = pending.shift()!;
    // A flow with a cycle cannot be saved, but it can be on screen while somebody is drawing it,
    // and a walk that revisits a node would not finish.
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (!step) continue;
    upstream.push(...(step.captures ?? []).map((capture) => capture.variable).filter(Boolean));
    pending.push(...(step.dependsOn ?? []));
  }
  return [...new Set([...environment, ...upstream, ...COMPUTED_VALUES])];
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
