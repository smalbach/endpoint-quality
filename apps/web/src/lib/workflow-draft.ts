/**
 * The logic behind the flow editor, kept out of the components.
 *
 * Same reason as `config-draft.ts`: this is the part worth asserting. A graph editor is mostly
 * invariants — an edge must not survive the node it pointed at, a step must not depend on itself,
 * a cycle must be caught before it is saved — and none of them are display concerns. Tested here,
 * with no renderer in sight.
 */
import type {
  CaseStatus,
  WorkflowCaptureView,
  RequestTemplateView,
  WorkflowStatusView,
  WorkflowStepView,
} from "@/lib/types";
import { slugId } from "@/lib/config-draft";

export type OperationSummary = { id: string; method: string; path: string; summary: string };

/** The three states a flow can be in, with the badge each one wears. Kept here so the list, the
 * inspector and the suites panel all say «archivado» the same colour. */
export const WORKFLOW_STATUS_META: Record<WorkflowStatusView, { label: string; badge: string; dot: string }> = {
  draft: { label: "Borrador", badge: "bg-amber-50 text-amber-700 ring-amber-200", dot: "bg-amber-400" },
  ready: { label: "Listo", badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  archived: { label: "Archivado", badge: "bg-slate-100 text-slate-500 ring-slate-200", dot: "bg-slate-300" },
};

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
 * A copy of one node: same request and same behaviours, a fresh id, and no edges.
 *
 * No edges on purpose. A duplicate is «another one of these», not «this, wired in where that was» —
 * copying `dependsOn` would attach the new node to a graph it was never placed in, and copying the
 * nodes that depend on the original would silently fan them out to two. So it lands unconnected, a
 * short drag from its source, for the person to wire where they mean. Its captures come with it as
 * they are: two steps writing the same variable is a real footgun, but it is the honest copy, and
 * the inspector is where the second name gets changed.
 */
export function duplicateStep(steps: WorkflowStepView[], stepId: string): WorkflowStepView[] {
  const source = steps.find((step) => step.id === stepId);
  if (!source) return steps;
  const id = nextStepId(
    source.id.replace(/-\d+$/, ""),
    steps.map((step) => step.id),
  );
  const at = source.position ?? positionFor(steps.length);
  const clone: WorkflowStepView = { ...source, id, position: { x: at.x + 48, y: at.y + 48 } };
  delete clone.dependsOn;
  return [...steps, clone];
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

export function toNodes(
  steps: WorkflowStepView[],
  templates: RequestTemplateView[],
  operations: OperationSummary[],
  runStatus?: Record<string, CaseStatus>,
) {
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
        // Set only while a run is being watched; the node lights up by it.
        runStatus: runStatus?.[step.id],
      },
    };
  });
}

/**
 * Which node is doing what, from the cases of a live run.
 *
 * A run case carries a `scenarioId` of `workflow:<flow>:<stepId>` — plus a `#suffix` per dataset row
 * or loop element — so one node can own several cases at once. It shows the most eventful of them:
 * anything running makes the node running, then a failure, then still-queued, then passed, and
 * skipped last. That order is what makes the canvas read as «this one now, that one broke».
 */
const STATUS_RANK: Record<CaseStatus, number> = { running: 4, failed: 3, queued: 2, passed: 1, skipped: 0 };

