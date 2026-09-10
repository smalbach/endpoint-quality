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

export type ProjectSummaryOf<T> = {
  id: string;
  name: string;
  slug: string;
  description: string;
  archivedAt: T | null;
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
  credentials: CredentialSummaryOf<T>[];
};

// ---------------------------------------------------------------------------------------------
// Reusable requests and the flows composed from them
// ---------------------------------------------------------------------------------------------

/** A value read out of one response and published as a variable the next requests can spend. */
export type WorkflowCaptureView = { variable: string; from: "body" | "header"; path: string };

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

export type WorkflowStepView = {
  id: string;
  requestTemplateId: string;
  dependsOn?: string[];
  captures?: WorkflowCaptureView[];
  checks?: StepCheckView[];
  retry?: StepRetryView;
  /** What a failure does to the rest of the flow. Absent means `skip-dependents`. */
  onError?: "skip-dependents" | "continue" | "stop";
  /** Where the node sits on the canvas. The engine never reads it; the editor would lose the
   * layout on every reload without it. */
  position?: { x: number; y: number };
};

/** A saved request. `body` is null when there is none, which is not the same as an empty one. */
export type RequestTemplateViewOf<T> = {
  id: string;
  name: string;
  operationId: string;
  description: string | null;
  expectedStatus: number;
  parameters: Record<string, string>;
  body: Record<string, unknown> | null;
  auth: string;
  updatedAt: T;
};

export type WorkflowViewOf<T> = {
  id: string;
  name: string;
  description: string | null;
  steps: WorkflowStepView[];
  updatedAt: T;
};

/** Both lists together: a node cannot be drawn without the request its step names. */
export type WorkflowsViewOf<T> = {
  requestTemplates: RequestTemplateViewOf<T>[];
  workflows: WorkflowViewOf<T>[];
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
  tag: string;
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

export type RunCaseOf<T> = {
  id: string;
  operationId: string;
  scenarioId: string;
  method: string;
  path: string;
  status: CaseStatus;
  position: number;
  durationMs: number | null;
  startedAt?: T | null;
  finishedAt?: T | null;
};

export type RunOf<T> = {
  id: string;
  projectId: string;
  environmentId: string | null;
  status: RunStatus;
  totals: RunTotals;
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
  latency: { samples: number[]; budgetMs: number | null } | null;
  ok: boolean;
  durationMs: number;
  prunedAt?: T | null;
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

export type Member = MemberOf<string>;
export type PendingInvitation = PendingInvitationOf<string>;
export type MembersView = MembersViewOf<string>;
export type ApiTokenView = ApiTokenViewOf<string>;
export type ContractSummary = ContractSummaryOf<string>;
export type ProjectSummary = ProjectSummaryOf<string>;
export type CredentialSummary = CredentialSummaryOf<string>;
export type Environment = EnvironmentSummaryOf<string>;
export type RequestTemplateView = RequestTemplateViewOf<string>;
export type WorkflowView = WorkflowViewOf<string>;
export type WorkflowsView = WorkflowsViewOf<string>;
export type ConfigSectionView = ConfigSectionViewOf<string>;
export type ConfigView = ConfigViewOf<string>;
export type RunCase = RunCaseOf<string>;
export type Run = RunOf<string>;
export type RunStep = RunStepOf<string>;
export type RunView = RunViewOf<string>;
export type RunCaseView = RunCaseViewOf<string>;
export type RunReport = RunReportOf<string>;

/** RFC 9457, which is what every error in this system is written as. */
export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: { field: string; detail: string }[];
};
