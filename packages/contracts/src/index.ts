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
  /** De qué proyecto salió, si es una bifurcación. `parentName` es null si el original ya no está. */
  fork: ProjectForkSummaryOf<T> | null;
};

export type ProjectForkSummaryOf<T> = {
  parentProjectId: string;
  parentName: string | null;
  forkedAt: T;
  syncedAt: T;
  version: number;
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
  | "retry"
  | "loop"
  | "schema"
  | "notify"
  | "subflow"
  | "graphql"
  | "mock"
  | "channel"
  | "webhook";

/** A `graphql` node: one operation sent as `POST` `{query, variables, operationName}` the way a fetch
 * sends its call (URL absolute or under the base URL, session only with `useSession`). `variables` is
 * JSON object text with `{{templates}}`, substituted then parsed. It fails on a non-empty `errors`
 * array unless `allowErrors`; `expectedStatus` absent means any 2xx. */
export type StepGraphqlView = {
  url: string;
  query: string;
  variables?: string;
  operationName?: string;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  useSession?: boolean;
  expectedStatus?: number;
  allowErrors?: boolean;
  /** Cómo entra, como en un `fetch`. Ausente es heredar: la llamada va como está. */
  auth?: RequestAuthView;
};

/** A `notify` node: posts `message` (a template) to the webhook URL held in the environment variable
 * named `urlVariable` — the URL itself is a secret and never lives in the flow. `slack` sends
 * `{text}`, `teams` a MessageCard with `text`, `webhook` `{text, runId, workflowId, stepId}`.
 * `onError` absent is `continue`: a failed delivery only warns unless it is `fail`. */
export type StepNotifyView = {
  channel: "slack" | "teams" | "webhook";
  urlVariable: string;
  message: string;
  onError?: "fail" | "continue";
};

/** A `subflow` node: runs flow `workflowId` of the same project inline. The child starts with a copy of
 * the run's variables plus `inputs` (templates over the parent's); only the names in `outputs` come
 * back. Its steps get their own cases, `workflow:<flow>:<node>>child`, and the node passes when all do.
 * Not archived, no cycles, at most 3 levels, not inside a loop. */
export type StepSubflowView = {
  workflowId: string;
  inputs?: { variable: string; value: string }[];
  outputs?: string[];
};

/** A `mock` node: the response it answers with, no network. `headers` and `body` accept templates
 * (an undefined variable fails the node); `body` is parsed when the content type says JSON.
 * `delayMs` (≤ 60 000) simulates latency. `disabledHeaders` are editor rows switched off. */
export type StepMockView = {
  status: number;
  headers?: Record<string, string>;
  disabledHeaders?: Record<string, string>;
  body?: string;
  delayMs?: number;
};

/** A `webhook` node: the flow waits up to `timeoutMs` (1 s–10 min) for an outside system to call the
 * one-time URL the run publishes when it reaches the node, with `method` (POST when absent). What
 * arrives is the node's response (status 200, the body) for its checks, captures and later nodes. */
export type StepWebhookView = { timeoutMs: number; method?: "POST" | "PUT" };

/**
 * A run waiting on a webhook node: the case, its node, the URL to call and until when.
 *
 * `url` carries the one-time token, which is stored nowhere: it is derived again on every read, and
 * only while the node waits. On the run view (`hooks`) and on the stream's `waiting` event, both for
 * the run's authenticated followers only. Once the wait is over the case's step shows the address
 * with the token masked, and what arrived.
 */
export type RunHookWaitView = {
  caseId: string;
  stepId: string;
  url: string;
  method: "POST" | "PUT";
  expiresAt: string;
};

/** One action of a `channel` node's script: send a text (MQTT: to `topic` with `qos`/`retain`), after
 * `delayMs`; wait until `messages` more arrive, at most `timeoutMs`; or `end` a gRPC client stream. */
export type ChannelScriptStepView =
  | {
      action: "send";
      body: string;
      topic?: string;
      qos?: 0 | 1 | 2;
      retain?: boolean;
      /** Solo Socket.IO, y ahí obligatorio: el evento que se emite. */
      event?: string;
      /** Solo Socket.IO: esperar el acuse del servidor. */
      ack?: boolean;
      delayMs?: number;
    }
  | { action: "wait"; messages: number; timeoutMs: number }
  | { action: "end" };

/** A `channel` node: runs channel `channelId` of the same project as a bounded, non-interactive session
 * and passes when the channel's saved expectations hold (its verdict is the case's). `messages` absent
 * sends the channel's saved messages in order; `[]` only listens. `request` replaces a gRPC call's
 * saved request. The session closes after `untilMessages` received (default: the channel's
 * `minMessages`), when the peer closes, or at a channel cap; `idleMs` can only lower the channel's.
 * Captures read `{messages, last, count, topics, closeCode}` built from the received messages. */
export type StepChannelView = {
  channelId: string;
  messages?: ChannelScriptStepView[];
  request?: string;
  untilMessages?: number;
  idleMs?: number;
};

/** A `schema` node: validates `from`'s response body against the contract's schema for that operation
 * and status (`contract`, only over a saved request or login) or against `json` (`custom`, no
 * `pattern` keyword). `strict` also fails on fields the schema does not declare. */
export type StepSchemaView = { from: string; source: "contract" | "custom"; json?: string; strict?: boolean };

/** A `loop` node: the list at `path` in `from`'s response, each element bound as `as` (and `as.field`),
 * at most `max` (50) times. Its body is the nodes wired to its «cada» output (`inLoop`) and everything
 * downstream of them; they run once per element, before the «fin» side. */
export type StepLoopView = { from: string; path: string; as: string; max?: number };

/** A `poll` node: re-sends `from`'s request, up to `attempts` times `delayMs` apart, until the node's
 * `checks` pass on the answer. `from` must be a request or fetch node this one depends on. */
export type StepPollView = { from: string; attempts: number; delayMs: number };

/** A `retry` node: watches `from` and, when it fails, walks the flow again from `target` (`from` itself
 * or a step upstream of it) down to `from`, up to `attempts` times `delayMs` apart. The nodes that
 * depend on it run only when every attempt failed. `target` is its «reintentar» edge, not a dependency. */
export type StepRerunView = { from: string; target: string; attempts: number; delayMs: number };

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
  /** Cómo entra la llamada. Los secretos van como `{{variables}}`: el documento no los cifra. */
  auth?: RequestAuthView;
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
  /** On a `retry` node: the step it watches and where it walks the flow again from. */
  rerun?: StepRerunView;
  /** On a `loop` node: the list it walks. */
  loop?: StepLoopView;
  /** On a node wired to a loop's «cada» output: that loop's id. */
  inLoop?: string;
  /** On a `schema` node: the step whose body it validates and against what. */
  schema?: StepSchemaView;
  /** On a `notify` node: channel, the environment variable with the webhook URL, and the message. */
  notify?: StepNotifyView;
  /** On a `subflow` node: the flow it runs, its inputs and the variables it hands back. */
  subflow?: StepSubflowView;
  /** On a `graphql` node: the operation it sends. */
  graphql?: StepGraphqlView;
  /** On a `mock` node: the simulated response. */
  mock?: StepMockView;
  /** On a `channel` node: the channel it runs and its script. */
  channel?: StepChannelView;
  /** On a `webhook` node: how long it waits for the outside call, and with which verb. */
  webhook?: StepWebhookView;
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
  | { kind: "suite"; suiteId: string; name: string | null; flowNames: (string | null)[] }
  /** Un canal ejecutado sin flujo: la corrida de un monitor de canal. Un solo caso. */
  | { kind: "channel"; channelId: string; name: string | null };

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
export type RunViewOf<T> = RunOf<T> & {
  cases: RunCaseOf<T>[];
  /** Where a run launched to wait for a person is waiting now: the case about to execute and its
   * node. Null or absent while it is not waiting. */
  paused?: RunPauseView | null;
  /** The webhook nodes waiting for their outside call right now, with the URL to call. Absent or
   * empty when none is. */
  hooks?: RunHookWaitView[];
};
/** A waiting run's position. `stepId` is null outside a flow. */
export type RunPauseView = { caseId: string; stepId: string | null };
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
export type EndpointBodyMode = "none" | "json" | "raw" | "form-data" | "x-www-form-urlencoded" | "binary" | "graphql";
export type EndpointBodyView = {
  mode: EndpointBodyMode;
  /** JSON y raw; en `graphql`, la operación. */
  text: string;
  contentType: string;
  fields: EndpointFormFieldView[];
  /** Las variables de una operación GraphQL, texto JSON con `{{plantillas}}`. Solo si hay. */
  variables?: string;
};

/**
 * Los tipos de autenticación, con los mismos nombres que Postman.
 *
 * `inherit` usa la del proyecto, que es lo que hacía todo antes de que estos existieran; `none` es
 * una decisión distinta —esta petición no se autentica aunque el proyecto sí—, y se guardan aparte.
 */
export const AUTH_TYPE_VIEWS = [
  "none",
  "inherit",
  "basic",
  "bearer",
  "apikey",
  "jwt",
  "digest",
  "oauth1",
  "oauth2",
  "hawk",
  "awsv4",
  "edgegrid",
  "ntlm",
] as const;
export type AuthTypeView = (typeof AUTH_TYPE_VIEWS)[number];

/**
 * Cómo entra una petición. Los parámetros van por nombre, como en el fichero de Postman.
 *
 * **Ningún secreto literal viaja aquí.** Una contraseña, una clave o un token se guardan vacíos y
 * su valor vive en una variable sensible del entorno, que es lo único cifrado: lo que se ve en este
 * mapa es `{{nombre}}` o nada.
 */
export type RequestAuthView = { type: AuthTypeView; params: Record<string, string> };

export type EndpointViewOf<T> = {
  id: string;
  method: EndpointMethod;
  path: string;
  description: string;
  pathParameters: EndpointPathParameterView[];
  query: EndpointQueryParameterView[];
  headers: EndpointHeaderView[];
  body: EndpointBodyView;
  /** Si *necesita* autenticación, que es lo que leen las pruebas de seguridad y la matriz. */
  requiresAuth: boolean;
  /** Cuál, que es lo que hace falta para enviarla. */
  auth: RequestAuthView;
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

/**
 * What one import answers, for the dialog that shows the plan before it runs.
 *
 * One entry per thing handed over, whatever it turned out to be, and inside it one result per
 * destination it reached. A list and not a count, and a `reason` in words for what could not be
 * read: «no se reconoce» is not something anybody can act on, and «es una colección v1, expórtala
 * como v2.1» is.
 */
export type ImportKindView =
  | "postman-collection"
  | "postman-environment"
  | "postman-dump"
  | "openapi"
  | "insomnia"
  | "curl"
  /** Un HAR del navegador: el único formato que trae además las respuestas, como ejemplos. */
  | "har"
  /** A project exported by this product, which used to have an import door of its very own. */
  | "eq-bundle"
  | "unknown";

export type ImportedItemResult = {
  /** What the thing is called: the file's name, or what the document calls itself. */
  name: string;
  kind: ImportKindView;
  /** What is inside it. One piece for a file; several for a Postman data dump. */
  pieces: {
    kind: Exclude<ImportKindView, "postman-dump" | "unknown">;
    name: string;
    /** What is inside, counted — «53 peticiones · 6 carpetas» — or null when there is nothing to count. */
    detail: string | null;
  }[];
  /** Why nothing could be read, or null. */
  reason: string | null;
  /** What each destination did. Empty on a dry run, and empty for an unreadable item. */
  results: {
    target: "contract" | "endpoints" | "flows" | "environment" | "project";
    name: string;
    /** What it did, in one line, or null when it failed. */
    summary: string | null;
    error: string | null;
    notes?: string[];
    /**
     * What was created, when the destination creates things that have an address of their own.
     *
     * Only `endpoints` fills it, and it is here so the summary can *lead somewhere*: «12 nuevos»
     * with no way to reach one of them leaves the person doing by hand the search the import was
     * supposed to save. Absent on a dry run and on the destinations that write a single thing the
     * screen already knows how to reach — a contract, an environment.
     */
    endpoints?: { id: string; method: string; path: string }[];
  }[];
};

/**
 * Lo que contesta exportar el proyecto en formato Postman.
 *
 * El fichero va como `unknown` a propósito: es el formato de **otro** producto, y escribir su
 * esquema aquí sería mantener la definición de Postman en este repositorio y quedarse detrás de
 * ella. Lo que sí se tipa es lo de alrededor —cómo llamar al fichero, cuánto trae, y qué no pudo
 * salir— que es lo que la pantalla necesita saber.
 */
export type PostmanExportResult = {
  kind: "collection" | "endpoints" | "environments" | "dump";
  /** Cómo se llama al bajarlo, con el sufijo que Postman reconoce al volver a leerlo. */
  filename: string;
  file: unknown;
  counts: { collections: number; environments: number };
  /** Un nodo o un valor que Postman no puede expresar, dicho por su nombre. Nunca un silencio. */
  skipped: { what: string; detail: string }[];
};

export type ImportAnythingResult = {
  items: ImportedItemResult[];
  /** True when nothing was written: the answer is the plan, not what happened. */
  dryRun: boolean;
};

/**
 * Capturar tráfico: una sesión del proxy de captura, sin su token.
 *
 * El token se enseña una vez, en `CaptureStartedView`, y no vuelve a salir por ninguna ruta.
 */
export type CaptureSessionView = {
  id: string;
  status: "active" | "stopped";
  stopReason: "manual" | "expired" | "request-limit" | "replaced" | "restart" | null;
  itemCount: number;
  limits: { durationMs: number; maxRequests: number; maxBodyBytes: number };
  startedAt: string;
  expiresAt: string;
  stoppedAt: string | null;
  /** Si la sesión descifra HTTPS con la CA de la instalación (y el dispositivo confía en ella). */
  decryptHttps: boolean;
};

/** Una petición grabada, en la lista en vivo: sin cuerpos, que son lo que pesa. */
export type CaptureItemSummaryView = {
  id: string;
  seq: number;
  at: string;
  method: string;
  /** Con los valores de la query que son credenciales ya tapados. */
  url: string;
  host: string;
  /** `null` en un túnel HTTPS y en una petición que no llegó a contestar. */
  status: number | null;
  /** Un túnel HTTPS: solo se sabe a qué `host:puerto` iba. */
  encrypted: boolean;
  contentType: string;
  durationMs: number;
  error: string | null;
  /** Por qué el import la tiraría —el mismo filtro que un HAR—, o `null` cuando entraría. */
  noise: string | null;
};

/** Una petición grabada, entera. Las credenciales llegan tapadas: se taparon al grabarla. */
export type CaptureItemView = CaptureItemSummaryView & {
  requestHeaders: Record<string, string>;
  requestBody: string;
  requestBodyTruncated: boolean;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseBodyTruncated: boolean;
};

/** Dónde se configura el proxy en el dispositivo. `host` es `null` cuando lo decide la pantalla. */
export type CaptureProxyView = { host: string | null; port: number; username: string };

/**
 * Descifrar HTTPS en este despliegue (`CAPTURE_MITM=true`). `null` en la vista cuando está apagado,
 * y entonces la pantalla no ofrece la opción.
 */
export type CaptureMitmView = {
  /** Lista para usarse: la CA existe y su clave se puede descifrar. */
  ready: boolean;
  /** Por qué no está lista, dicho para quien administra el servidor. */
  problem: string | null;
};

/** La captura de un proyecto: si está activada en este despliegue, y sus sesiones recientes. */
export type CaptureOverviewView = {
  enabled: boolean;
  /** Con el puerto configurado; `null` si la captura está apagada. */
  proxy: CaptureProxyView | null;
  mitm: CaptureMitmView | null;
  sessions: CaptureSessionView[];
};

/** El certificado de la CA de captura: **solo la parte pública**, para instalarla en el dispositivo. */
export type CaptureAuthorityView = {
  pem: string;
  fileName: string;
  /** SHA-256 del certificado, para comprobar en el dispositivo que se instaló la buena. */
  fingerprint: string;
  notAfter: string;
};

/** Lo que contesta abrir una sesión: **la única vez** que sale el token. */
export type CaptureStartedView = { session: CaptureSessionView; token: string; proxy: CaptureProxyView };

/** Una página de la lista en vivo: lo que llegó después del cursor. */
export type CapturePageView = { session: CaptureSessionView; items: CaptureItemSummaryView[] };

/**
 * What importing a Postman environment answers.
 *
 * Counts for what came in, and words for what needs a person: a secret with no value, a name that
 * cannot be a variable here, a base URL taken from one of the variables.
 */
export type PostmanEnvironmentImportResult = {
  id: string;
  name: string;
  /** Whether an environment of that name was already here. */
  action: "created" | "updated";
  baseUrl: string;
  variables: number;
  disabledVariables: number;
  /** How many of them are stored encrypted. */
  secrets: number;
  skipped: { name: string; reason: string }[];
  notes: string[];
};

/**
 * What importing a Postman collection as flows answers.
 *
 * A list and not a count, for the reason every import in this product answers with one: «3 flujos,
 * 2 avisos» is a number nobody can act on, while «Pedidos, actualizado, 7 nodos» and «"Crear": el
 * test se mantiene como script» are two sentences somebody can do something about.
 */
export type PostmanFlowsImportResult = {
  /** What the collection called itself. */
  collection: string;
  flows: {
    id: string;
    name: string;
    /** Whether a flow of that name was already here. Matching by name is what makes a second
     * import of the same collection an update instead of a copy. */
    action: "created" | "updated";
    steps: number;
    /** Nodes over a saved request — the ones the active contract declares. */
    requests: number;
    /** `fetch` nodes: the calls the contract does not declare. */
    calls: number;
    /** `script` nodes: the Postman scripts kept verbatim because they could not be read as checks. */
    scripts: number;
  }[];
  /** The saved requests the import created and rewrote along the way. */
  templates: { created: number; updated: number };
  skipped: { name: string; method: string; url: string; reason: string }[];
  /** Everything worth knowing that is not a failure: a script kept as code, a credential dropped,
   * a collection-level event nobody ran. */
  notes: string[];
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
  /**
   * Qué cookies se presentaron, qué se guardó de la respuesta, y qué no se guardó y por qué.
   *
   * Lo rechazado se enseña. Una cookie que el servidor puso para otro dominio no se guarda, y sin
   * decirlo el resultado es un 401 en la petición siguiente que no se puede explicar.
   */
  cookies: { sent: string[]; stored: string[]; rejected: { line: string; why: string }[] };
};

/**
 * Un ejemplo guardado de un endpoint, como sale de la API.
 *
 * Sale entero, con el cuerpo, al contrario que una cookie o que una variable sensible: lo guardado
 * **ya** pasó por la redacción, así que no hay ningún secreto que pedir aparte. Enseñarlo a medias
 * obligaría a una segunda llamada para leer lo único que un ejemplo tiene que decir.
 */
export type ExampleView = {
  id: string;
  endpointId: string;
  name: string;
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string; enabled: boolean }[];
    body: { text: string; contentType: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string; enabled: boolean }[];
    body: string;
    contentType: string;
    durationMs: number;
  };
  origin: "manual" | "import";
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Lo que ocupa el cuerpo de la respuesta, calculado en el servidor para que la lista no mida. */
  sizeBytes: number;
};

