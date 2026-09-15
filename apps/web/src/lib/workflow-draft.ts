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
 * `at`, or the first spot below it with no node already there. Without it a second If off the same
 * request lands exactly on the first, and the canvas going to it shows nothing new.
 */
export function freeSpot(steps: WorkflowStepView[], at: { x: number; y: number }): { x: number; y: number } {
  const occupied = steps.map((step, index) => step.position ?? positionFor(index));
  const taken = (spot: { x: number; y: number }) =>
    occupied.some((other) => Math.abs(other.x - spot.x) < 280 && Math.abs(other.y - spot.y) < 130);
  let spot = at;
  for (let tries = 0; tries < 50 && taken(spot); tries++) spot = { x: at.x, y: spot.y + 150 };
  return spot;
}

/**
 * A readable, unique step id derived from the request's name.
 *
 * Derived and not random: it travels into `run_cases.scenarioId`, so `workflow:…:crear-pedido` is
 * what somebody reads in a failed case. It also makes this function testable, which
 * `Date.now().toString(36)` was not.
 */
export const nextStepId = (templateName: string, taken: string[]): string => slugId(templateName, taken);

/**
 * How many steps point at one reusable request — this flow's steps plus every other flow's.
 *
 * A request is shared on purpose: two flows that both create a widget name the same row. But that
 * is also why editing a node's request from the inspector changes every node that shares it, and a
 * person building a CRUD flow out of «leer» duplicated four times does not mean «change all four».
 * So the inspector counts the uses first, and forks a private copy before an edit when there is
 * more than one — {@link uniqueTemplateName} names it. Counted across all flows, and taking the
 * current flow from the live draft rather than its saved copy, so a second node added this sitting
 * is seen before the flow is saved.
 */
export function templateUsage(
  draftSteps: { requestTemplateId?: string }[],
  allFlows: { id: string; steps: { requestTemplateId?: string }[] }[],
  currentFlowId: string,
  templateId: string,
): number {
  const here = draftSteps.filter((step) => step.requestTemplateId === templateId).length;
  const elsewhere = allFlows
    .filter((flow) => flow.id !== currentFlowId)
    .reduce((total, flow) => total + flow.steps.filter((step) => step.requestTemplateId === templateId).length, 0);
  return here + elsewhere;
}

/** A name for a forked request that the project's unique `(projectId, name)` index will accept. */
export function uniqueTemplateName(base: string, taken: string[]): string {
  const set = new Set(taken);
  const trimmed = base.replace(/ \(copia\)( \d+)?$/, "");
  let candidate = `${trimmed} (copia)`.slice(0, 120);
  let n = 2;
  while (set.has(candidate)) candidate = `${trimmed} (copia) ${n++}`.slice(0, 120);
  return candidate;
}

/** A name not already taken, suffixing « 2», « 3»… only on collision. Unlike
 * {@link uniqueTemplateName} it does not brand the result a copy: it is what a request gets when it
 * is first added from an operation, where the plain name is the right one. */
export function uniqueName(base: string, taken: string[]): string {
  const set = new Set(taken);
  const trimmed = base.slice(0, 120);
  if (!set.has(trimmed)) return trimmed;
  let n = 2;
  let candidate = `${trimmed} ${n}`.slice(0, 120);
  while (set.has(candidate)) candidate = `${trimmed} ${++n}`.slice(0, 120);
  return candidate;
}

export function addStep(steps: WorkflowStepView[], template: RequestTemplateView): WorkflowStepView[] {
  const id = nextStepId(
    template.name,
    steps.map((step) => step.id),
  );
  return [...steps, { id, requestTemplateId: template.id, position: freeSpot(steps, positionFor(steps.length)) }];
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
  // A copy has no edges, so it is on no branch either — its side is decided when it is rewired.
  delete clone.branch;
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
    .map((step) => {
      const trimmed = withDependencies(
        step,
        (step.dependsOn ?? []).filter((id) => id !== stepId),
      );
      // A node that hung off the removed branch is no longer on any side of it: drop the membership
      // so it does not point at a node that is gone.
      let next = trimmed;
      if (next.branch?.of === stepId) {
        const { branch: _branch, ...rest } = next;
        next = rest;
      }
      // A control node that read the removed step now reads nothing: clear its `from` so the
      // document stays valid — the editor asks for it to be reconnected rather than the server 422.
      if (next.condition?.from === stepId) next = { ...next, condition: { ...next.condition, from: "" } };
      if (next.validate?.from === stepId) next = { ...next, validate: { ...next.validate, from: "" } };
      if (next.script?.from === stepId) next = { ...next, script: { code: next.script.code } };
      return next;
    });
}

