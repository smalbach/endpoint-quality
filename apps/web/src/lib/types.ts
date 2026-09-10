/**
 * The shapes the API returns.
 *
 * Hand-written here rather than imported from the server. That is a real duplication and the
 * right one for now: `apps/api` is CommonJS and this is an ESM browser bundle, and pulling the
 * Nest types across would drag Nest's decorators into the front end. `packages/contracts` is
 * where they meet when there is a second consumer — one client does not justify the indirection.
 */
export type Role = "viewer" | "editor" | "admin" | "owner";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  organizations: { id: string; name: string; slug: string; role: Role }[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  archivedAt: string | null;
  contract: { versionId: string; title: string; version: string; operationCount: number; importedAt: string } | null;
  /** Dónde se leyó el contrato la última vez. `headersStored` es un booleano y nada más: la
   * credencial se guarda cifrada precisamente para que ninguna consulta la devuelva. */
  source: { kind: string; location: string; headersStored: boolean } | null;
};

export type Environment = {
  id: string;
  name: string;
  baseUrl: string;
  specUrl: string | null;
  writesAllowed: boolean;
  authEnforced: boolean;
  credentials: { id: string; name: string; role: string; kind: string; headerName: string | null; updatedAt: string }[];
};

export type Assertion = { label: string; pass: boolean; detail: string };

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

/** What the matrix reaches of what the contract declares. `gaps` is the part worth showing: a
 * declared response with no case is a run that comes back green having never tried. */
export type CoverageGap = { operationId: string; method: string; path: string; tag: string; status: number };
export type CoverageView = {
  specVersionId: string;
  contractVersion: string;
  totals: { operations: number; declaredResponses: number; covered: number; uncovered: number; cases: number };
  byStatus: { status: number; declared: number; covered: number }[];
  gaps: CoverageGap[];
};

export type RunTotals = { cases: number; completed: number; passed: number; failed: number; skipped: number };
export type CaseStatus = "queued" | "running" | "passed" | "failed" | "skipped";

export type RunCase = {
  id: string;
  operationId: string;
  scenarioId: string;
  method: string;
  path: string;
  status: CaseStatus;
  position: number;
  durationMs: number | null;
};

export type Run = {
  id: string;
  projectId: string;
  environmentId: string | null;
  status: "queued" | "running" | "passed" | "failed" | "cancelled" | "error";
  totals: RunTotals;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

export type RunView = Run & { cases: RunCase[] };

export type RunStep = {
  id: string;
  index: number;
  purpose: string;
  label: string;
  /** Null once a retention sweep has emptied the payloads; `prunedAt` says when. */
  request: { method: string; url: string; headers: Record<string, string>; body: unknown } | null;
  expected: { status: number; shape: string; operationPath: string } | null;
  actual: { status: number; contentType: string; headers: Record<string, string>; body: unknown } | null;
  assertions: Assertion[];
  latency: { samples: number[]; budgetMs: number | null } | null;
  ok: boolean;
  durationMs: number;
  /** A step whose bodies were retired months later is not a step that never got a response. The
   * screen has to say which, or an old run reads as a wall of timeouts. */
  prunedAt: string | null;
};

export type RunCaseView = RunCase & { steps: RunStep[] };

export type ConfigView = {
  sections: Record<string, { data: unknown; configured: boolean; updatedAt: string | null }>;
};
