/**
 * What the API answers, written once.
 *
 * The front end used to keep its own copy of every response shape. The comment above it said the
 * duplication was the right call while there was one consumer, and it was — until a column
 * changed and nothing anywhere noticed: `run_steps` learned to have its bodies retired, the API
 * started answering `request: null`, and the browser kept a type that said `request` was always
 * there. TypeScript cannot catch a lie it was told twice.
 *
 * Types only, no runtime. Every import of this package is an `import type` and erases at compile
 * time, so the CommonJS API and the ESM browser bundle can share it without either one loading
 * anything from the other.
 *
 * **The generic parameter is a timestamp.** It is the one place the two sides genuinely differ: a
 * handler returns `Date`, JSON delivers a string, and pretending otherwise is how a `.getTime()`
 * ends up in a browser on something that is text. So each shape is written once over `T` and
 * instantiated twice — `…Of<Date>` on the server, the plain alias on the wire.
 */

// ---------------------------------------------------------------------------------------------
// Identity and access
// ---------------------------------------------------------------------------------------------

/** Ordered by capability, and compared as such: `viewer < editor < admin < owner`. */
export type Role = "viewer" | "editor" | "admin" | "owner";

export type OrganizationMembership = { id: string; name: string; slug: string; role: Role };

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  organizations: OrganizationMembership[];
};

export type MemberOf<T> = { userId: string; email: string; name: string; role: Role; since: T };
/** An invitation that has not been accepted. It is listed next to the members because «invited»
 * and «is a member» look the same to whoever is waiting for access. */
export type PendingInvitationOf<T> = { id: string; email: string; role: Role; expiresAt: T };
export type MembersViewOf<T> = { members: MemberOf<T>[]; invitations: PendingInvitationOf<T>[] };

/**
 * A service credential, as it is listed.
 *
 * `preview` is the only part of the token any query ever returns — the whole thing is shown once,
 * when it is issued, and stored as a hash. A list that could show it again would be a list worth
 * stealing.
 */
export type ApiTokenViewOf<T> = {
  id: string;
  name: string;
  preview: string;
  createdAt: T;
  lastUsedAt: T | null;
  revokedAt: T | null;
};

// ---------------------------------------------------------------------------------------------
// Projects and contracts
// ---------------------------------------------------------------------------------------------

export type ContractSummaryOf<T> = {
  versionId: string;
  title: string;
  version: string;
  operationCount: number;
  importedAt: T;
};

/**
 * Where the contract was last read from.
 *
 * `headersStored` is a boolean and stays one: the credential is stored encrypted precisely so
 * that no query returns it. What a screen needs is that there is one, not what it says.
 */
export type SpecSourceSummary = { kind: string; location: string; headersStored: boolean };

export type ProjectAuthType = "none" | "bearer" | "basic" | "api_key";

/**
 * How a project logs in to its API, as it leaves the API.
 *
 * Every secret — `token`, `loginBody`, `password`, `apiKey` — is either empty or the eight-dot
 * mask. Sending the mask back in an update means «leave it as it was».
 */
export type ProjectAuthView = {
  type: ProjectAuthType;
  loginUrl: string;
  loginMethod: string;
  tokenPath: string;
  username: string;
  headerName: string;
  token: string;
  loginBody: string;
  password: string;
  apiKey: string;
};

/** The latest run of a project, which is what its card calls its health. */
export type ProjectLastRunOf<T> = {
  id: string;
  status: RunStatus;
  startedAt: T;
  finishedAt: T | null;
  totals: RunTotals;
};

export type ProjectSummaryOf<T> = {
  id: string;
  name: string;
  slug: string;
  description: string;
  archivedAt: T | null;
  baseUrl: string;
  /** The environment every screen starts from; null while the project has none. */
  activeEnvironmentId: string | null;
  tags: string[];
  auth: ProjectAuthView;
  lastRun: ProjectLastRunOf<T> | null;
  /** Null is a real state and the UI renders it: a project exists before its first import. */
  contract: ContractSummaryOf<T> | null;
  source: SpecSourceSummary | null;
};

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

/** A credential as it leaves the API: named, typed, and without the secret in any form. */
export type CredentialSummaryOf<T> = {
  id: string;
  name: string;
  role: string;
  kind: string;
  headerName: string | null;
  updatedAt: T;
};

/**
 * A variable as the browser sees it.
 *
 * `initial` is the shared value, `current` the one a run actually spends — the pair exists so that
 * a debugging session does not rewrite what the rest of the team pulls. A `sensitive` one arrives
 * masked, in both fields; sending the mask back means «leave it as it was», which is the only way
 * an editor can save a form it was never shown the secret of.
 */
export type EnvironmentVariableView = { initial: string; current: string; sensitive: boolean };

/**
 * What a masked secret is, exactly.
 *
 * A *type* and not a constant, because this package emits no runtime — and it is better this way:
 * both sides declare their own `MASKED_VALUE` annotated with this, so a mask that stopped matching
 * is a compile error in the file that changed it, not a secret that silently starts saving itself
 * as eight dots. Eight of them regardless of the length of the value, which is not the API's to
 * disclose.
 */
export type MaskedValue = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