export function connectStep(
  steps: WorkflowStepView[],
  source: string,
  target: string,
  handle?: string | null,
): WorkflowStepView[] {
  if (!source || !target || source === target) return steps;
  const branching = (steps.find((step) => step.id === source)?.kind ?? "request") === "branch";
  const take = handle === "then" || handle === "else" ? handle : undefined;
  return steps.map((step) => {
    if (step.id !== target) return step;
    const linked = withDependencies(step, [...new Set([...(step.dependsOn ?? []), source])]);
    // A wire from a branch handle also records which side of it the target sits on.
    if (branching && take) return { ...linked, branch: { of: source, take } };
    // A control node that reads a step —a branch or a validate— wires its `from` to whatever was
    // just connected into it, unless it already reads one. This is what «suelta el nodo y conéctalo
    // para configurarlo» means: the edge is the configuration, not a field typed by hand.
    if ((linked.kind ?? "request") === "branch" && !linked.condition?.from) {
      const check = linked.condition?.check ?? { source: "status", operator: "equals", value: "200" };
      return { ...linked, condition: { from: source, check } };
    }
    if (linked.kind === "validate" && !linked.validate?.from) {
      return { ...linked, validate: { ...linked.validate, from: source } };
    }
    if (linked.kind === "script" && !linked.script?.from) {
      return { ...linked, script: { code: linked.script?.code ?? "", from: source } };
    }
    return linked;
  });
}

/** The control kinds the palette offers as standalone nodes, and how each reads on the canvas. The
 * two that make a request —request and login— are added from the operation catalogue, not here. */
export const CONTROL_PALETTE: { kind: ControlKind; glyph: string; label: string; hint: string }[] = [
  { kind: "branch", glyph: "◇", label: "If", hint: "Lee un paso y parte el flujo en «sí» y «no»" },
  { kind: "wait", glyph: "⏱", label: "Espera", hint: "Pausa antes de dejar pasar el flujo" },
  { kind: "merge", glyph: "⇉", label: "Merge", hint: "Junta varias ramas en una" },
  { kind: "validate", glyph: "✓", label: "Validación", hint: "Juzga la respuesta de un paso con checks o un script" },
  { kind: "fetch", glyph: "⇄", label: "Fetch", hint: "Petición HTTP escrita a mano: cualquier URL, método, cabeceras y body" },
  { kind: "set", glyph: "𝑥", label: "Set", hint: "Asigna variables desde plantillas ({{otra}}, {{$uuid}}) sin hacer peticiones" },
  { kind: "script", glyph: "{ }", label: "Script", hint: "JavaScript en un proceso aislado: lee una respuesta, escribe variables, pm.test" },
];

/** The kinds the palette drops straight onto the canvas. `fetch` sends a call, but one written on the
 * node itself, so it needs no operation from the catalogue and lands like the control kinds. */
type ControlKind = "branch" | "wait" | "merge" | "validate" | "fetch" | "set" | "script";
const CONTROL_BASE_ID: Record<ControlKind, string> = {
  branch: "rama",
  wait: "espera",
  merge: "union",
  validate: "valida",
  fetch: "fetch",
  set: "variables",
  script: "script",
};

/**
 * A standalone control node, dropped on the canvas and wired by hand.
 *
 * This is the palette's half of «add como nodos aparte y conecta libre»: the node lands unconnected
 * (or, when a node is selected, hanging off it as a convenience), and the steps it reads and feeds
 * are set by dragging edges — {@link connectStep} fills a branch's or a validate's `from` from
 * whatever is wired into it. Each kind lands with defaults so it is not empty on arrival.
 */
export function addControlStep(
  steps: WorkflowStepView[],
  kind: ControlKind,
  from?: string,
): { steps: WorkflowStepView[]; id: string } {
  const id = nextStepId(CONTROL_BASE_ID[kind], steps.map((step) => step.id));
  const source = from ? steps.find((step) => step.id === from) : undefined;
  const at = freeSpot(steps, source?.position ? { x: source.position.x + 310, y: source.position.y } : positionFor(steps.length));
  const check = { source: "status" as const, operator: "equals", value: "200" };
  const node: WorkflowStepView = { id, kind, position: at };
  if (from) node.dependsOn = [from];
  if (kind === "branch") node.condition = { from: from ?? "", check };
  if (kind === "validate") {
    node.validate = { from: from ?? "" };
    node.checks = [check];
  }
  if (kind === "wait") node.waitMs = 1000;
  if (kind === "merge") node.waits = "all";
  if (kind === "fetch") node.fetch = { method: "GET", url: "" };
  if (kind === "set") node.set = { assignments: [{ variable: "", value: "" }] };
  if (kind === "script") node.script = from ? { code: "", from } : { code: "" };
  return { steps: [...steps, node], id };
}