export function flowNodeStatuses(cases: { scenarioId: string; status: CaseStatus }[]): Record<string, CaseStatus> {
  const byStep: Record<string, CaseStatus> = {};
  for (const runCase of cases) {
    const parts = runCase.scenarioId.split(":");
    if (parts[0] !== "workflow" || parts.length < 3) continue;
    const stepId = parts[2].split("#")[0];
    const current = byStep[stepId];
    if (!current || STATUS_RANK[runCase.status] > STATUS_RANK[current]) byStep[stepId] = runCase.status;
  }
  return byStep;
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

/** A path segment worth turning into a variable name: the last one that is not an array index. */
const namePart = (path: string): string => {
  const parts = path.split(".").filter((part) => !/^\d+$/.test(part));
  return parts[parts.length - 1] ?? path.replace(/\./g, "_");
};

/** Keys that are almost always what somebody captures — an id to read back, a token to present. */
const INTERESTING = /(^|[._])(id|ids|token|access[_-]?token|jwt|uuid|guid|key|slug|code|sku|ref|email|name)($|[._])/i;

/**
 * The captures a response suggests, from a real body.
 *
 * The alternative is what the reference tool made ordinary: send the request in a terminal, read
 * the JSON, and type `data.items.0.id` into a box by hand — a path is exactly the kind of string
 * that is wrong by one segment and fails on the third case, not the first. Here the body it already
 * got back is walked, every scalar leaf becomes a candidate `{{variable}}` with its path filled in,
 * and the ones that look like an id or a token are offered first because they are what a next step
 * spends. Arrays descend through their first element (`items.0.id`), which is a path the engine's
 * `valueAtPath` reads. Pure, so it is tested without a network: a body in, candidates out.
 */
export function suggestCaptures(sample: unknown, existing: string[] = []): WorkflowCaptureView[] {
  const taken = new Set(existing);
  const out: { capture: WorkflowCaptureView; interesting: boolean }[] = [];
  const seenPaths = new Set<string>();

  const walk = (value: unknown, path: string, depth: number) => {
    if (out.length >= 40 || depth > 5) return;
    if (Array.isArray(value)) {
      if (value.length) walk(value[0], path ? `${path}.0` : "0", depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
      }
      return;
    }
    // A scalar leaf, and only these become captures — a capture reads one value, not an object.
    if (!path || seenPaths.has(path)) return;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    seenPaths.add(path);
    const base = namePart(path);
    let variable = base;
    for (let n = 2; taken.has(variable); n += 1) variable = `${base}${n}`;
    taken.add(variable);
    out.push({ capture: { variable, from: "body", path }, interesting: INTERESTING.test(path) });
  };

  walk(sample, "", 0);
  // Interesting leaves first, order preserved within each group; capped so the list stays a menu.
  return [...out]
    .sort((a, b) => Number(b.interesting) - Number(a.interesting))
    .slice(0, 15)
    .map((item) => item.capture);
}

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

/** A problem, and the node it is about — so the validation panel can jump to it. Some problems
 * (a duplicate id, a cycle) are about the graph and not one node, and carry no `stepId`. */
export type FlowProblem = { message: string; stepId?: string };

/**
 * The same three things the server refuses, said before the request leaves.
 *
 * Not instead of the server's check — that one is the rule — but so the editor can point at the
 * node instead of showing a 422 about a path into a JSON document. Each carries the node it is
 * about where there is one, so the panel is a list of «ir al nodo» and not just a list of text.
 */
export function flowProblems(steps: WorkflowStepView[]): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) problems.push({ message: "Hay pasos con el mismo id." });
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id)
        problems.push({ message: `El paso «${step.id}» depende de sí mismo.`, stepId: step.id });
      else if (!ids.includes(dependency))
        problems.push({ message: `El paso «${step.id}» depende de «${dependency}», que no existe.`, stepId: step.id });
    }
  }

  const pending = new Set(ids);
  while (pending.size) {
    const ready = steps.filter(
      (step) => pending.has(step.id) && (step.dependsOn ?? []).every((id) => !pending.has(id)),
    );
    if (!ready.length) {
      problems.push({ message: "El flujo tiene un ciclo: ningún paso puede empezar." });
      break;
    }
    ready.forEach((step) => pending.delete(step.id));
  }
  return problems;
}

/** The messages alone. Kept for the callers that only need «is it valid» and a list of strings. */
export function problemsWith(steps: WorkflowStepView[]): string[] {
  return flowProblems(steps).map((problem) => problem.message);
}

/** `dependsOn: []` and no `dependsOn` mean the same thing, and only one of them is worth storing. */
function withDependencies(step: WorkflowStepView, dependsOn: string[]): WorkflowStepView {
  const { dependsOn: _previous, ...rest } = step;
  return dependsOn.length ? { ...rest, dependsOn } : rest;
}