export type EnvironmentSummaryOf<T> = {
  id: string;
  name: string;
  baseUrl: string;
  specUrl: string | null;
  /** Project-owned values available as `{{name}}` in paths, parameters and JSON bodies. */
  variables: Record<string, EnvironmentVariableView>;
  /**
   * The ones that are switched off: kept, and not substituted.
   *
   * They are a second map rather than a flag inside the first so that `variables` keeps meaning
   * what it means everywhere else — what a run substitutes — and no consumer has to remember to
   * filter. A name is in one map or the other, never in both.
   */
  disabledVariables: Record<string, EnvironmentVariableView>;
  writesAllowed: boolean;
  authEnforced: boolean;
  /** The project's active environment. Exactly one is, whenever there is any. */
  active: boolean;
  credentials: CredentialSummaryOf<T>[];
};

/**
 * The token a person captured in a project — from its login, or set by a script as `token`.
 *
 * The token itself never leaves the API; this is what the bar shows about it. `claims` is the JWT
 * payload undecoded-and-unverified, or null when the token is not a JWT.
 */
export type SessionTokenViewOf<T> = {
  source: "login" | "script";
  capturedAt: T;
  expiresAt: T | null;
  expired: boolean;
  claims: Record<string, unknown> | null;
  preview: string;
};

// ---------------------------------------------------------------------------------------------
// Reusable requests and the flows composed from them
// ---------------------------------------------------------------------------------------------

/**
 * Where a value is read out of a response.
 *
 * `body` and `header` are for an API designed to be read by a program. `cookie` and `regex` exist
 * because plenty are not: a session arrives inside a `Set-Cookie` whose header value carries every
 * attribute with it, and sometimes the value is embedded in text somebody else designed.
 */
export type CaptureSource = "body" | "header" | "cookie" | "regex";

/** A value read out of one response and published as a variable the next requests can spend. */
export type WorkflowCaptureView = { variable: string; from: CaptureSource; path: string };

/** A claim the author of a step wrote by hand, on top of the ones derived from the contract. */
export type StepCheckView = {
  label?: string;
  source: "status" | "body" | "header" | "durationMs";
  path?: string;
  operator: string;
  value?: unknown;
  severity?: "error" | "warning";
};

/** Repeating a step that failed. `onStatus` restricts it to the answers worth repeating; without
 * it any failure is retried, and a step that writes will write once per attempt. */
export type StepRetryView = { attempts: number; delayMs: number; backoff?: number; onStatus?: number[] };

/** The token a step's response yields, and the header the rest of the run sends it in. */
export type StepAuthorizesView = { from: CaptureSource; path: string; header?: string; scheme?: string };

/** Whether a step runs at all, decided by what a step it depends on answered. */
export type StepConditionView = { from: string; check: StepCheckView };

/** Running one step once per element of a list a step it depends on returned. Each element is its
 * own case: forty products answering is forty findings, not one. */
export type StepForEachView = { from: string; path: string; as: string; max?: number };

/**
 * What a node is on the canvas — the palette the editor draws, each shape added on its own and
 * wired to the rest by hand.
 *
 * - `request` — sends an HTTP call. The default when the field is absent, so every flow written
 *   before the palette existed keeps working.
 * - `login` — a request whose answer becomes the credential the rest of the run presents. Same
 *   HTTP as a `request`, plus `authorizes`.
 * - `branch` — the `If`: sends nothing, reads a step and splits the flow into a «sí» and a «no».
 * - `wait` — pauses, then lets the flow through. No request.
 * - `merge` — a join: waits for the branches into it, then continues. No request.
 * - `validate` — reads a step's response and judges it with checks and/or a script. No request.
 * - `fetch` — sends an HTTP call written on the node (any URL, method, headers, body) instead of a
 *   saved request. Its answer feeds captures, checks, an `If` or a validation like any other.
 * - `set` — writes variables from templates (`{{otra}}`, `{{$uuid}}`) for the steps after it. No request.
 * - `script` — runs JS in the isolated sandbox; can read a step's response and write variables. No request.
 */
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
  | "loop";

/** A `loop` node: the list at `path` in `from`'s response, each element bound as `as` (and `as.field`),
 * at most `max` (50) times. Its body is the nodes wired to its «cada» output (`inLoop`) and everything
 * downstream of them; they run once per element, before the «fin» side. */
export type StepLoopView = { from: string; path: string; as: string; max?: number };

/** A `poll` node: re-sends `from`'s request, up to `attempts` times `delayMs` apart, until the node's
 * `checks` pass on the answer. `from` must be a request or fetch node this one depends on. */
export type StepPollView = { from: string; attempts: number; delayMs: number };

/** A `set` node: each assignment is a variable name and a template resolved when the node runs. */
export type StepSetView = { assignments: { variable: string; value: string }[] };

/** A `script` node: code run in the isolated sandbox with the `pm` API. `from` names a step whose
 * response it reads as `pm.response`. What it writes lives for the run only, never in the
 * stored environment. */
export type StepScriptView = { code: string; from?: string };

/** A `fetch` node's call. `url` is absolute or a path resolved against the environment's base URL;
 * every text accepts `{{variables}}`. `expectedStatus` absent means any 2xx. `useSession` presents
 * the credential a login obtained — off by default, so a token never leaves for another host
 * unless the author says so. */
export type StepFetchView = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  body?: string;
  expectedStatus?: number;
  useSession?: boolean;
};

/** Which side of an `If` a node hangs off: the «sí» path (`then`) runs when the branch's condition
 * holds, the «no» path (`else`) when it does not. Absent means the node is not on either side. */
export type StepBranchView = { of: string; take: "then" | "else" };