/**
 * Lo que contesta guardar un ejemplo: el ejemplo y **qué se le quitó** por ser una credencial.
 *
 * El parte no es un detalle de cortesía. Un ejemplo que perdió la cabecera de autenticación en
 * silencio se lee como «esto funcionaba sin credencial», y alguien lo va a creer.
 */
export type SavedExampleView = {
  example: ExampleView;
  redaction: {
    droppedHeaders: string[];
    maskedFields: string[];
    /** Falso cuando el cuerpo no es JSON: entonces no se ha mirado dentro, y hay que decirlo. */
    bodyScanned: boolean;
  };
};

/**
 * Un servidor de mocks del proyecto, como sale de la API.
 *
 * Sin `apiKeyHash`: no hace falta para nada en el navegador y es lo único secreto que hay. La clave
 * en claro solo aparece en la respuesta de crearlo o de rotarla, y no vuelve a salir nunca.
 */
export type MockServerView = {
  id: string;
  name: string;
  /** El segmento opaco de la URL: `<prefix>/<publicId>/...`. */
  publicId: string;
  visibility: "public" | "private";
  /** Los primeros y últimos caracteres de la clave, para distinguir dos sin revelar ninguna. */
  apiKeyPreview: string;
  delay: { kind: "none" } | { kind: "fixed"; ms: number } | { kind: "random"; minMs: number; maxMs: number };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

/**
 * La lista de mocks, con **cuántas rutas puede contestar**.
 *
 * El recuento no es adorno: un mock de un proyecto sin ejemplos es una URL que contesta 501 a todo,
 * y eso se descubre cuando el front ya está apuntado. «4 de 12 rutas» lo dice antes.
 */
export type MockListView = {
  mocks: MockServerView[];
  coverage: { withExamples: number; endpoints: number };
  /** El primer segmento de la URL servida, decidido por el servidor y no compuesto en el navegador. */
  prefix: string;
};

/** Crear un mock privado, o rotar su clave: la clave en claro, esta vez y ninguna más. */
export type IssuedMockView = { mock: MockServerView; apiKey: string | null };

/**
 * Una llamada que el mock contestó, como sale de la API.
 *
 * Es a propósito **tan corta**: la petición que llega a un mock es de un tercero y lleva dentro sus
 * credenciales, así que de ella no se guarda ni una cabecera, ni el cuerpo, ni la cadena de
 * consulta. Lo que hay es lo que hace útil la pantalla. El razonamiento entero está en
 * `apps/api/src/modules/mocks/domain/mock-call.ts`.
 */
export type MockCallView = {
  id: string;
  at: string;
  method: string;
  /** La ruta del mock, normalizada y sin la cadena de consulta. */
  path: string;
  status: number;
  /** El ejemplo que se sirvió, o nulo cuando no se sirvió ninguno. */
  exampleId: string | null;
  exampleName: string;
  /** El código del «no»: `mock-no-route`, `mock-wrong-method`, `mock-no-example`… Vacío si acertó. */
  missCode: string;
  /** Lo que costó decidir y servir, sin el retardo simulado. */
  durationMs: number;
};

export type MockCallListView = {
  calls: MockCallView[];
  /** Cuántas se guardan por mock: lo anterior a eso ya no está. */
  keep: number;
};

// ---------------------------------------------------------------------------------------------
// Documentación publicada
// ---------------------------------------------------------------------------------------------

/**
 * Un sitio de documentación publicada, como sale de la API de gestión.
 *
 * Sin `apiKeyHash`, como el mock y por lo mismo. La clave en claro solo aparece al crearlo o al
 * rotarla, y no vuelve a salir nunca.
 */
export type DocSiteView = {
  id: string;
  name: string;
  /** El segmento opaco de la URL pública: `/docs/<publicId>`. */
  publicId: string;
  visibility: "public" | "private";
  apiKeyPreview: string;
  /** Contra qué se pegan los ejemplos de código de la página. Se escribe a mano al publicar: no
   * sale del entorno del proyecto, que está lleno de secretos. */
  baseUrl: string;
  intro: string;
  /** Si los cuerpos de ejemplo guardados salen en la página. Empieza apagado. */
  includeExamples: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

/**
 * La lista, con **qué calidad tendría la página**.
 *
 * «12 rutas, 3 con descripción» dice que esa página va a ser una lista de paths, y lo dice antes de
 * que el enlace salga por correo a otro equipo.
 */
export type DocSiteListView = {
  sites: DocSiteView[];
  coverage: { endpoints: number; described: number; withExamples: number };
  /** El primer segmento de la URL de la página, decidido por el servidor. */
  prefix: string;
};

/** Crear una documentación privada, o rotar su clave: la clave en claro, esta vez y ninguna más. */
export type IssuedDocSiteView = { site: DocSiteView; apiKey: string | null };

/** `masked` dice que ahí había una credencial: el nombre documenta, el valor no se publica. */
export type DocHeaderView = { name: string; value: string; masked: boolean };

export type DocParameterView = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  /** El valor guardado, con sus `{{variables}}` intactas: la página no tiene entorno. */
  example: string;
};

export type DocBodyView = {
  mode: "none" | "json" | "raw" | "form-data" | "x-www-form-urlencoded" | "binary" | "graphql";
  contentType: string;
  /** En `graphql`, la operación. */
  text: string;
  fields: { name: string; value: string; file: boolean }[];
  /** Qué campos se taparon, para decirlo en vez de que los ocho puntos parezcan el valor. */
  masked: string[];
  /** Las variables de una operación GraphQL, tapadas como un cuerpo JSON. Solo si hay. */
  variables?: string;
};

/**
 * De la autenticación sale el tipo y qué hay que mandar. **Nunca un valor.**
 *
 * `keyName` es la excepción: el nombre de la cabecera por la que entra una API key es documentación
 * —sin él no se sabe dónde poner la clave— y no es un secreto. Su valor no sale ni tapado.
 */
export type DocAuthView = {
  type: AuthTypeView;
  label: string;
  detail: string;
  keyName: string;
  in: "header" | "query";
};

export type DocExampleView = {
  name: string;
  status: number;
  contentType: string;
  body: string;
  headers: DocHeaderView[];
};

export type DocEndpointView = {
  id: string;
  method: string;
  path: string;
  /** La URL entera con la base del sitio delante, o la ruta sola si el sitio no tiene base. */
  url: string;
  description: string;
  tags: string[];
  requiresAuth: boolean;
  auth: DocAuthView;
  pathParameters: DocParameterView[];
  query: DocParameterView[];
  headers: DocHeaderView[];
  body: DocBodyView | null;
  examples: DocExampleView[];
};

export type DocGroupView = { tag: string; endpoints: DocEndpointView[] };

// ---------------------------------------------------------------------------------------------
// Monitores
// ---------------------------------------------------------------------------------------------

/**
 * El horario de un monitor.
 *
 * `daily` y `weekly` llevan su zona IANA porque la hora es la de una persona: «a las 9:00» puesto
 * por alguien en Madrid tiene que seguir siendo a las 9:00 cuando cambie la hora, y un turno
 * guardado en UTC se va una hora dos veces al año.
 */
export type MonitorScheduleView =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; timeZone: string }
  /** `weekdays` con 0 = domingo. */
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number; timeZone: string };

