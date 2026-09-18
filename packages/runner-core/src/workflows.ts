/**
 * User-authored flows: a graph of reusable requests, where a value read from one response becomes
 * a variable the next request can spend.
 *
 * This module is the algorithm half and knows nothing about storage. A workflow and its request
 * templates are rows the API owns — not part of `ProjectConfig` — because a template is
 * referenced by several flows, and «delete it» has to be answerable by a query.
 */
import type { StepGraphql } from "./graphql.ts";
import { valueAtPath, type RuntimeVariables } from "./variables.ts";
import type { ResponseCheck } from "./checks.ts";
import type { ScenarioAuth } from "./types.ts";
import type { StepNotify } from "./notify.ts";

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

/**
 * Where a captured value is read from.
 *
 * `body` and `header` cover an API that was designed to be read by a program. The other two exist
 * because plenty are not:
 *
 * - `cookie` — a session that arrives in `Set-Cookie` is not reachable as a header value: the
 *   header holds the whole directive string, attributes and all, and pulling one cookie out of it
 *   with a dot path is not a thing anybody should be asked to do.
 * - `regex` — the escape hatch, matched against the raw response text. For the response that is
 *   not JSON, or the value embedded in one field of a string somebody else designed. Group 1 if
 *   the pattern has one, the whole match otherwise.
 */