/** A `validate` node: the step whose response it reads, and an optional script that judges it in
 * an isolated sandbox (the `pm.test(...)` API). Its plain checks live in the step's `checks`. */
export type StepValidateView = { from: string; script?: string };

export type WorkflowStepView = {
  id: string;
  /** Absent on a `branch` node, which sends no request; present on every `request` node. */
  requestTemplateId?: string;
  /** The node's kind. Absent is `request`, so every flow written before branches keeps working. */
  kind?: StepKind;
  /** On a `branch` node: the step it reads and the check that decides «sí» from «no». */
  condition?: StepConditionView;
  /** On a `validate` node: the step whose response it judges, and an optional sandbox script. */
  validate?: StepValidateView;
  /** On a `fetch` node: the call it sends. */
  fetch?: StepFetchView;
  /** On a `set` node: the variables it writes. */
  set?: StepSetView;
  /** On a `script` node: its code and the step it reads, if any. */
  script?: StepScriptView;
  /** On a `poll` node: the step it repeats until its checks pass. */
  poll?: StepPollView;
  /** On a `loop` node: the list it walks. */
  loop?: StepLoopView;
  /** On a node wired to a loop's «cada» output: that loop's id. */
  inLoop?: string;
  /** On any node downstream of an `If`: which of its two paths this node sits on. */
  branch?: StepBranchView;
  dependsOn?: string[];
  /** With several dependencies, whether the step needs all of them or just the first to arrive.
   * Absent means all, which is what a dependency means. */
  waits?: "all" | "any";
  captures?: WorkflowCaptureView[];
  /** Milliseconds to wait before this step. Not a retry: «it was not time yet», not «that failure
   * was not real». */
  waitMs?: number;
  runIf?: StepConditionView;
  forEach?: StepForEachView;
  /** What this step's response yields as the credential the rest of the run presents. It replaces
   * the stored working credential and nothing else: the cases that present a wrong one on purpose
   * keep presenting it. */
  authorizes?: StepAuthorizesView;
  checks?: StepCheckView[];
  retry?: StepRetryView;
  /** What a failure does to the rest of the flow. Absent means `skip-dependents`. */
  onError?: "skip-dependents" | "continue" | "stop";
  /** Where the node sits on the canvas. The engine never reads it; the editor would lose the
   * layout on every reload without it. */
  position?: { x: number; y: number };
};

/**
 * What a saved request sends as its payload.
 *
 * It used to be `Record<string, unknown> | null`, which could only say «this JSON» or «nothing».
 * That is everything the generated matrix has — it derives its payloads from JSON Schema — and it
 * is not everything an API asks for: plenty still take a login as `x-www-form-urlencoded`, and a
 * webhook is tested by posting the exact XML its provider sends.
 *
 * A tagged union and not four optional fields, because «no payload», «this JSON», «these bytes»
 * and «these form fields» are four different things and an object carrying both a `text` and a
 * `json` is a state that must not exist. The switched-off form fields sit in a second map beside
 * the first, like the parameters and the headers above: `fields` means what is sent, everywhere.
 */
export type RequestBodyView =
  | { type: "none" }
  | { type: "json"; json: Record<string, unknown> }
  /** `contentType` travels with the text because this is the case the engine cannot guess: the
   * same three lines could be XML, NDJSON or a CSV, and only the author knows which. */
  | { type: "raw"; text: string; contentType: string }
  | { type: "form-data"; fields: Record<string, string>; disabledFields: Record<string, string> }
  | { type: "x-www-form-urlencoded"; fields: Record<string, string>; disabledFields: Record<string, string> };

/**
 * A saved request. `body` says «none» when there is no payload, which is not the same as an empty
 * one — a JSON body of `{}` is a zero-field object somebody chose to send.
 *
 * The rows somebody switched off live in a **second map beside the first**, never as a flag inside
 * it. It is the shape an environment's `disabledVariables` already has, for the same reason: a
 * parameter you are not sending this week is not one you want to retype next week, and the only
 * way to say so used to be deleting it. Keeping the two apart means `parameters` and `headers` go
 * on meaning everywhere else exactly what they mean here — what gets sent — so nothing downstream
 * has to remember to filter, and the engine never learns the concept at all.
 *
 * `headers` is what a contract cannot declare and a request still needs: an `Accept-Language`, an
 * `X-Tenant`, the idempotency key a POST is supposed to carry. They are merged over the ones the
 * executor builds, so writing one by hand wins — which is what writing one by hand means.
 */
export type RequestTemplateViewOf<T> = {
  id: string;
  name: string;
  operationId: string;
  description: string | null;
  expectedStatus: number;
  parameters: Record<string, string>;
  /** Kept, and not sent. A name is in one map or the other, never in both. */
  disabledParameters: Record<string, string>;
  headers: Record<string, string>;
  disabledHeaders: Record<string, string>;
  body: RequestBodyView;
  auth: string;
  updatedAt: T;
};

/** draft: still being built, no suite offers it. ready: the tested one, green badge. archived:
 * retired but kept, out of the list and the suite pickers. */
export type WorkflowStatusView = "draft" | "ready" | "archived";

export type WorkflowViewOf<T> = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatusView;
  steps: WorkflowStepView[];
  updatedAt: T;
};

/** Both lists together: a node cannot be drawn without the request its step names. */
/**
 * A dataset as the list shows it: what it is called, what its columns are, and how many rows.
 *
 * **Without the rows.** Five hundred rows of nine columns in the payload that draws a page is a
 * download nobody asked for, and the list is not where they are read — they arrive with the
 * dataset when somebody opens it.
 */