/** Qué corrida lanza el monitor: el mismo plan que el botón de «Ejecutar». */
export type MonitorPlanView = {
  environmentId: string;
  workflowId?: string;
  suiteId?: string;
  datasetId?: string;
  operationIds?: string[];
  labels?: string[];
  samples?: number;
  delayMs?: number;
  concurrency?: number;
  stopOnFailure?: boolean;
  /** Un canal en lugar de un flujo: el mismo bloque que el nodo `channel`. */
  channel?: StepChannelView;
};

/**
 * A quién se avisa y cuándo.
 *
 * `urlVariable` es **un nombre**: la URL del webhook vive en el entorno del monitor, cifrada si es
 * sensible. Quien tiene una URL de webhook entrante puede escribir en ese canal, así que es una
 * credencial y no viaja por aquí.
 *
 * `recipients` sí viaja, en claro, y es a propósito: una dirección de correo no autoriza nada
 * —cualquiera puede escribir a ese buzón ya—, y verla es lo que permite saber a quién se está
 * despertando sin abrir el entorno y descifrar un valor.
 *
 * Cada canal trae el suyo y no el otro: los de webhook, `urlVariable`; «email», `recipients`.
 */
export type MonitorAlertView = {
  channel: "slack" | "teams" | "webhook" | "email";
  urlVariable?: string;
  recipients?: string[];
  /** Cuántos fallos seguidos hacen falta para avisar. Avisa una vez al llegar, no en cada turno. */
  afterFailures: number;
};