/** The standalone `If`, kept as the name the canvas and its tests already use. Delegates to the
 * palette's {@link addControlStep} — an If is a control node like the rest. */
export function addBranchStep(steps: WorkflowStepView[], from: string): { steps: WorkflowStepView[]; id: string } {
  return addControlStep(steps, "branch", from);
}

export function disconnectEdges(
  steps: WorkflowStepView[],
  removed: { source: string; target: string }[],
): WorkflowStepView[] {
  return steps.map((step) => {
    const cut = removed.filter((edge) => edge.target === step.id).map((edge) => edge.source);
    if (!cut.length) return step;
    let next = withDependencies(
      step,
      (step.dependsOn ?? []).filter((source) => !cut.includes(source)),
    );
    // Cutting the edge into a control node also cuts what it read: the wire was the configuration.
    if (next.condition && cut.includes(next.condition.from)) next = { ...next, condition: { ...next.condition, from: "" } };
    if (next.validate && cut.includes(next.validate.from)) next = { ...next, validate: { ...next.validate, from: "" } };
    if (next.script?.from && cut.includes(next.script.from)) next = { ...next, script: { code: next.script.code } };
    if (next.branch && cut.includes(next.branch.of)) {
      const { branch: _branch, ...rest } = next;
      next = rest;
    }
    return next;
  });
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
    (step.dependsOn ?? []).map((source) => {
      // An edge that leaves a branch leaves one of its two handles: the «sí» (then) or the «no»
      // (else). Labelled so the path a node sits on is readable without opening it.
      const take = step.branch?.of === source ? step.branch.take : undefined;
      return {
        id: `${source}-${step.id}`,
        source,
        target: step.id,
        animated: true,
        ...(take ? { sourceHandle: take, label: take === "then" ? "sí" : "no" } : {}),
      };
    }),
  );
}

/**
 * The node that just landed on the canvas, so the view can be taken to it: a node dropped from the
 * palette goes wherever `positionFor` or its source put it, often outside what is on screen. It is
 * the newest id the document gained since the last one the canvas saw. `previousIds` is
 * `undefined` when there is nothing to compare against — the first render, or a different flow
 * just opened (flows share step ids, so the caller resets on a flow change, not on ids).
 */