export type DatasetViewOf<T> = {
  id: string;
  workflowId: string;
  name: string;
  /** Every name any row uses, sorted. What `{{dataset.x}}` can name. */
  columns: string[];
  rowCount: number;
  updatedAt: T;
};

/** The rows themselves, asked for on purpose. */
export type DatasetRowsView = { id: string; name: string; rows: Record<string, string>[] };

/** An ordered list of flows run as one, with one verdict in the history. */
export type SuiteViewOf<T> = {
  id: string;
  name: string;
  description: string | null;
  workflowIds: string[];
  updatedAt: T;
};

export type WorkflowsViewOf<T> = {
  requestTemplates: RequestTemplateViewOf<T>[];
  workflows: WorkflowViewOf<T>[];
  datasets: DatasetViewOf<T>[];
  suites: SuiteViewOf<T>[];
};

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

/**
 * One claim about a response, as the browser reads it.
 *
 * `severity` is absent on almost all of them and absent means «error»: it failed, so the case
 * failed. A `warning` is a claim that did not hold and is not a broken endpoint — a field the API
 * returned that its own document does not declare, or a step that only passed on the third try.
 * Those are worth showing and must not turn a case red, so anything counting failures has to read
 * this field.
 */
export type Assertion = { label: string; pass: boolean; detail: string; severity?: "error" | "warning" };

export type ScenarioView = {
  id: string;
  name: string;
  description: string;
  expectedStatus: number;
  parameters?: Record<string, string>;
  body?: Record<string, unknown>;
  flow: string;
  auth?: string;
  requestPath: string;
  budget: { ms: number; label: string; source: string } | null;
  /** False when the environment forbids it — a read-only target, or one that does not enforce
   * authorization. `blockedReason` is what the screen shows instead of a red case. */
  runnable: boolean;
  blockedReason?: string;
};

export type OperationScenarios = {
  id: string;
  method: string;
  path: string;
  /** The author's vocabulary, from the contract. */
  tag: string;
  /** This team's, from the `labels` section. Kept beside `tag` and never merged into it: they
   * answer different questions, and a screen that mixed them would make «Pedidos» and «crítico»
   * look like alternatives. */
  labels: string[];
  summary: string;
  implemented: boolean;
  responseShape: string;
  scenarios: ScenarioView[];
};

export type ScenariosView = {
  specVersionId: string;
  contractVersion: string;
  environment: { id: string; name: string; baseUrl: string; writesAllowed: boolean; authEnforced: boolean } | null;
  operations: OperationScenarios[];
  queue: { operationId: string; scenarioId: string }[];
  totals: { operations: number; cases: number; runnable: number; blocked: number };
};

/** A declared response with no case is a run that comes back green having never tried. */
export type CoverageGap = { operationId: string; method: string; path: string; tag: string; status: number };

export type CoverageView = {
  specVersionId: string;
  contractVersion: string;
  totals: { operations: number; declaredResponses: number; covered: number; uncovered: number; cases: number };
  byStatus: { status: number; declared: number; covered: number }[];
  gaps: CoverageGap[];
};

export type ConfigSectionViewOf<T> = { data: unknown; configured: boolean; updatedAt: T | null };
export type ConfigViewOf<T> = { sections: Record<string, ConfigSectionViewOf<T>> };

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export type RunTotals = { cases: number; completed: number; passed: number; failed: number; skipped: number };
export type CaseStatus = "queued" | "running" | "passed" | "failed" | "skipped";
export type RunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";

/**
 * Whose problem a red case is.
 *
 * A list of forty red rows costs the same to triage per row until this exists: a target that
 * answered 5xx, a response whose shape broke its own contract, and a run that never left because a
 * variable was missing are three conversations with three different people, and they were all the
 * same colour.
 */
export type FailureKind = "network" | "config" | "server" | "status" | "contract" | "check" | "flow" | "latency";

export type RunCaseOf<T> = {
  id: string;
  operationId: string;
  scenarioId: string;
  method: string;
  path: string;
  status: CaseStatus;
  /** Null while it passed, was skipped, or has not run. Absent on rows written before this
   * existed, which is why it is optional rather than `FailureKind | null`. */
  failure?: FailureKind | null;
  position: number;
  durationMs: number | null;
  startedAt?: T | null;
  finishedAt?: T | null;
};

/**
 * What a run was launched to execute, said in words rather than in ids.
 *
 * There are three ways to start one now — the generated matrix, one flow (optionally once per row
 * of a dataset), or a suite of flows — and until this existed they were the same row in the
 * history. «¿Esto estaba verde la semana pasada?» is not answerable by a list where every entry
 * looks identical.
 *
 * The names are resolved when the run is read, not stored with it, and a `null` name means the
 * row is gone. That is the honest shape: a run is a record of what happened, and renaming a flow
 * afterwards should change what the history calls it, while deleting one should not turn its runs
 * into a lie about a flow that still exists.
 */
export type RunSource =
  /** `labels` is what the run was *selected by*, and it is kept beside the ids rather than
   * resolved into them: «lo crítico» in March and «lo crítico» in June are the same instruction
   * over a different set, and a history that replaced the words with the list of the day could not
   * say that. */
  | { kind: "matrix"; operationIds: string[]; labels: string[] }
  | {
      kind: "workflow";
      workflowId: string;
      name: string | null;
      datasetId: string | null;
      datasetName: string | null;
      /** How many times the flow was walked. `1` with no dataset. */
      rows: number;
    }
  | { kind: "suite"; suiteId: string; name: string | null; flowNames: (string | null)[] };