export type MonitorOutcomeView = "running" | "passed" | "failed" | "error" | "skipped";

/** Una vuelta del monitor. Sobrevive al barrido de retención de corridas: es el historial. */
export type MonitorExecutionView = {
  id: string;
  monitorId: string;
  runId: string | null;
  outcome: MonitorOutcomeView;
  startedAt: string;
  finishedAt: string | null;
  totals: { cases: number; passed: number; failed: number } | null;
  note: string;
};

export type MonitorView = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: MonitorScheduleView;
  plan: MonitorPlanView;
  alert: MonitorAlertView | null;
  /** Cuándo le toca. Nulo cuando está apagado, que es lo que lo apaga de verdad. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: MonitorOutcomeView | null;
  /** Fallos seguidos. Se pone a cero en el primer verde. */
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Cómo se lee el horario, escrito por el servidor. */
  scheduleLabel: string;
};

export type MonitorListView = { monitors: (MonitorView & { recent: MonitorExecutionView[] })[] };

export type MonitorHistoryView = { monitor: MonitorView; executions: MonitorExecutionView[] };

// Canales (WebSocket, MQTT y gRPC)

/**
 * Un canal: lo que se prueba cuando no es una petición: un WebSocket, un broker MQTT o un servicio gRPC.
 *
 * Hermano de un endpoint y no un tipo de él: la matriz, el mock, la documentación publicada y el
 * resto de lectores de endpoints no ven canales, por construcción.
 */