export const CAPTURE_SOURCES = ["body", "header", "cookie", "regex"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export type WorkflowCapture = {
  variable: string;
  from: CaptureSource;
  /** A dot path into the JSON body, a header name, a cookie name, or a regular expression. */
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
  check: ResponseCheck;
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

/**
 * The step that logs in, and what the rest of the run does with what it answered.
 *
 * The alternative is the one this replaces: somebody pastes a token into the environment by hand
 * and re-pastes it when it expires, which makes every suite a thing that has to be babysat. A flow
 * that authenticates against the target it is testing is the ordinary shape of a real API.
 *
 * **It is a property of the step and not a node of its own**, for the same reason the condition
 * and the loop are: a login is a request, it has a status and a body and a verdict, and it belongs
 * in the report as the case it is.
 *
 * What it publishes replaces the stored `primary` credential for every later step whose template
 * asks for the default one — and for no other. The cases that present `none`, `insufficient` or
 * `api-key` exist to be rejected, and handing them a working session would turn each into a green
 * 200 that proves nothing.
 */
export type StepAuthorizes = {
  /** Where the token is. The same four routes a capture has, because a session that arrives in a
   * `Set-Cookie` is at least as common as one in a JSON body. */
  from: CaptureSource;
  path: string;
  /** The header it travels in. `Authorization` unless the target calls it something else. */
  header?: string;
  /** What goes in front of it. `Bearer ` by default; empty for a raw API key. */
  scheme?: string;
};

/**
 * When a step with several dependencies may start.
 *
 * `all` is the default and is what a dependency means: this needs what those produced. `any` is
 * the reference's «merge waitFirst» — the step that only needs one of several routes to have
 * arrived, which is how a flow says «whichever of these two ways of creating it worked».
 *
 * It changes nothing when a step has one dependency, which is almost all of them.
 */
export const STEP_WAITS = ["all", "any"] as const;
export type StepWaits = (typeof STEP_WAITS)[number];

/**
 * What a node is — the palette the editor draws, each shape added on its own and wired by hand.
 *
 * - `request` sends an HTTP call (the default when absent).
 * - `login` sends one too, and publishes its answer as the run's credential (`authorizes`).
 * - `branch` sends nothing and splits the flow into a «sí» and a «no» path.
 * - `wait` pauses and lets the flow through.
 * - `merge` is a join: it waits for the branches into it and continues.
 * - `validate` reads a step's response and judges it with checks and/or a sandbox script.
 * - `fetch` sends an HTTP call the author spells out — any URL, method, headers and body — instead
 *   of one of the project's saved requests. For the call the contract does not describe: a
 *   webhook, a second service, an identity provider.
 * - `set` writes variables from templates for the steps after it.
 * - `script` runs code in the isolated sandbox, optionally over a step's response, and can write
 *   variables.
 * - `poll` re-sends the request of the step it reads until the answer passes its checks — the job
 *   that is `pending` until it is `done`. It records one case, with the last attempt in it.
 * - `retry` watches one step and, when it fails, walks the flow again from `target` down to it —
 *   see {@link StepRerun}. What hangs off it runs only when every attempt failed.
 * - `loop` walks a list a step returned and runs its body — what hangs off its «cada» output, see
 *   {@link loopBody} — once per element, before the steps on its «fin» side.
 * - `schema` judges a step's response body against a JSON Schema: the one the contract declares for
 *   that operation and status, or one written on the node.
 * - `subflow` runs another flow of the same project inline, as one step of this one — see
 *   {@link StepSubflow}.
 * - `graphql` sends one GraphQL operation — a `POST` of `{query, variables, operationName}` — and
 *   fails on a non-empty `errors` array, which a GraphQL server answers with a 200. See {@link StepGraphql}.
 * - `mock` answers with a response written on the node, without any network: the flow can be built
 *   before the service exists, or pin one answer. See {@link StepMock}.
 *
 * The ones that send no request (`branch`, `wait`, `merge`, `validate`, `set`, `script`, `schema`, `mock`) are
 * *control* nodes: they produce a case that records what the flow did, not one that made an HTTP
 * call. */
export type StepKind =
  | "request"
  | "login"
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
  // Posts a message to a chat/webhook URL held in an environment variable (see `notify.ts`). It
  // does send a request, but not to the API under test, so it records a control row (`NOTIFY`).
  | "notify"
  | "subflow"
  | "graphql"
  | "mock";

/** The control kinds — the nodes that record a decision instead of making a request. */
export const CONTROL_KINDS: StepKind[] = [
  "branch",
  "wait",
  "merge",
  "validate",
  "set",
  "script",
  "schema",
  "subflow",
  "mock",
];

/**
 * A `mock` node: the response it gives instead of making a call.
 *
 * Nothing leaves the process. When it runs, `headers` and `body` are resolved as templates and the
 * result is stored as the node's response — so the nodes after it read it like a real answer — and
 * its own `checks` and `captures` apply to it. `body` is parsed when the content type says JSON (one
 * is inferred when absent). `delayMs` stands in for the latency, and is what a `durationMs` check
 * reads. `disabledHeaders` are the editor's rows switched off; the engine ignores them.
 */
export type StepMock = {
  status: number;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  body?: string;
  delayMs?: number;
};

/**
 * A `schema` node: the step whose body it validates, and against what.
 *
 * `contract` looks the schema up in the run's OpenAPI document for `from`'s operation and the status
 * that came back, so `from` has to be a request or a login. `custom` parses `json`, which is how a
 * fetch to a service the contract does not describe gets a shape check. `strict` also fails on the
 * fields the schema does not declare — the drift a plain validation lets through.
 */
export type StepSchema = { from: string; source: "contract" | "custom"; json?: string; strict?: boolean };

/**
 * A `subflow` node: another flow of the same project, run inline as one step of this one.
 *
 * The child walks with a **copy** of the run's variables plus `inputs` (templates resolved over the
 * parent's when the node starts), and only the names in `outputs` come back — run-scoped, like a
 * capture. A copy and not the map itself, because a child is reusable by construction: the flow
 * that logs in or creates a customer is spent by ten others, and letting every name it touches leak
 * into each of them is the coupling a subflow exists to cut. The session a child obtains does come
 * back: a shared login is the most ordinary subflow there is.
 *
 * Its steps get their own cases, namespaced under the node (`workflow:<flow>:<node>>child`), and the
 * node's own case passes when every one of them did. What the child may be — same project, not
 * archived, no cycle, at most {@link MAX_SUBFLOW_DEPTH} levels — spans rows, so it is checked where
 * the other flows can be read: on save and again when a run is prepared. See {@link subflowProblems}.
 */
export type StepSubflow = {
  workflowId: string;
  inputs?: { variable: string; value: string }[];
  outputs?: string[];
};

/**
 * A `set` node: variables written without a request.
 *
 * Each `value` is a template over what the run already knows — the environment, earlier captures,
 * computed values like `{{$uuid}}` — resolved when the node runs. Run-scoped, like a capture: the
 * stored environment is never written.
 */
export type StepSet = { assignments: { variable: string; value: string }[] };

/**
 * A `script` node: code in the isolated sandbox with the `pm` API.
 *
 * `from`, when present, is a dependency whose response the script reads as `pm.response`. What it
 * writes with `pm.variables.set` or `pm.environment.set` goes into the run's variables and nowhere
 * else. It fails when it throws or when a `pm.test` it declares fails.
 */
export type StepScript = { code: string; from?: string };

/**
 * A `poll` node: the step whose request it repeats, how many times, and how far apart.
 *
 * Not the step's own `retry`, and the difference is what each one claims. A retry says «that failure
 * was not real» and repeats a step that failed. A poll repeats a step that **passed** — the job
 * answered 200 with `pending` — because the answer the flow is waiting for has not happened yet. So
 * `from` has to have held, and what decides is the node's own `checks`, judged on every answer.
 *
 * The response it first reads is the one `from` already got, so a job already done costs no request.
 * Its captures are applied to the last answer, and later nodes read that answer from this node.
 */
export type StepPoll = {
  /** A request or fetch node this one depends on. */
  from: string;
  /** Re-sends after the first read. */
  attempts: number;
  /** Wait before each re-send. */
  delayMs: number;
};

/**
 * A `retry` node: the step it watches, where the flow is walked again from, and how many times.
 *
 * Wired as three edges on the canvas: `from` into its input (a real dependency), its «reintentar»
 * output to `target` — **not** a dependency, it points back up the flow and would be a cycle — and
 * its «si se agota» output to the nodes that depend on it. When `from` passes, nothing happens: the
 * node is skipped and so is what hangs off it. When `from` fails, the stretch between `target` and
 * `from` ({@link rerunPath}) is walked again, up to `attempts` times, `delayMs` before each. If `from`
 * ends up passing, the flow goes on from `from` as if it had passed the first time; if not, the node
 * fails and its dependents run.
 *
 * Not the step's own `retry`, which resends one request and cannot go back to the step that created
 * what it reads; and not `poll`, which repeats a step that passed until its answer changes.
 */
export type StepRerun = {
  /** The step it watches. Its only dependency. */
  from: string;
  /** Where the walk starts again: `from` itself or a step upstream of it. */
  target: string;
  /** Walks after the first failure. */
  attempts: number;
  /** Wait before each walk. */
  delayMs: number;
};

/**
 * The steps a `retry` node walks again, in the order of `steps`: `target` and everything downstream
 * of it that is also upstream of `from` — the stretch between the two, both ends included. Null when
 * `target` is neither `from` nor upstream of it: there is no way back from there.
 */
export function rerunPath(steps: WorkflowStep[], target: string, from: string): string[] | null {
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
  for (let grew = true; grew;) {
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
 * A `loop` node: where the list is and what each element is called.
 *
 * Not `forEach`, which repeats **one** step. A loop repeats a piece of the graph — read the product,
 * then check its stock, then update it — and each iteration walks that piece in order, so what one
 * body step captures is there for the next one in the same iteration.
 */
export type StepLoop = {
  /** The step whose response carries the list. Must be in `dependsOn`. */
  from: string;
  /** Dot path to the array inside that response's body. */
  path: string;
  /** What each element is bound to, as `bindElement` binds it: `item`, `item.id`… */
  as: string;
  /** Hard ceiling on iterations. 50 when absent. */
  max?: number;
};

/**
 * The steps a loop runs once per element, in document order: the ones marked `inLoop` that hang off
 * it, and everything downstream of those. Downstream is the whole rule — a step after a body step
 * cannot run once when the body runs forty times — and it is why the «fin» side has to depend on the
 * loop and not on something inside it.
 */
export function loopBody(steps: WorkflowStep[], loopId: string): string[] {
  const body = new Set(
    steps.filter((step) => step.inLoop === loopId && (step.dependsOn ?? []).includes(loopId)).map((step) => step.id),
  );
  for (let grew = true; grew;) {
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

/** Which side of a branch a node sits on. */
export type StepBranch = { of: string; take: "then" | "else" };

/**
 * A `validate` node: what it reads and, optionally, the script that judges it.
 *
 * It sends no request. It reads the response a step it depends on already produced and asserts
 * over it — the step's own `checks` are the declarative half, and `script` is the escape hatch,
 * run in the isolated sandbox with the `pm` API, whose `pm.test(...)` results decide the verdict.
 * `from` has to be a dependency, for the same reason a condition's is: without the edge there is
 * no guarantee the step it names has answered.
 */
export type StepValidate = { from: string; script?: string };

import type { RequestAuth } from "./auth.ts";

export const FETCH_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type FetchMethod = (typeof FETCH_METHODS)[number];

/**
 * A `fetch` node: one HTTP call written out by hand.
 *
 * `url` is absolute (`https://hooks.example.com/x`) or a path (`/things`) that is resolved against
 * the environment's base URL. Every text field accepts `{{variables}}`. It goes out through the same
 * SSRF guard as every other request. It presents the run's session only when `useSession` says so:
 * a token obtained from the API under test must not travel to a third-party host by default.
 * `expectedStatus` absent means any 2xx.
 */
export type StepFetch = {
  method: FetchMethod;
  url: string;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  body?: string;
  expectedStatus?: number;
  useSession?: boolean;
  /**
   * Cómo entra: los mismos tipos que Postman, firmados sobre esta petición.
   *
   * Ausente o `inherit` deja la llamada como estaba: la sesión si `useSession` lo dice, y nada más.
   * Un secreto aquí es siempre una `{{variable}}` —el documento es una columna `jsonb`— así que lo
   * que se guarda es el nombre del sitio donde está el valor, no el valor.
   */
  auth?: RequestAuth;
};

export type WorkflowStep = {
  id: string;
  /** Present on a `request` node; absent on a `branch`, which sends nothing. */
  requestTemplateId?: string;
  /** Absent means `request`. */
  kind?: StepKind;
  /** On a `branch` node: the step it reads and the check that decides «sí» from «no». */
  condition?: StepCondition;
  /** On a `validate` node: the step whose response it judges, and an optional sandbox script. */
  validate?: StepValidate;
  /** On a `fetch` node: the call it sends. */
  fetch?: StepFetch;
  /** On a `set` node: the variables it writes. */
  set?: StepSet;
  /** On a `script` node: its code and the step it reads, if any. */
  script?: StepScript;
  /** On a `poll` node: the step it repeats until its checks pass. */
  poll?: StepPoll;
  /** On a `retry` node: the step it watches and where it walks the flow again from. */
  rerun?: StepRerun;
  /** On a `loop` node: the list it walks. */
  loop?: StepLoop;
  /** On a node wired to a loop's «cada» output: the loop whose body it starts. */
  inLoop?: string;
  /** On a `schema` node: the step whose body it validates and the schema it uses. */
  schema?: StepSchema;
  /** On a `notify` node: the channel, the variable holding the webhook URL, and the message. */
  notify?: StepNotify;
  /** On a `subflow` node: the flow it runs, what goes in and what comes back. */
  subflow?: StepSubflow;
  /** On a `graphql` node: the operation it sends. */
  graphql?: StepGraphql;
  /** On a `mock` node: the simulated response it answers with. */
  mock?: StepMock;
  /** On a node downstream of a branch: which path it sits on. */
  branch?: StepBranch;
  waits?: StepWaits;
  /** Wait before this step, in milliseconds. For the target that accepts a write and takes a
   * moment to make it readable — a retry says «that failure was not real», and this says «it was
   * not time yet», which are different claims about the same target. */
  waitMs?: number;
  runIf?: StepCondition;
  forEach?: StepForEach;
  /** What this step's response yields as the credential the rest of the run presents. */
  authorizes?: StepAuthorizes;
  /** The visual editor stores graph edges explicitly. Empty means this is a start node. */
  dependsOn?: string[];
  captures?: WorkflowCapture[];
  /** What this step's author claims about the response, beyond what the contract already says. */
  checks?: ResponseCheck[];
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

/**
 * One cookie out of a `Set-Cookie`.
 *
 * Several cookies arrive as several headers, which a client flattens into one string; the
 * separator is a comma, and a comma also appears inside `Expires=Wed, 09 Jun 2027`. Splitting on
 * `name=` at a boundary instead of on the separator is what keeps a date from cutting a cookie in
 * half — and the value ends at the first `;`, which is where its attributes start.
 */
export function cookieValue(setCookie: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[,;]\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`).exec(setCookie);
  return match ? match[1] : undefined;
}

export function applyCaptures(
  captures: WorkflowCapture[],
  response: { body: unknown; headers: Record<string, string>; raw?: string },
  variables: RuntimeVariables,
  /** The step doing the capturing. Given, the value is also published as `<stepId>.<name>`, which
   * is what lets a later step say which answer it means when two steps capture the same name. */
  stepId?: string,
): { captured: string[]; missing: string[] } {
  const captured: string[] = [];
  const missing: string[] = [];
  for (const capture of captures) {
    const value = readFrom(capture.from, capture.path, response);
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

/** One value out of a response, by any of the four routes. Shared by a capture and by the step
 * that publishes a session, because «where is the token» and «where is the id» are one question. */
export function readFrom(
  from: CaptureSource,
  path: string,
  response: { body: unknown; headers: Record<string, string>; raw?: string },
): unknown {
  const header = (name: string) => response.headers[name.toLowerCase()] ?? response.headers[name];
  switch (from) {
    case "body":
      return valueAtPath(response.body, path);
    case "header":
      return header(path);
    case "cookie": {
      const setCookie = header("set-cookie");
      return setCookie ? cookieValue(setCookie, path) : undefined;
    }
    case "regex": {
      // Against the raw text and not the parsed body: the reason to reach for a regular expression
      // is that the response is not the shape a path can walk.
      const text = response.raw ?? (typeof response.body === "string" ? response.body : JSON.stringify(response.body));
      try {
        const match = new RegExp(path).exec(text ?? "");
        // Group 1 when the pattern has one, because a pattern with a group was written to say
        // «this part»; the whole match otherwise.
        return match ? (match[1] ?? match[0]) : undefined;
      } catch {
        // A malformed pattern is the author's mistake and comes back as «no se encontró», which is
        // reported on the step. Throwing would take the run down over one bad character.
        return undefined;
      }
    }
  }
}

/**
 * Reads the credential a step published.
 *
 * `null` when the path led nowhere, which is reported on the step rather than thrown: a login that
 * answered 200 with a body nobody expected is a finding about the target, and the eight steps
 * after it failing with 401 is the same finding restated eight times without ever naming it.
 */
export function readAuthorization(
  authorizes: StepAuthorizes,
  response: { body: unknown; headers: Record<string, string>; raw?: string },
): { header: string; value: string } | null {
  const found = readFrom(authorizes.from, authorizes.path, response);
  if (found === undefined || found === null || typeof found === "object" || found === "") return null;
  return {
    header: authorizes.header?.trim() || "Authorization",
    // `??` and not `||`: an empty scheme is «send the token raw», which is what an API key wants,
    // and a default that overrode it would break exactly that case.
    value: `${authorizes.scheme ?? "Bearer "}${String(found)}`,
  };
}

/**
 * Which steps could be running at the same time as which.
 *
 * Two steps are concurrent unless one is an ancestor of the other: the edges are the only thing
 * that orders anything, and without a path between them nothing says which goes first. With a
 * concurrency of one that is still true in principle and irrelevant in practice — but the rules
 * that keep a parallel run honest have to be checked when the flow is **written**, not when
 * somebody later raises a number on the run panel and turns a saved flow into a race.
 *
 * Returned as pairs of ids, both orders excluded, so a caller reports each conflict once.
 */
export function concurrentPairs(steps: WorkflowStep[]): [WorkflowStep, WorkflowStep][] {
  const ancestors = new Map<string, Set<string>>();
  // The document is already acyclic — the schema refuses a cycle before this runs — so one pass in
  // topological order is enough: a step's ancestors are its parents plus its parents' ancestors.
  for (const step of orderWorkflowSteps({ steps })) {
    const reached = new Set<string>();
    for (const parent of step.dependsOn ?? []) {
      reached.add(parent);
      for (const older of ancestors.get(parent) ?? []) reached.add(older);
    }
    ancestors.set(step.id, reached);
  }

  const pairs: [WorkflowStep, WorkflowStep][] = [];
  for (const [index, left] of steps.entries()) {
    for (const right of steps.slice(index + 1)) {
      const ordered = ancestors.get(left.id)?.has(right.id) || ancestors.get(right.id)?.has(left.id);
      if (!ordered) pairs.push([left, right]);
    }
  }
  return pairs;
}