export type RunOf<T> = {
  id: string;
  projectId: string;
  environmentId: string | null;
  status: RunStatus;
  totals: RunTotals;
  source: RunSource;
  startedAt: T;
  finishedAt: T | null;
  error: string | null;
};

export type RunStepOf<T> = {
  id: string;
  index: number;
  purpose: string;
  label: string;
  /** Null once a retention sweep has emptied the payloads; `prunedAt` says when. A reader that
   * cannot tell this from «nothing came back» reports an old step as a timeout. */
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null;
  expected: { status: number; shape: string; operationPath: string } | null;
  actual: { status: number; contentType: string; headers: Record<string, string>; body: unknown } | null;
  assertions: Assertion[];
  /**
   * What the request cost, and where.
   *
   * `samples` is the total per repetition — several only on a safe method, because a p95 over a
   * POST would create N resources and change what it measures. `timing` splits the first of them:
   * «tardó 900 ms» is not actionable and «el DNS tardó 850» is.
   */
  latency: {
    samples: number[];
    budgetMs: number | null;
    timing?: { dnsMs: number; ttfbMs: number; downloadMs: number };
  } | null;
  ok: boolean;
  durationMs: number;
  prunedAt?: T | null;
};

/**
 * One request sent from the editor, answered and judged — and not recorded anywhere.
 *
 * The same shape a stored step has, minus everything that only means something inside a run: no
 * id, no index, no purpose, no `prunedAt`. What it adds is `sizeBytes`, which a run does not
 * store and somebody watching a single response wants: «200 en 40 ms» and «200 en 40 ms con 3 MB»
 * are different answers.
 *
 * `response` is null when nothing answered — the connection was refused, or the request never
 * left because a variable was unresolved or the environment forbids writes. The assertions say
 * which, and a reader that cannot tell this from «vino vacío» reports a block as a timeout.
 *
 * Not parameterised over a date type like its neighbours: nothing here was ever stored, so there
 * is no timestamp to serialise. It reads the same on both sides.
 */
export type RequestPreviewView = {
  ok: boolean;
  failure: FailureKind | null;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  expected: { status: number; shape: string; operationPath: string };
  response: {
    status: number;
    contentType: string;
    headers: Record<string, string>;
    body: unknown;
    sizeBytes: number;
  } | null;
  assertions: Assertion[];
  latency: {
    samples: number[];
    budgetMs: number | null;
    timing?: { dnsMs: number; ttfbMs: number; downloadMs: number };
  };
  durationMs: number;
};

/** A run with its case list and **without the steps**: the progress screen polls this, and the
 * steps hold whole response bodies. */
export type RunViewOf<T> = RunOf<T> & { cases: RunCaseOf<T>[] };
export type RunCaseViewOf<T> = RunCaseOf<T> & { steps: RunStepOf<T>[] };

/** The whole run as a report: every case, every assertion, no bodies. What a pipeline reads. */
export type RunReportStep = {
  index: number;
  purpose: string;
  label: string;
  ok: boolean;
  durationMs: number;
  assertions: Assertion[];
};
export type RunReportCase = {
  id: string;
  operationId: string;
  scenarioId: string;
  method: string;
  path: string;
  status: CaseStatus;
  steps: RunReportStep[];
};
export type RunReportOf<T> = { run: RunOf<T>; cases: RunReportCase[] };

// ---------------------------------------------------------------------------------------------
// The wire: every shape above, as JSON delivers it
// ---------------------------------------------------------------------------------------------

/**
 * An endpoint of a project: written by hand, imported from a file or a cURL, or taken from the
 * contract. The request parts are stored as rows, so a switched-off row and the value of a path
 * parameter survive a reload; a file chosen for upload does not — only its field name is kept.
 */
export type EndpointMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type EndpointStatus = "active" | "archived" | "inactive";
export type EndpointOrigin = "manual" | "import" | "contract";
export type ParameterType = "string" | "number" | "boolean" | "uuid" | "array";
export type EndpointPathParameterView = { name: string; type: ParameterType; description: string; value: string };
export type EndpointQueryParameterView = {
  name: string;
  type: ParameterType;
  required: boolean;
  description: string;
  value: string;
  enabled: boolean;
};
export type EndpointHeaderView = { name: string; value: string; enabled: boolean };
export type EndpointFormFieldView = { name: string; value: string; kind: "text" | "file"; enabled: boolean };
export type EndpointBodyMode = "none" | "json" | "raw" | "form-data" | "x-www-form-urlencoded" | "binary";
export type EndpointBodyView = {
  mode: EndpointBodyMode;
  text: string;
  contentType: string;
  fields: EndpointFormFieldView[];
};

export type EndpointViewOf<T> = {
  id: string;
  method: EndpointMethod;
  path: string;
  description: string;
  pathParameters: EndpointPathParameterView[];
  query: EndpointQueryParameterView[];
  headers: EndpointHeaderView[];
  body: EndpointBodyView;
  requiresAuth: boolean;
  tags: string[];
  status: EndpointStatus;
  origin: EndpointOrigin;
  operationId: string | null;
  orderIndex: number;
  preRequestScript: string;
  postResponseScript: string;
  createdAt: T;
  updatedAt: T;
  updatedBy: string;
  /** Whether the active contract declares this method and path; `null` without a contract. */
  inContract: boolean | null;
};