export type ChannelLimitsView = {
  maxMessages: number;
  maxBytes: number;
  maxMessageBytes: number;
  maxDurationMs: number;
  idleMs: number;
};

export type ChannelCheckView = {
  label?: string;
  source: "message" | "messageCount";
  path?: string;
  operator: string;
  value?: unknown;
  severity?: "error" | "warning";
  /** `topic`: solo los mensajes de ese tema MQTT (con `+` y `#`) antes de elegir cuál. */
  match?: {
    at: "first" | "last" | "any" | "all";
    index?: number;
    topic?: string;
    /** `event`: solo los mensajes de ese evento de Socket.IO, por su nombre exacto. */
    event?: string;
  };
};

export type ChannelExpectationView = {
  minMessages?: number;
  closeCode?: number;
  /** El estado gRPC esperado al terminar la llamada: 0 es OK. Solo en un canal gRPC. */
  status?: number;
  firstMessageBudgetMs?: number;
  checks?: ChannelCheckView[];
};

/** Lo propio de un canal MQTT. Usuario y contraseña van en `auth` como `basic`. */
export type MqttSettingsView = {
  /** 4 es 3.1.1 y 5 es 5.0. */
  version: 4 | 5;
  /** Vacío: se inventa uno por sesión. */
  clientId: string;
  keepaliveSec: number;
  cleanSession: boolean;
  subscriptions: { topic: string; qos: 0 | 1 | 2 }[];
  /** El testamento: lo que el broker publica si el cliente se cae sin despedirse. `null`: sin él. */
  will: { topic: string; payload: string; qos: 0 | 1 | 2; retain: boolean } | null;
  /** Propiedades de usuario del `CONNECT`. Solo en 5.0. */
  userProperties: { name: string; value: string }[];
};

