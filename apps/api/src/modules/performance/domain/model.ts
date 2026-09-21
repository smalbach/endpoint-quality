/**
 * Load testing: a saved **plan** somebody runs, and each **run** of it.
 *
 * The two are separated the way a workflow and its run are, and for the same reason: the plan is
 * the thing edited and reused — the scenarios, the shape of the load, the limits it must stay
 * under — while a run is one execution of it against one environment, with the numbers it produced.
 * A plan changes over weeks; a run is a fact about a minute.
 *
 * None of this is the security matrix or the contract runner. A load test does not ask «is this
 * correct», it asks «does it hold at this rate» — so a run stores rates and percentiles, not a
 * verdict per case, and a request is fired thousands of times rather than judged once.
 */

/** One request a virtual user sends, with what it reads out and what it claims about the answer. */
export type PerformanceRequest = {
  method: string;
  /** Relative to the environment's base URL, e.g. `/orders/{{orderId}}`. `{{var}}` is substituted
   * from the environment and from what earlier requests in the same iteration extracted. */
  path: string;
  headers?: Record<string, string>;
  /** A JSON payload, or absent. Sent as-is after `{{var}}` substitution. */
  body?: unknown;
  /** Values read from this response and spent by later requests of the same iteration — a login
   * that yields a token the next request presents. Body only: a load test reads what a program
   * reads. */
  extract?: PerformanceExtract[];
  /** What this response must satisfy to count as a success. A failed check makes the request an
   * error, which is what `errorRate` counts — so a 200 that returns the wrong thing is still a
   * failure, not a silent pass. */
  checks?: PerformanceCheck[];
};

export type PerformanceExtract = { variable: string; path: string };

export const PERF_CHECK_SOURCES = ["status", "durationMs", "body"] as const;
export type PerfCheckSource = (typeof PERF_CHECK_SOURCES)[number];
export const PERF_CHECK_OPERATORS = [
  "equals",
  "not_equals",
  "less_than",
  "greater_than",
  "contains",
  "exists",
] as const;
export type PerfCheckOperator = (typeof PERF_CHECK_OPERATORS)[number];

export type PerformanceCheck = {
  source: PerfCheckSource;
  /** A dot path into the body when `source` is `body`; ignored otherwise. */
  path?: string;
  operator: PerfCheckOperator;
  value?: unknown;
};

/**
 * A weighted sequence of requests one virtual user walks as a unit.
 *
 * The weight is a share, not a count: a scenario of weight 3 next to one of weight 1 is picked
 * three times as often, whatever the total number of iterations turns out to be — which is the only
 * way to say «mostly reads, a few writes» without knowing in advance how many iterations the
 * duration will allow.
 */
export type PerformanceScenario = {
  id: string;
  name: string;
  weight: number;
  /** Pause between requests of an iteration, in milliseconds — the reading time a real user spends
   * that a tight loop does not, and the difference between measuring the API and measuring a `for`. */
  thinkMs: number;
  requests: PerformanceRequest[];
};

/**
 * The shape of the load over time.
 *
 * - `constant` — `vus` at once for `durationS`. The baseline: «can it hold 50 at a time for 2 min».
 * - `ramp` — linearly from `startVus` to `endVus` across `durationS`. Finds the rate where it
 *   starts to bend, which a constant load steps straight over.
 * - `spike` — `baseVus`, a middle third at `peakVus`, back to base. «What a launch tweet does.»
 */
export const LOAD_PROFILE_TYPES = ["constant", "ramp", "spike"] as const;
export type LoadProfileType = (typeof LOAD_PROFILE_TYPES)[number];

export type LoadProfile =
  | { type: "constant"; vus: number; durationS: number }
  | { type: "ramp"; startVus: number; endVus: number; durationS: number }
  | { type: "spike"; baseVus: number; peakVus: number; durationS: number };

/**
 * The limits a run must stay under to pass, all optional.
 *
 * A threshold left out is not checked — a plan that only cares about the error rate says so by
 * leaving the latency limits empty, rather than by inventing a number it does not mean. `minRps`
 * is the one floor among ceilings: throughput is the thing you want *above* a line, not below one.
 */
export type PerformanceThresholds = {
  p95Ms?: number;
  p99Ms?: number;
  /** A fraction in [0, 1]: `0.01` is «at most 1% of requests may fail». */
  maxErrorRate?: number;
  minRps?: number;
};

export type PerformancePlanDefinition = {
  scenarios: PerformanceScenario[];
  profile: LoadProfile;
  thresholds: PerformanceThresholds;
};

export type PerformancePlanRow = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  definition: PerformancePlanDefinition;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
  /** Archivado y borrado blando, como el resto de recursos del proyecto. Ver `shared/lifecycle`. */
  archivedAt: Date | null;
  deletedAt: Date | null;
};

// -----------------------------------------------------------------------------------------------
// Runs
// -----------------------------------------------------------------------------------------------

export const PERFORMANCE_RUN_STATUSES = ["queued", "running", "passed", "failed", "cancelled", "error"] as const;
export type PerformanceRunStatus = (typeof PERFORMANCE_RUN_STATUSES)[number];

/** The percentiles and rates over the whole run — the headline numbers. */
export type PerformanceSummary = {
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

/** One 5-second slice of the run: the live timeline is a list of these. */
export type PerformanceWindow = {
  /** Seconds since the run started, at the window's start. */
  atS: number;
  requests: number;
  failures: number;
  rps: number;
  errorRate: number;
  p95Ms: number;
  /** The virtual users active during this window, so the timeline can be read next to the load. */
  vus: number;
};

/** The same numbers, split per endpoint, so «which one bent» is answerable. */
export type PerformanceEndpointStat = {
  method: string;
  path: string;
  requests: number;
  failures: number;
  errorRate: number;
  p95Ms: number;
  avgMs: number;
};

export type PerformanceThresholdResult = {
  label: string;
  ok: boolean;
  /** What the run measured, and the limit it was compared against, both as text for the report. */
  actual: string;
  limit: string;
};

export type PerformanceRun = {
  id: string;
  projectId: string;
  planId: string | null;
  planName: string;
  environmentId: string | null;
  status: PerformanceRunStatus;
  /** The plan as it was when the run started — a run is a fact and does not change when the plan is
   * edited afterwards. */
  definition: PerformancePlanDefinition;
  progress: { elapsedS: number; totalS: number; requests: number; vus: number };
  summary: PerformanceSummary | null;
  windows: PerformanceWindow[];
  endpoints: PerformanceEndpointStat[];
  thresholds: PerformanceThresholdResult[];
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/** The verdict a finished run earns from its thresholds: all met is `passed`, any missed `failed`.
 * A run with no thresholds passes — there was nothing it could fail. */
export function verdictFrom(thresholds: PerformanceThresholdResult[]): "passed" | "failed" {
  return thresholds.every((threshold) => threshold.ok) ? "passed" : "failed";
}