export type EndpointPageOf<T> = {
  data: EndpointViewOf<T>[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  counts: Record<EndpointStatus, number>;
  hasContract: boolean;
};

export type EndpointImportResult = {
  format: "openapi" | "postman" | "insomnia" | "markdown";
  imported: { id: string; method: string; path: string }[];
  skipped: { method: string; path: string; name: string; reason: string }[];
};

/** What «Send» answers: the request as sent (credentials masked) and the target's response. */
export type SentRequestView = {
  request: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    sizeBytes: number;
    durationMs: number;
    timing: { dnsMs: number; ttfbMs: number; downloadMs: number };
  } | null;
  error: string | null;
  auth: string;
  environment: { id: string; name: string } | null;
  /** What each script did, or null when that script is empty. */
  scripts: { pre: ScriptRunView | null; post: ScriptRunView | null };
  /** Set when this request captured a session token, and how. */
  sessionToken: "login" | "script" | null;
};

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

export type DataScope = "all" | "own" | "none";
/** A missing permission is `undecided`: it generates no case, and the screen says so. */
export type RoleAccess = "allow" | "deny" | "undecided";

export type RoleViewOf<T> = {
  id: string;
  name: string;
  description: string;
  color: string;
  sameRoleDataIsolation: boolean;
  position: number;
  createdAt: T;
  updatedAt: T;
  /** Endpoints this role was decided to reach, and to be refused. */
  allowed: number;
  denied: number;
};

export type RolePermissionView = { endpointId: string; access: Exclude<RoleAccess, "undecided">; dataScope: DataScope };
export type EndpointRoleAccessView = {
  roleId: string;
  name: string;
  color: string;
  access: RoleAccess;
  dataScope: DataScope;
};
export type RoleRuleView = {
  sourceRoleId: string;
  targetRoleId: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
};

/** One script's run, as the console shows it. Secrets in the output are already masked. */
export type ScriptRunView = {
  error: string | null;
  logs: { level: "log" | "info" | "warn" | "error"; text: string }[];
  tests: { name: string; passed: boolean; message: string | null }[];
  /** Names of the environment variables whose current value it changed. */
  environmentUpdates: string[];
  durationMs: number;
};

// ---------------------------------------------------------------------------------------------
// Security runs
// ---------------------------------------------------------------------------------------------

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";
export type SecurityRisk = "critical" | "high" | "medium" | "low";
export type SecurityRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";

/** One vulnerability the rules found. `endpointId` is null for a run-wide one. */
export type SecurityFinding = {
  ruleKey: string;
  ruleId: string;
  ruleName: string;
  category: string;
  severity: SecuritySeverity;
  endpointId: string | null;
  title: string;
  detail: string;
  remediation: string;
  references: string[];
  reproduce: string[];
  evidence: Record<string, unknown>;
};

/** One request the run sent and what came back. The Authorization is masked in `headers`. */
export type SecurityProbe = {
  id: string;
  endpointId: string;
  testType: string;
  method: string;
  path: string;
  credential: string | null;
  headers: Record<string, string>;
  body: string | null;
  status: number;
  responseHeaders: Record<string, string>;
  bodyText: string;
  bodyBytes: number;
  durationMs: number;
  error: string | null;
  note: string;
};

export type SecuritySummary = {
  score: number;
  risk: SecurityRisk;
  findings: number;
  bySeverity: Record<SecuritySeverity, number>;
  endpointsTested: number;
  unprotected: { endpointId: string; method: string; path: string; status: number }[];
};

export type SecurityRunProgress = {
  phase: string;
  percentage: number;
  detail: string;
  endpointsTested: number;
  endpointsTotal: number;
};

export type SecurityRunAi = {
  executiveSummary: string;
  scoreJustification: string;
  top: { title: string; description: string; severity: SecuritySeverity }[];
  groups: { ruleKey: string; solution: string; commonFix: string; codeExample: string | null }[];
};

/** The list view: the head of a run, no findings or probes. */
export type SecurityRunSummaryView = {
  id: string;
  label: string;
  status: SecurityRunStatus;
  score: number | null;
  risk: SecurityRisk | null;
  summary: SecuritySummary | null;
  visibility: "private" | "public";
  startedAt: string;
  finishedAt: string | null;
};

/** The detail view: the head, its findings (filtered, worst first) and a page of probes. */
export type SecurityRunDetailView = {
  id: string;
  projectId: string;
  environmentId: string;
  label: string;
  status: SecurityRunStatus;
  rules: Record<string, boolean>;
  options: {
    rateLimitIterations: number;
    requestTimeoutMs: number;
    crossUserPermutations: boolean;
    endpointIds: string[];
    adminRole: string | null;
  };
  progress: SecurityRunProgress;
  score: number | null;
  risk: SecurityRisk | null;
  summary: SecuritySummary | null;
  findings: SecurityFinding[];
  findingsTotal: number;
  probes: { data: SecurityProbe[]; page: number; pageSize: number; total: number };
  ai: SecurityRunAi | null;
  visibility: "private" | "public";
  shareToken: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

// ---------------------------------------------------------------------------------------------
// Performance (load testing)
// ---------------------------------------------------------------------------------------------

export type LoadProfileTypeView = "constant" | "ramp" | "spike";
export type PerfCheckSourceView = "status" | "durationMs" | "body";
export type PerfCheckOperatorView = "equals" | "not_equals" | "less_than" | "greater_than" | "contains" | "exists";

export type PerformanceExtractView = { variable: string; path: string };
export type PerformanceCheckView = {
  source: PerfCheckSourceView;
  path?: string;
  operator: PerfCheckOperatorView;
  value?: unknown;
};
export type PerformanceRequestView = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  extract?: PerformanceExtractView[];
  checks?: PerformanceCheckView[];
};
export type PerformanceScenarioView = {
  id: string;
  name: string;
  weight: number;
  thinkMs: number;
  requests: PerformanceRequestView[];
};
export type LoadProfileView =
  | { type: "constant"; vus: number; durationS: number }
  | { type: "ramp"; startVus: number; endVus: number; durationS: number }
  | { type: "spike"; baseVus: number; peakVus: number; durationS: number };