/** Servicio, método, mensaje y plazo de un canal gRPC. */
export type GrpcSettingsView = {
  source: "proto" | "reflection";
  service: string;
  method: string;
  /** JSON con `{{variables}}`. */
  message: string;
  deadlineMs: number | null;
};

/**
 * Lo propio de un canal Socket.IO. La carga de `auth` es JSON con `{{variables}}`: el valor escrito a
 * mano de un campo que se llama como una credencial se guarda vacío.
 */
export type SocketIoSettingsView = {
  /** 3 y 4 hablan el mismo protocolo desde el cliente: los dos usan el cliente 4. */
  version: 3 | 4;
  path: string;
  namespace: string;
  auth: string;
  query: { name: string; value: string; enabled: boolean }[];
  /** Oír todos los eventos, o solo los de `events`. */
  listenAll: boolean;
  events: string[];
  transports: ("websocket" | "polling")[];
};

export type ChannelView = {
  id: string;
  protocol: "ws" | "mqtt" | "grpc" | "socketio";
  name: string;
  /** Con `{{variables}}` si hace falta: se resuelve contra el entorno al abrir. */
  url: string;
  subprotocols: string[];
  headers: { name: string; value: string; enabled: boolean }[];
  auth: { type: string; params: Record<string, string> } | null;
  limits: ChannelLimitsView;
  expectations: ChannelExpectationView;
  /** Tramas guardadas, para no reteclear la de auth en cada sesión. En MQTT, con su tema. */
  messages: { name: string; body: string; topic?: string; qos?: 0 | 1 | 2; retain?: boolean; event?: string }[];
  /** Solo en un canal MQTT. */
  mqtt: MqttSettingsView | null;
  /** Solo en un canal gRPC; `null` en los demás. */
  grpc: GrpcSettingsView | null;
  /** Solo en un canal Socket.IO; `null` (o ausente, en un servidor de antes) en los demás. */
  socketio?: SocketIoSettingsView | null;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
};

