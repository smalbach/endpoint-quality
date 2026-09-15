/**
 * The logic behind the flow editor, kept out of the components.
 *
 * Same reason as `config-draft.ts`: this is the part worth asserting. A graph editor is mostly
 * invariants — an edge must not survive the node it pointed at, a step must not depend on itself,
 * a cycle must be caught before it is saved — and none of them are display concerns. Tested here,
 * with no renderer in sight.
 */
import { DEFAULT_GRAPHQL_QUERY, GRAPHQL_OPERATION_NAME, graphqlVariablesProblem } from "@/lib/graphql-draft";
import type {
  CaseStatus,
  WorkflowCaptureView,
  RequestTemplateView,
  WorkflowStatusView,
  WorkflowStepView,
} from "@/lib/types";
import { slugId } from "@/lib/config-draft";
import { defaultNotify, notifyProblems } from "@/lib/workflow-notify";
import { defaultMock, mockProblems } from "@/lib/mock-draft";

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

export function addStep(
  steps: WorkflowStepView[],
  template: RequestTemplateView,
  /** Where it was dropped on the canvas; kept as is, since the user chose the spot. */
  at?: { x: number; y: number },
): WorkflowStepView[] {
  const id = nextStepId(
    template.name,
    steps.map((step) => step.id),
  );
  return [...steps, { id, requestTemplateId: template.id, position: at ?? freeSpot(steps, positionFor(steps.length)) }];
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
  delete clone.inLoop;
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
      if (next.poll?.from === stepId) next = { ...next, poll: { ...next.poll, from: "" } };
      if (next.rerun && (next.rerun.from === stepId || next.rerun.target === stepId)) {
        next = {
          ...next,
          rerun: {
            ...next.rerun,
            from: next.rerun.from === stepId ? "" : next.rerun.from,
            target: next.rerun.target === stepId ? "" : next.rerun.target,
          },
        };
      }
      if (next.loop?.from === stepId) next = { ...next, loop: { ...next.loop, from: "" } };
      if (next.schema?.from === stepId) next = { ...next, schema: { ...next.schema, from: "" } };
      if (next.inLoop === stepId) {
        const { inLoop: _inLoop, ...rest } = next;
        next = rest;
      }
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
  // A retry's «reintentar» output is not a dependency — it points back up the flow — so the wire only
  // records where the walk starts again.
  if (handle === "retry" && steps.find((step) => step.id === source)?.kind === "retry") {
    return steps.map((step) =>
      step.id === source ? { ...step, rerun: { ...DEFAULT_RERUN, ...step.rerun, target } } : step,
    );
  }
  const branching = (steps.find((step) => step.id === source)?.kind ?? "request") === "branch";
  const take = handle === "then" || handle === "else" ? handle : undefined;
  const looping = steps.find((step) => step.id === source)?.kind === "loop";
  return steps.map((step) => {
    if (step.id !== target) return step;
    const linked = withDependencies(step, [...new Set([...(step.dependsOn ?? []), source])]);
    // A wire from a loop's «cada» output puts the target inside it; «fin» is an ordinary edge.
    if (looping && handle === "each") return { ...linked, inLoop: source };
    if (linked.kind === "loop" && !linked.loop?.from) {
      return { ...linked, loop: { path: "data", as: "item", max: 50, ...linked.loop, from: source } };
    }
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
    // Wired into a retry, the step it watches; until its «reintentar» goes somewhere, it repeats that step.
    if (linked.kind === "retry" && !linked.rerun?.from) {
      return { ...linked, rerun: { ...DEFAULT_RERUN, ...linked.rerun, from: source, target: linked.rerun?.target || source } };
    }
    if (linked.kind === "poll" && !linked.poll?.from) {
      return { ...linked, poll: { attempts: 5, delayMs: 2000, ...linked.poll, from: source } };
    }
    if (linked.kind === "schema" && !linked.schema?.from) {
      return { ...linked, schema: { source: "custom", ...linked.schema, from: source } };
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
  { kind: "retry", glyph: "↻", label: "Reintento", hint: "Si el paso conectado falla, repite el flujo desde el nodo al que apuntes; si se agotan los intentos, sigue por «si se agota»" },
  { kind: "poll", glyph: "⧗", label: "Sondeo", hint: "Repite la petición de un paso que pasó hasta que su respuesta cumpla las comprobaciones (polling)" },
  { kind: "loop", glyph: "∀", label: "Bucle", hint: "Recorre una lista: lo que cuelga de «cada» se ejecuta una vez por elemento, y «fin» sigue después" },
  { kind: "schema", glyph: "⊨", label: "Esquema", hint: "Valida el body de una respuesta contra el JSON Schema del contrato o uno escrito a mano" },
  { kind: "notify", glyph: "✉", label: "Notificar", hint: "Envía un mensaje a Slack, Teams o un webhook; la URL sale de una variable del entorno" },
  { kind: "subflow", glyph: "⧉", label: "Sub-flujo", hint: "Ejecuta otro flujo del proyecto como un paso de este: le pasa variables y recoge las que devuelve" },
  { kind: "graphql", glyph: "◈", label: "GraphQL", hint: "Una operación GraphQL (query, variables, operationName): falla si la respuesta trae errors" },
  { kind: "mock", glyph: "◌", label: "Mock", hint: "Respuesta simulada sin red: estado, cabeceras y body escritos a mano, para lo que aún no existe" },
];

/** Why the JSON Schema written on a schema node cannot be used, or null. The server refuses the same
 * things: not JSON, not an object, or the `pattern` keyword (compiled in the API process). */
export function schemaJsonProblem(json: string | undefined): string | null {
  if (!json?.trim()) return "Falta el JSON Schema.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "El esquema no es JSON válido.";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "El esquema tiene que ser un objeto JSON.";
  const usesPattern = (node: unknown): boolean =>
    Array.isArray(node)
      ? node.some(usesPattern)
      : Boolean(node) &&
        typeof node === "object" &&
        Object.entries(node as Record<string, unknown>).some(
          ([key, value]) => (key === "pattern" && typeof value === "string") || usesPattern(value),
        );
  return usesPattern(parsed) ? "Un esquema propio no puede usar «pattern»." : null;
}

/** The kinds the palette drops straight onto the canvas. `fetch` sends a call, but one written on the
 * node itself, so it needs no operation from the catalogue and lands like the control kinds; `poll`
 * re-sends the request of the node wired into it. */
type ControlKind =
  | "branch"
  | "wait"
  | "merge"
  | "validate"
  | "fetch"
  | "set"
  | "script"
  | "poll"
  | "retry"
  | "loop"
  | "schema"
  | "notify"
  | "subflow"
  | "graphql"
  | "mock";

/** A retry node's settings before anything is wired to it. */
const DEFAULT_RERUN = { from: "", target: "", attempts: 3, delayMs: 1000 };

/** The kinds a retry node can watch: the ones that fail on their own. Same list as the server's. */
const RETRY_WATCHES = ["request", "login", "fetch", "graphql", "validate", "schema", "script"];

const CONTROL_BASE_ID: Record<ControlKind, string> = {
  branch: "rama",
  wait: "espera",
  merge: "union",
  validate: "valida",
  fetch: "fetch",
  set: "variables",
  script: "script",
  poll: "sondeo",
  retry: "reintento",
  loop: "bucle",
  schema: "esquema",
  notify: "notificar",
  subflow: "subflujo",
  graphql: "graphql",
  mock: "mock",
};

/**
 * The nodes a loop runs once per element: the ones wired to its «cada» output, and everything
 * downstream of those. The same rule as the engine's `loopBody`, so the canvas says what will run.
 */
export function loopBodyIds(steps: WorkflowStepView[], loopId: string): string[] {
  const body = new Set(
    steps.filter((step) => step.inLoop === loopId && (step.dependsOn ?? []).includes(loopId)).map((step) => step.id),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of steps) {
      if (body.has(step.id) || step.id === loopId) continue;
      if ((step.dependsOn ?? []).some((id) => body.has(id))) {
        body.add(step.id);
        grew = true;
      }
    }
  }
  return steps.filter((step) => body.has(step.id)).map((step) => step.id);
}

/**
 * The nodes a retry walks again, in document order: where it repeats from and everything after that
 * which leads to the step it watches. Null when `target` does not come before `from`. Same rule as
 * the engine's `rerunPath`, so the editor refuses what the server would.
 */
export function rerunPathIds(steps: WorkflowStepView[], target: string, from: string): string[] | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const upstream = new Set<string>();
  const walk = [from];
  while (walk.length) {
    const id = walk.pop()!;
    if (upstream.has(id) || !byId.has(id)) continue;
    upstream.add(id);
    walk.push(...(byId.get(id)!.dependsOn ?? []));
  }
  if (!upstream.has(target)) return null;
  const between = new Set([target]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of steps) {
      if (between.has(step.id) || !upstream.has(step.id)) continue;
      if ((step.dependsOn ?? []).some((id) => between.has(id))) {
        between.add(step.id);
        grew = true;
      }
    }
  }
  return steps.filter((step) => between.has(step.id)).map((step) => step.id);
}

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
  /** Where it was dropped on the canvas; kept as is, since the user chose the spot. */
  dropped?: { x: number; y: number },
): { steps: WorkflowStepView[]; id: string } {
  const id = nextStepId(CONTROL_BASE_ID[kind], steps.map((step) => step.id));
  const source = from ? steps.find((step) => step.id === from) : undefined;
  const at = dropped ?? freeSpot(steps, source?.position ? { x: source.position.x + 310, y: source.position.y } : positionFor(steps.length));
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
  if (kind === "loop") node.loop = { from: from ?? "", path: "data", as: "item", max: 50 };
  if (kind === "graphql") node.graphql = { url: "", query: DEFAULT_GRAPHQL_QUERY };
  if (kind === "schema") node.schema = { from: from ?? "", source: "custom", json: '{\n  "type": "object"\n}' };
  if (kind === "notify") node.notify = defaultNotify();
  // No flow yet: the inspector's selector picks it, and flowProblems asks for it until then.
  if (kind === "subflow") node.subflow = { workflowId: "", inputs: [], outputs: [] };
  if (kind === "mock") node.mock = defaultMock();
  if (kind === "retry") node.rerun = { ...DEFAULT_RERUN, from: from ?? "", target: from ?? "" };
  if (kind === "poll") {
    node.poll = { from: from ?? "", attempts: 5, delayMs: 2000 };
    node.checks = [check];
  }
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
    // A retry's «reintentar» wire is its `target`, not a dependency of the node it points at.
    if (step.rerun?.target && removed.some((edge) => edge.source === step.id && edge.target === step.rerun!.target)) {
      step = { ...step, rerun: { ...step.rerun, target: "" } };
    }
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
    if (next.poll && cut.includes(next.poll.from)) next = { ...next, poll: { ...next.poll, from: "" } };
    if (next.rerun && cut.includes(next.rerun.from)) next = { ...next, rerun: { ...next.rerun, from: "" } };
    if (next.loop && cut.includes(next.loop.from)) next = { ...next, loop: { ...next.loop, from: "" } };
    if (next.schema && cut.includes(next.schema.from)) next = { ...next, schema: { ...next.schema, from: "" } };
    if (next.inLoop && cut.includes(next.inLoop)) {
      const { inLoop: _inLoop, ...rest } = next;
      next = rest;
    }
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
  const loops = new Set(steps.filter((step) => step.kind === "loop").map((step) => step.id));
  const retries = new Set(steps.filter((step) => step.kind === "retry").map((step) => step.id));
  // A retry's «reintentar» wire goes back up the flow to where it repeats from. Drawn dashed and
  // amber: it is a way back, not an order the steps run in.
  const back = steps.flatMap((step) =>
    step.kind === "retry" && step.rerun?.target
      ? [
          {
            id: `${step.id}~reintentar~${step.rerun.target}`,
            source: step.id,
            target: step.rerun.target,
            animated: true,
            sourceHandle: "retry",
            label: "reintentar",
            style: { stroke: "#f59e0b", strokeDasharray: "6 4" },
            labelStyle: { fill: "#b45309" },
          },
        ]
      : [],
  );
  const forward = steps.flatMap((step) =>
    (step.dependsOn ?? []).map((source) => {
      // An edge that leaves a branch leaves one of its two handles: the «sí» (then) or the «no»
      // (else). Labelled so the path a node sits on is readable without opening it.
      const take = step.branch?.of === source ? step.branch.take : undefined;
      // A loop has two as well: «cada» into its body, «fin» to what runs after it.
      const side = loops.has(source) ? (step.inLoop === source ? "each" : "done") : undefined;
      return {
        id: `${source}-${step.id}`,
        source,
        target: step.id,
        animated: true,
        ...(take
          ? { sourceHandle: take, label: take === "then" ? "sí" : "no" }
          : side
            ? { sourceHandle: side, label: side === "each" ? "cada" : "fin" }
            : retries.has(source)
              ? { sourceHandle: "exhausted", label: "si se agota" }
              : {}),
      };
    }),
  );
  return [...forward, ...back];
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
  /** When each running node started (see `flowNodeStartedAt`); a wait node counts down from it. */
  runStartedAt?: Record<string, string>,
  /** The retry each node is on, or ended with, in a live run (see `flowNodeRetries`). */
  runRetries?: Record<string, RetryNote>,
) {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  const nodes = steps.map((step, index) => {
    const position = step.position ?? positionFor(index);
    const runStatusFor = runStatus?.[step.id];
    const kind = step.kind ?? "request";
    // Each control kind is its own shape on the canvas — no request, and the handles its flow needs.
    if (kind === "branch") {
      return { id: step.id, type: "branch", position, data: { name: step.id, from: step.condition?.from ?? "", runStatus: runStatusFor } };
    }
    if (kind === "wait") {
      return { id: step.id, type: "wait", position, data: { name: step.id, ms: step.waitMs ?? 0, runStatus: runStatusFor, startedAt: runStartedAt?.[step.id] },
      };
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
    if (kind === "loop") {
      return {
        id: step.id,
        type: "loop",
        position,
        data: {
          name: step.id,
          from: step.loop?.from ?? "",
          path: step.loop?.path ?? "",
          as: step.loop?.as ?? "",
          max: step.loop?.max ?? 50,
          body: loopBodyIds(steps, step.id).length,
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "notify") {
      // Written out rather than built by a helper: the node data is a union of these literals, and a
      // named type in it would hide the optional fields the other kinds are read through.
      return {
        id: step.id,
        type: "notify",
        position,
        data: {
          name: step.id,
          channel: step.notify?.channel ?? "slack",
          urlVariable: step.notify?.urlVariable ?? "",
          message: step.notify?.message ?? "",
          failsFlow: step.notify?.onError === "fail",
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "subflow") {
      return {
        id: step.id,
        type: "subflow",
        position,
        data: {
          name: step.id,
          chosen: Boolean(step.subflow?.workflowId),
          inputs: step.subflow?.inputs?.length ?? 0,
          outputs: step.subflow?.outputs?.length ?? 0,
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "schema") {
      return {
        id: step.id,
        type: "schema",
        position,
        data: {
          name: step.id,
          from: step.schema?.from ?? "",
          source: step.schema?.source ?? "custom",
          strict: Boolean(step.schema?.strict),
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "mock") {
      return {
        id: step.id,
        type: "mock",
        position,
        data: {
          name: step.id,
          status: step.mock?.status ?? 0,
          delayMs: step.mock?.delayMs ?? 0,
          captures: step.captures?.length ?? 0,
          checks: step.checks?.length ?? 0,
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "retry") {
      return {
        id: step.id,
        type: "retry",
        position,
        data: {
          name: step.id,
          from: step.rerun?.from ?? "",
          target: step.rerun?.target ?? "",
          attempts: step.rerun?.attempts ?? 0,
          delayMs: step.rerun?.delayMs ?? 0,
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "poll") {
      return {
        id: step.id,
        type: "poll",
        position,
        data: {
          name: step.id,
          from: step.poll?.from ?? "",
          attempts: step.poll?.attempts ?? 0,
          delayMs: step.poll?.delayMs ?? 0,
          checks: step.checks?.length ?? 0,
          runStatus: runStatusFor,
        },
      };
    }
    if (kind === "graphql") {
      return {
        id: step.id,
        type: "graphql",
        position,
        data: {
          name: step.id,
          url: step.graphql?.url ?? "",
          operationName: step.graphql?.operationName ?? "",
          captures: step.captures?.length ?? 0,
          checks: step.checks?.length ?? 0,
          useSession: Boolean(step.graphql?.useSession),
          allowErrors: Boolean(step.graphql?.allowErrors),
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
  // Added after the fact rather than in every branch: any node that sends a request can retry, and
  // only a watched run that announced a retry has one to show.
  if (!runRetries) return nodes;
  return nodes.map((node) => {
    const retry = runRetries[node.id];
    return retry ? { ...node, data: { ...node.data, retry } } : node;
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

/** The node a case belongs to, or null when the case is not a flow's. */
function caseStepId(scenarioId: string): string | null {
  const parts = scenarioId.split(":");
  if (parts[0] !== "workflow" || parts.length < 3) return null;
  // A subflow's child cases are `<node>>childStep`: they light the node that runs them.
  return parts[2].split("#")[0].split(">")[0];
}

export function flowNodeStatuses(cases: { scenarioId: string; status: CaseStatus }[]): Record<string, CaseStatus> {
  const byStep: Record<string, CaseStatus> = {};
  for (const runCase of cases) {
    const stepId = caseStepId(runCase.scenarioId);
    if (!stepId) continue;
    const current = byStep[stepId];
    if (!current || STATUS_RANK[runCase.status] > STATUS_RANK[current]) byStep[stepId] = runCase.status;
  }
  return byStep;
}

/**
 * When each node's running case started, from a live run's cases: what a wait node counts down
 * from. Nodes with nothing running are absent; with several running cases, the latest start wins.
 */
export function flowNodeStartedAt(
  cases: { scenarioId: string; status: CaseStatus; startedAt?: string | null }[],
): Record<string, string> {
  const byStep: Record<string, string> = {};
  for (const runCase of cases) {
    if (runCase.status !== "running" || !runCase.startedAt) continue;
    const stepId = caseStepId(runCase.scenarioId);
    if (!stepId) continue;
    const current = byStep[stepId];
    if (!current || Date.parse(runCase.startedAt) > Date.parse(current)) byStep[stepId] = runCase.startedAt;
  }
  return byStep;
}

/** A node's retry in a live run, as the stream announced it (see `flowNodeRetries`). */
export type RetryNote = {
  /** The attempt about to go out, counting the first request as attempt one. */
  attempt: number;
  /** Every attempt it may take, the first one included. */
  attempts: number;
  /** The pause before this attempt. */
  waitMs: number;
  /** When the browser heard of it: the pause counts down from here, on the browser's own clock. */
  at: string;
  /** The case has its verdict, and `attempt` is how many it took. */
  done: boolean;
};

/**
 * Each node's retry, from a live run's cases and the retries the stream announced per case. With
 * several cases on one node — a loop — the one still retrying wins, then the latest announced.
 */
export function flowNodeRetries(
  cases: { id: string; scenarioId: string }[],
  retrying: ReadonlyMap<string, RetryNote>,
): Record<string, RetryNote> {
  const byStep: Record<string, RetryNote> = {};
  for (const runCase of cases) {
    const note = retrying.get(runCase.id);
    const stepId = note ? caseStepId(runCase.scenarioId) : null;
    if (!note || !stepId) continue;
    const current = byStep[stepId];
    const wins =
      !current ||
      (current.done && !note.done) ||
      (current.done === note.done && Date.parse(note.at) > Date.parse(current.at));
    if (wins) byStep[stepId] = note;
  }
  return byStep;
}

/**
 * Milliseconds a wait of `ms` started at `startedAt` has left at `now`, kept within [0, ms]: a
 * browser clock off from the server's never shows more than the whole pause, nor less than nothing.
 */
export function waitRemainingMs(ms: number, startedAt: string, now: number): number {
  const elapsed = now - Date.parse(startedAt);
  if (Number.isNaN(elapsed)) return ms;
  return Math.min(ms, Math.max(0, ms - elapsed));
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
    if (step.kind === "loop" && step.loop?.as) upstream.push(step.loop.as);
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
    if (kind === "loop") {
      if (!step.loop?.from)
        problems.push({ message: `El bucle «${step.id}» no está conectado a ningún paso con una lista.`, stepId: step.id });
      for (const id of loopBodyIds(steps, step.id)) {
        const inner = steps.find((other) => other.id === id);
        if (inner?.kind === "loop")
          problems.push({ message: `El bucle «${id}» está dentro de «${step.id}»: no se pueden anidar.`, stepId: id });
        else if (inner?.forEach)
          problems.push({ message: `«${id}» está dentro del bucle «${step.id}» y tiene su propio forEach.`, stepId: id });
      }
    }
    if (kind === "poll") {
      const source = steps.find((other) => other.id === step.poll?.from);
      if (!step.poll?.from)
        problems.push({ message: `El sondeo «${step.id}» no está conectado a ninguna petición que repetir.`, stepId: step.id });
      else if (source && (!["request", "fetch"].includes(source.kind ?? "request") || source.forEach || source.authorizes))
        problems.push({
          message: `El sondeo «${step.id}» solo puede repetir una petición o un fetch, sin bucle ni login.`,
          stepId: step.id,
        });
      if (!step.checks?.length)
        problems.push({ message: `El sondeo «${step.id}» no tiene comprobaciones: nada dice cuándo parar.`, stepId: step.id });
    }
    if (kind === "retry") {
      const rerun = step.rerun;
      const source = steps.find((other) => other.id === rerun?.from);
      if (!rerun?.from)
        problems.push({ message: `El reintento «${step.id}» no está conectado a ningún paso que vigilar.`, stepId: step.id });
      else if (source && !RETRY_WATCHES.includes(source.kind ?? "request"))
        problems.push({
          message: `El reintento «${step.id}» solo vigila una petición, un login, un fetch, GraphQL, una validación, un esquema o un script.`,
          stepId: step.id,
        });
      if (!rerun?.target)
        problems.push({
          message: `El reintento «${step.id}» no tiene conectada su salida «reintentar»: arrástrala al nodo desde el que repetir.`,
          stepId: step.id,
        });
      else if (rerun.from) {
        const path = rerunPathIds(steps, rerun.target, rerun.from);
        const blocked = path?.find((id) => {
          const inner = steps.find((other) => other.id === id);
          return inner && (["loop", "subflow", "poll", "retry"].includes(inner.kind ?? "request") || inner.forEach);
        });
        if (!path)
          problems.push({
            message: `El reintento «${step.id}» repite desde «${rerun.target}», que no va antes de «${rerun.from}».`,
            stepId: step.id,
          });
        else if (blocked)
          problems.push({
            message: `El reintento «${step.id}» pasaría por «${blocked}», que no se puede repetir (bucle, sub-flujo, sondeo, reintento o forEach).`,
            stepId: step.id,
          });
      }
      if ((step.dependsOn ?? []).some((id) => id !== rerun?.from))
        problems.push({ message: `El reintento «${step.id}» solo se conecta al paso que vigila.`, stepId: step.id });
      if (rerun?.from && steps.some((other) => other.id !== step.id && other.kind === "retry" && other.rerun?.from === rerun.from))
        problems.push({ message: `Hay más de un reintento vigilando «${rerun.from}».`, stepId: step.id });
      if (steps.some((loop) => loop.kind === "loop" && loopBodyIds(steps, loop.id).includes(step.id)))
        problems.push({ message: `El reintento «${step.id}» está dentro de un bucle: no puede ir ahí.`, stepId: step.id });
    }
    if (kind === "schema") {
      const source = steps.find((other) => other.id === step.schema?.from);
      if (!step.schema?.from)
        problems.push({ message: `El esquema «${step.id}» no está conectado a ningún paso que validar.`, stepId: step.id });
      if (step.schema?.source === "contract") {
        if (source && !["request", "login"].includes(source.kind ?? "request"))
          problems.push({
            message: `El esquema «${step.id}» usa el contrato, que solo se conoce para una petición guardada o un login.`,
            stepId: step.id,
          });
      } else {
        const problem = schemaJsonProblem(step.schema?.json);
        if (problem) problems.push({ message: `El esquema «${step.id}»: ${problem}`, stepId: step.id });
      }
    }
    if (kind === "notify") problems.push(...notifyProblems(step));
    if (kind === "subflow") {
      if (!step.subflow?.workflowId)
        problems.push({ message: `El sub-flujo «${step.id}» no tiene elegido el flujo que ejecuta.`, stepId: step.id });
      const names = [...(step.subflow?.inputs ?? []).map((input) => input.variable), ...(step.subflow?.outputs ?? [])];
      if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)))
        problems.push({ message: `El sub-flujo «${step.id}» tiene un nombre de variable vacío o inválido.`, stepId: step.id });
      if (steps.some((loop) => loop.kind === "loop" && loopBodyIds(steps, loop.id).includes(step.id)))
        problems.push({ message: `El sub-flujo «${step.id}» está dentro de un bucle: no puede ir ahí.`, stepId: step.id });
    }
    if (kind === "mock") problems.push(...mockProblems(step).map((message) => ({ message, stepId: step.id })));
    if (kind === "fetch" && !step.fetch?.url?.trim())
      problems.push({ message: `El fetch «${step.id}» no tiene URL.`, stepId: step.id });
    if (kind === "graphql") {
      if (!step.graphql?.url?.trim()) problems.push({ message: `El nodo GraphQL «${step.id}» no tiene URL.`, stepId: step.id });
      if (!step.graphql?.query?.trim()) problems.push({ message: `El nodo GraphQL «${step.id}» no tiene query.`, stepId: step.id });
      const variablesProblem = graphqlVariablesProblem(step.graphql?.variables);
      if (variablesProblem) problems.push({ message: `El nodo GraphQL «${step.id}»: ${variablesProblem}`, stepId: step.id });
      if (step.graphql?.operationName && !GRAPHQL_OPERATION_NAME.test(step.graphql.operationName))
        problems.push({ message: `El nodo GraphQL «${step.id}»: «${step.graphql.operationName}» no es un operationName válido.`, stepId: step.id });
    }
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