export type PerformanceThresholdsView = { p95Ms?: number; p99Ms?: number; maxErrorRate?: number; minRps?: number };
export type PerformancePlanDefinitionView = {
  scenarios: PerformanceScenarioView[];
  profile: LoadProfileView;
  thresholds: PerformanceThresholdsView;
};

export type PerformancePlanViewOf<T> = {
  id: string;
  name: string;
  description: string | null;
  definition: PerformancePlanDefinitionView;
  updatedAt: T;
};

export type PerformanceRunStatusView = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";

export type PerformanceSummaryView = {
  requests: number;
  failures: number;
  errorRate: number;
  rps: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
};
export type PerformanceWindowView = {
  atS: number;
  requests: number;
  failures: number;
  rps: number;
  errorRate: number;
  p95Ms: number;
  vus: number;
};
export type PerformanceEndpointStatView = {
  method: string;
  path: string;
  requests: number;
  failures: number;
  errorRate: number;
  p95Ms: number;
  avgMs: number;
};
export type PerformanceThresholdResultView = { label: string; ok: boolean; actual: string; limit: string };

/** The list row: the head of a run and its summary, no windows or per-endpoint detail. */
export type PerformanceRunSummaryViewOf<T> = {
  id: string;
  planId: string | null;
  planName: string;
  status: PerformanceRunStatusView;
  summary: PerformanceSummaryView | null;
  startedAt: T;
  finishedAt: T | null;
};

/** The detail view: everything a run produced. */
export type PerformanceRunDetailViewOf<T> = {
  id: string;
  projectId: string;
  planId: string | null;
  planName: string;
  environmentId: string | null;
  status: PerformanceRunStatusView;
  definition: PerformancePlanDefinitionView;
  progress: { elapsedS: number; totalS: number; requests: number; vus: number };
  summary: PerformanceSummaryView | null;
  windows: PerformanceWindowView[];
  endpoints: PerformanceEndpointStatView[];
  thresholds: PerformanceThresholdResultView[];
  error: string | null;
  startedAt: T;
  finishedAt: T | null;
};

/** One run's head as it appears on either side of a comparison — no windows, just the summary. */
export type PerformanceComparisonRunViewOf<T> = {
  id: string;
  planName: string;
  status: PerformanceRunStatusView;
  startedAt: T;
  summary: PerformanceSummaryView | null;
};

/** A metric read on both runs. `delta` is target minus base; `pct` is that over base (null when
 * base is 0). `better` names the run that wins on this metric — lower for latency and error rate,
 * higher for throughput — or `"same"` when they tie. */
export type PerformanceMetricDeltaView = {
  metric: "rps" | "errorRate" | "avgMs" | "p50Ms" | "p90Ms" | "p95Ms" | "p99Ms" | "maxMs";
  label: string;
  base: number;
  target: number;
  delta: number;
  pct: number | null;
  better: "target" | "base" | "same";
};

/** An endpoint aligned by method+path across the two runs. A side is null when only the other run
 * exercised it. Deltas are filled only when both sides are present. */
export type PerformanceEndpointDeltaView = {
  method: string;
  path: string;
  base: PerformanceEndpointStatView | null;
  target: PerformanceEndpointStatView | null;
  p95Delta: number | null;
  errorRateDelta: number | null;
};

/** A threshold aligned by label. A side is null when that run's plan did not carry it. */
export type PerformanceThresholdDeltaView = {
  label: string;
  base: { ok: boolean; actual: string } | null;
  target: { ok: boolean; actual: string } | null;
};

export type PerformanceComparisonViewOf<T> = {
  base: PerformanceComparisonRunViewOf<T>;
  target: PerformanceComparisonRunViewOf<T>;
  metrics: PerformanceMetricDeltaView[];
  endpoints: PerformanceEndpointDeltaView[];
  thresholds: PerformanceThresholdDeltaView[];
};

// ---------------------------------------------------------------------------------------------
// Code scan (GitHub)
// ---------------------------------------------------------------------------------------------

export type ScanSourceView = "github" | "upload";
export type CodeScanStatusView = "ok" | "error";

/** The connector as a read shows it — the token is never returned, only whether one is stored. */
export type CodeConnectorView = {
  repo: string;
  branch: string;
  basePath: string;
  prefix: string;
  tokenSet: boolean;
  updatedAt: string | null;
};