/** Un mensaje de una conversación, **ya redactado**. `atMs` va desde la apertura. */
export type ChannelMessageView = {
  seq: number;
  /** `event`: una suscripción a mitad de sesión y lo que contestó el broker. No cuenta como mensaje. */
  direction: "out" | "in" | "open" | "close" | "error" | "event";
  atMs: number;
  kind: "text" | "binary" | "ping" | "pong";
  body: string;
  /** El tamaño real: `body` puede venir recortado, y entonces `truncated` lo dice. */
  bytes: number;
  truncated: boolean;
  /** Solo MQTT: el tema (ya tapado), la QoS y si venía retenido. */
  topic?: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  /** Solo MQTT 5, y ya tapadas: propiedades de usuario, tipo de contenido, respuesta y correlación. */
  properties?: {
    userProperties?: [string, string][];
    contentType?: string;
    responseTopic?: string;
    correlationData?: string;
    correlationEncoding?: "text" | "hex";
  };
  /** Solo Socket.IO: el evento (ya tapado). */
  event?: string;
  /** Solo Socket.IO: enviado pidiendo acuse, o recibido que **es** el acuse. */
  ack?: boolean;
};

export type ChannelSessionView = {
  id: string;
  channelId: string;
  environmentId: string | null;
  status: "connecting" | "open" | "closed" | "error";
  /** `via`: qué paso contestó la apertura —`CONNACK` en MQTT—; ausente es el `upgrade`. */
  handshake: { status: number; headers: Record<string, string>; via?: string } | null;
  counters: { sent: number; received: number; bytesIn: number; bytesOut: number };
  closeCode: number | null;
  closeReason: string;
  /** Los trailers de una llamada gRPC, ya tapados. `null` en un WebSocket. */
  trailers: Record<string, string> | null;
  /** Por qué se dejó de escuchar. Alcanzar un tope no es un error: es un hecho de la sesión. */
  stopReason: string | null;
  verdict: {
    ok: boolean;
    failure: string | null;
    assertions: { label: string; pass: boolean; detail: string; severity?: "error" | "warning" }[];
  } | null;
  openedAt: string;
  closedAt: string | null;
  /** Si esta instancia de la API tiene el socket. Sin eso, la sesión se lee y no se usa. */
  live: boolean;
  messages?: ChannelMessageView[];
};

export type ChannelListView = { channels: ChannelView[] };
export type ChannelDetailView = ChannelView & { sessions: ChannelSessionView[] };

/** Un método de un servicio gRPC, como lo enseña el selector. */
export type GrpcMethodView = {
  name: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  /** Declarado `NO_SIDE_EFFECTS`: el único que se invoca en un entorno sin escrituras. */
  readOnly: boolean;
  /** El mensaje de entrada con sus valores por omisión, en JSON con sangría. */
  example: string;
};

/** Lo que el selector sabe de la definición: los `.proto` guardados —sin contenido— y sus servicios. */
export type GrpcSchemaView = {
  files: { path: string; bytes: number }[];
  services: { name: string; methods: GrpcMethodView[] }[];
  problem: string | null;
};

/** La página publicada, tal y como la lee quien abre la URL: sin sesión y sin cuenta aquí. */
export type DocPageView = {
  title: string;
  description: string;
  intro: string;
  baseUrl: string;
  groups: DocGroupView[];
  counts: { endpoints: number; documented: number; examples: number };
  generatedAt: string;
};

/** Una cookie del tarro, como sale de la API. El valor solo va si se pide ver. */
export type CookieView = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiresAt: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "strict" | "lax" | "none" | null;
  hostOnly: boolean;
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
  /**
   * What `pm.visualizer.set` left, for the response's «Visualizar» tab: a Handlebars template and
   * its data and options as JSON text. Rendered by the browser in a sandboxed frame; null when the
   * script did not call it.
   */
  visualization: { template: string; data: string; options: string } | null;
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
  /** Los canales que abren los nodos de los flujos copiados, que viajan con ellos. */
  channels: number;
  skipped: { what: string; detail: string }[];
};