export function addedNodeId(previousIds: string[] | undefined, nextIds: string[]): string | undefined {
  if (!previousIds) return undefined;
  const known = new Set(previousIds);
  const added = nextIds.filter((id) => !known.has(id));
  // A handful at most: a document arriving whole (a flow's first load) is not something to fly to.
  if (added.length === 0 || added.length > 2) return undefined;
  return added[added.length - 1];
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
    const position = step.position ?? positionFor(index);
    const runStatusFor = runStatus?.[step.id];
    const kind = step.kind ?? "request";
    // Each control kind is its own shape on the canvas — no request, and the handles its flow needs.
    if (kind === "branch") {
      return { id: step.id, type: "branch", position, data: { name: step.id, from: step.condition?.from ?? "", runStatus: runStatusFor } };
    }
    if (kind === "wait") {
      return { id: step.id, type: "wait", position, data: { name: step.id, ms: step.waitMs ?? 0, runStatus: runStatusFor } };
    }
    if (kind === "merge") {
      return {
        id: step.id,
        type: "merge",
        position,
        data: { name: step.id, count: step.dependsOn?.length ?? 0, any: step.waits === "any", runStatus: runStatusFor },
      };
    }
    if (kind === "validate") {
      return {
        id: step.id,
        type: "validate",
        position,
        data: {
          name: step.id,
          from: step.validate?.from ?? "",
          checks: step.checks?.length ?? 0,
          script: Boolean(step.validate?.script?.trim()),
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "set") {
      return {
        id: step.id,
        type: "set",
        position,
        data: {
          name: step.id,
          variables: (step.set?.assignments ?? []).map((assignment) => assignment.variable).filter(Boolean),
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "script") {
      return {
        id: step.id,
        type: "script",
        position,
        data: {
          name: step.id,
          from: step.script?.from ?? "",
          lines: step.script?.code.trim() ? step.script.code.trim().split("\n").length : 0,
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "fetch") {
      return {
        id: step.id,
        type: "fetch",
        position,
        data: {
          name: step.id,
          method: step.fetch?.method ?? "GET",
          url: step.fetch?.url ?? "",
          captures: step.captures?.length ?? 0,
          checks: step.checks?.length ?? 0,
          useSession: Boolean(step.fetch?.useSession),
          runStatus: runStatusFor,
        },
      };
    }
    // request and login: both make an HTTP call. Login wears a key and publishes the credential.
    const template = step.requestTemplateId ? templateById.get(step.requestTemplateId) : undefined;
    return {
      id: step.id,
      type: kind === "login" ? "login" : "step",
      // A flow authored over the API carries no coordinates; it still has to render.
      position,
      data: {
        name: template?.name ?? "Prueba eliminada",
        expectedStatus: template?.expectedStatus ?? 0,
        method: template ? (operationById.get(template.operationId)?.method ?? "?") : "?",
        path: template ? (operationById.get(template.operationId)?.path ?? template.operationId) : "?",
        captures: step.captures?.length ?? 0,
        checks: step.checks?.length ?? 0,
        authorizes: Boolean(step.authorizes),
        retries: Boolean(step.retry),
        loops: Boolean(step.forEach),
        // Set only while a run is being watched; the node lights up by it.
        runStatus: runStatusFor,
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

/**
 * A step this one can safely lean on for a condition or a loop.
 *
 * Both read another step's response, so that step has to have run first: the pick cannot be one
 * that already depends on this node —directly or through others— or the edge we would add closes a
 * cycle. Among the rest the nearest to the left is the natural predecessor. Returns `undefined`
 * when the node is a root with nothing before it, which is the one case that truly has no answer.
 */
export function predecessorFor(steps: WorkflowStepView[], stepId: string): string | undefined {
  const target = steps.find((step) => step.id === stepId);
  if (!target) return undefined;

  // Everything downstream of the target: none of it may become its dependency.
  const descendants = new Set<string>();
  const stack = [stepId];
  while (stack.length) {
    const current = stack.pop()!;
    for (const step of steps) {
      if ((step.dependsOn ?? []).includes(current) && !descendants.has(step.id)) {
        descendants.add(step.id);
        stack.push(step.id);
      }
    }
  }

  const already = new Set(target.dependsOn ?? []);
  const candidates = steps.filter(
    (step) => step.id !== stepId && !descendants.has(step.id) && !already.has(step.id),
  );
  if (!candidates.length) return undefined;

  const targetX = target.position?.x ?? 0;
  const toLeft = candidates
    .filter((step) => (step.position?.x ?? 0) < targetX)
    .sort((a, b) => (b.position?.x ?? 0) - (a.position?.x ?? 0));
  return (toLeft[0] ?? candidates[candidates.length - 1]).id;
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
    upstream.push(...(step.set?.assignments ?? []).map((assignment) => assignment.variable).filter(Boolean));
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
    // A control node reads a step, and until it is wired to one it cannot run: point at it here so
    // the editor asks for the connection instead of the server answering 422 on save.
    const kind = step.kind ?? "request";
    if (kind === "branch" && !step.condition?.from)
      problems.push({ message: `El nodo «${step.id}» (If) no está conectado a ningún paso que leer.`, stepId: step.id });
    if (kind === "validate" && !step.validate?.from)
      problems.push({ message: `La validación «${step.id}» no está conectada a ningún paso que leer.`, stepId: step.id });
    if (kind === "validate" && !(step.checks?.length || step.validate?.script?.trim()))
      problems.push({ message: `La validación «${step.id}» no comprueba nada: añade una comprobación o un script.`, stepId: step.id });
    if (kind === "wait" && !step.waitMs)
      problems.push({ message: `El nodo de espera «${step.id}» no tiene un tiempo.`, stepId: step.id });
    if (kind === "set") {
      const assignments = step.set?.assignments ?? [];
      if (!assignments.length)
        problems.push({ message: `El nodo set «${step.id}» no asigna ninguna variable.`, stepId: step.id });
      else if (assignments.some((assignment) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(assignment.variable)))
        problems.push({ message: `El nodo set «${step.id}» tiene un nombre de variable vacío o inválido.`, stepId: step.id });
    }
    if (kind === "script" && !step.script?.code.trim())
      problems.push({ message: `El script «${step.id}» no tiene código.`, stepId: step.id });
    if (kind === "fetch" && !step.fetch?.url?.trim())
      problems.push({ message: `El fetch «${step.id}» no tiene URL.`, stepId: step.id });
    if (kind === "login" && !step.authorizes)
      problems.push({ message: `El login «${step.id}» no dice de dónde sale la credencial.`, stepId: step.id });
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