export type ScannedEndpointView = {
  method: string;
  path: string;
  controller: string;
  handler: string;
  guards: string[];
  roles: string[];
  requiresAuth: boolean;
  file: string;
};
export type ScanEndpointChangeView = { method: string; path: string; id: string; changes: string[] };
export type ScanDiffView = {
  added: ScannedEndpointView[];
  removed: { id: string; method: string; path: string; requiresAuth: boolean }[];
  changed: ScanEndpointChangeView[];
  unchanged: number;
};
export type ScanImpactView = {
  unknownRoles: string[];
  removedWithPermissions: { method: string; path: string; permissions: number }[];
  removedWithFlows: { method: string; path: string; flows: number }[];
};

/** The list row: a scan's head and how big its diff is, no endpoint bodies. */
export type CodeScanSummaryViewOf<T> = {
  id: string;
  source: ScanSourceView;
  ref: string;
  status: CodeScanStatusView;
  controllers: number;
  files: number;
  counts: { added: number; removed: number; changed: number; unchanged: number };
  error: string | null;
  createdAt: T;
};

export type CodeScanDetailViewOf<T> = {
  id: string;
  source: ScanSourceView;
  ref: string;
  status: CodeScanStatusView;
  result: { endpoints: ScannedEndpointView[]; files: number; controllers: number };
  diff: ScanDiffView;
  impact: ScanImpactView;
  error: string | null;
  createdAt: T;
};

// ---------------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------------

/** One project's health at a glance, aggregated across its modules. Nulls mean «never run». */
/** Recent runs of each kind, oldest→newest, for the sparklines on a project card. Each headline is
 * the same number the card shows big; the series is where it has been. */
export type DashboardTrendView = {
  /** 0..100 security scores. */
  securityScores: number[];
  /** 0..1 contract pass rates. */
  passRates: number[];
  /** Load-test p95 in ms. */
  perfP95Ms: number[];
};

export type DashboardProjectView = {
  id: string;
  name: string;
  archived: boolean;
  endpoints: number;
  flows: number;
  securityScore: number | null;
  /** 0..1 over the latest contract run's cases. */
  passRate: number | null;
  perfP95Ms: number | null;
  lastActivityAt: string | null;
  trends: DashboardTrendView;
};

export type DashboardView = {
  totals: { projects: number; endpoints: number; avgSecurityScore: number | null };
  projects: DashboardProjectView[];
};

// ---------------------------------------------------------------------------------------------
// History (standalone analyses across modules)
// ---------------------------------------------------------------------------------------------

export type HistoryKind = "security" | "contract" | "performance" | "scan";

/** One analysis someone ran, whatever module produced it — the unified history row. */
export type HistoryEntryView = {
  id: string;
  projectId: string;
  projectName: string;
  kind: HistoryKind;
  /** A short human line: «Corrida de seguridad», «Plan: Carga básica», … */
  title: string;
  status: string;
  /** The headline number for the kind: a score, a pass rate, a p95 — as text, ready to show. */
  metric: string | null;
  /** Where to open it. */
  href: string;
  createdAt: string;
};

export type HistoryPageView = { entries: HistoryEntryView[]; total: number; page: number; pageSize: number };

// ---------------------------------------------------------------------------------------------
// Import from another project (element by element)
// ---------------------------------------------------------------------------------------------

/** What a source project offers to copy, so the target can pick element by element. */
export type ImportPreviewView = {
  endpoints: { id: string; method: string; path: string }[];
  workflows: { id: string; name: string; steps: number }[];
  environments: { id: string; name: string }[];
};

/** What crossed and what was left, after a selective import. */
export type ImportElementsResultView = {
  endpoints: number;
  workflows: number;
  environments: number;
  skipped: { what: string; detail: string }[];
};

export type Member = MemberOf<string>;
export type PendingInvitation = PendingInvitationOf<string>;
export type MembersView = MembersViewOf<string>;
export type ApiTokenView = ApiTokenViewOf<string>;
export type ContractSummary = ContractSummaryOf<string>;
export type ProjectSummary = ProjectSummaryOf<string>;
export type CredentialSummary = CredentialSummaryOf<string>;
export type Environment = EnvironmentSummaryOf<string>;
export type RoleView = RoleViewOf<string>;
export type SessionTokenView = SessionTokenViewOf<string>;
export type RequestTemplateView = RequestTemplateViewOf<string>;
export type WorkflowView = WorkflowViewOf<string>;
export type WorkflowsView = WorkflowsViewOf<string>;
export type DatasetView = DatasetViewOf<string>;
export type SuiteView = SuiteViewOf<string>;
export type ConfigSectionView = ConfigSectionViewOf<string>;
export type ConfigView = ConfigViewOf<string>;
export type RunCase = RunCaseOf<string>;
export type Run = RunOf<string>;
export type RunStep = RunStepOf<string>;
export type RunView = RunViewOf<string>;
export type RunCaseView = RunCaseViewOf<string>;
export type RunReport = RunReportOf<string>;
export type EndpointView = EndpointViewOf<string>;
export type EndpointPage = EndpointPageOf<string>;
export type PerformancePlanView = PerformancePlanViewOf<string>;
export type PerformanceRunSummaryView = PerformanceRunSummaryViewOf<string>;
export type PerformanceRunDetailView = PerformanceRunDetailViewOf<string>;
export type PerformanceComparisonRunView = PerformanceComparisonRunViewOf<string>;
export type PerformanceComparisonView = PerformanceComparisonViewOf<string>;
export type CodeScanSummaryView = CodeScanSummaryViewOf<string>;
export type CodeScanDetailView = CodeScanDetailViewOf<string>;

/** RFC 9457, which is what every error in this system is written as. */
export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: { field: string; detail: string }[];
};