// ---------------------------------------------------------------------------------------------
// Forks: bifurcar, traer cambios y fusionar
// ---------------------------------------------------------------------------------------------

/** Lo que nace al bifurcar, y lo que se quedó en el original a propósito. */
export type ForkCreatedView = {
  projectId: string;
  slug: string;
  copied: {
    endpoints: number;
    requestTemplates: number;
    workflows: number;
    suites: number;
    channels: number;
    environments: number;
    roles: number;
    sections: number;
  };
  skipped: { what: string; detail: string }[];
};

export type ForkMergeKind =
  "endpoint" | "template" | "workflow" | "suite" | "channel" | "environment" | "role" | "section";
export type ForkChange = "none" | "added" | "modified" | "deleted";
/** `incoming` se aplica, `kept` se queda en el destino, `same` coincide y `conflict` pide elegir. */
export type ForkDiffStatus = "incoming" | "kept" | "same" | "conflict";
export type ForkFieldChange = { path: string; base?: unknown; source?: unknown; target?: unknown };

export type ForkDiffEntryView = {
  kind: ForkMergeKind;
  key: string;
  label: string;
  sourceChange: ForkChange;
  targetChange: ForkChange;
  status: ForkDiffStatus;
  fields: ForkFieldChange[];
  /** Emparejado solo por el nombre, sin linaje: dos elementos creados cada uno en su lado. */
  pairedByName?: boolean;
};

/** Una comparación a tres bandas: origen → destino, contra la última foto común. */
export type ForkDiffView = {
  direction: "pull" | "merge";
  /** Se devuelve al aplicar: si alguno de los dos proyectos cambió entretanto, es un 409. */
  token: string;
  version: number;
  syncedAt: string;
  source: { id: string; name: string };
  target: { id: string; name: string };
  entries: ForkDiffEntryView[];
};

export type ForkSyncOutcomeView = {
  direction: "pull" | "merge";
  version: number;
  applied: Record<ForkMergeKind, number>;
  skipped: { what: string; detail: string }[];
};

/** `open` y `approved` esperan una decisión; las otras tres ya la tienen. */
export type MergeRequestStatus = "open" | "approved" | "merged" | "declined" | "closed";
export type MergeRequestEventKind = "comment" | "approved" | "declined" | "merged" | "closed";

/** Una solicitud de fusión en una lista: sin la comparación, que puede ser larga. */
export type MergeRequestSummaryView = {
  id: string;
  title: string;
  status: MergeRequestStatus;
  fork: { id: string; name: string };
  parent: { id: string; name: string };
  author: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  /** Cuántos elementos pedía llevar al crearla, y cuántos de ellos eran conflictos. */
  changes: number;
  conflicts: number;
  comments: number;
  approvals: number;
};

export type MergeRequestEventView = {
  id: string;
  kind: MergeRequestEventKind;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
};

export type MergeRequestDetailView = MergeRequestSummaryView & {
  description: string;
  /** La comparación tal como estaba al crearla: lo que se pidió. */
  requested: ForkDiffEntryView[];
  /** La versión de la bifurcación entonces. */
  requestedVersion: number;
  decidedAt: string | null;
  mergedVersion: number | null;
  events: MergeRequestEventView[];
  /**
   * Lo que se aplicaría ahora, recalculado en cada lectura: es lo que se fusiona, con su huella.
   * `null` si ya no está pendiente o si uno de los dos proyectos ya no se puede comparar
   * (`unavailable` dice por qué).
   */
  current: ForkDiffView | null;
  unavailable: string | null;
  /** Lo que quien la lee puede hacer con ella ahora mismo. */
  can: { approve: boolean; decline: boolean; close: boolean; merge: boolean; comment: boolean };
};

// ---------------------------------------------------------------------------------------------
// Export / import a project as a file
// ---------------------------------------------------------------------------------------------

/** The pieces a project file can carry. Exporting picks some; importing picks among those present. */
export type ProjectBundlePart =
  "settings" | "contract" | "config" | "endpoints" | "roles" | "flows" | "environments" | "performance";

/** What an import wrote, and what it deliberately left out (secrets, duplicates, missing targets). */
export type ProjectBundleImportResultView = {
  parts: ProjectBundlePart[];
  settings: boolean;
  /** The OpenAPI document: imported as a new active version, already there (same bytes), or not in the import. */
  contract: "imported" | "unchanged" | null;
  sections: string[];
  endpoints: number;
  /** Cuántos ejemplos guardados entraron con esos endpoints. */
  examples: number;
  roles: number;
  permissions: number;
  requestTemplates: number;
  workflows: number;
  datasets: number;
  suites: number;
  /** Los canales que los flujos del fichero abren, con sus `.proto`. */
  channels: number;
  environments: number;
  performancePlans: number;
  skipped: { what: string; detail: string }[];
};

export type Member = MemberOf<string>;
export type PendingInvitation = PendingInvitationOf<string>;
export type MembersView = MembersViewOf<string>;
export type ApiTokenView = ApiTokenViewOf<string>;
export type ContractSummary = ContractSummaryOf<string>;
export type ProjectSummary = ProjectSummaryOf<string>;
export type ProjectForkSummary = ProjectForkSummaryOf<string>;
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
