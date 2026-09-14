/**
 * The security matrix as data: what is asked of a target, what came back, and what that means.
 *
 * The whole package is pure. It plans HTTP probes and reads their results; it never opens a socket.
 * The API sends each probe through its SSRF guard and its credential store, then hands the results
 * back here to be judged — the same split the contract matrix already uses, and the reason a rule
 * can be asserted with a fixture instead of a server.
 *
 * This is deliberately **not** the analyzer's design, which ran user requests from the browser and
 * pointed at any URL a project typed. Here a probe is a plan the executor is free to refuse.
 */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Worse first, so a sort and a «peor de» read the same way. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** The 17 rules, by the key a run stores and a preset selects. */
export const RULE_KEYS = [
  "bola_idor",
  "bfla",
  "auth_jwt",
  "jwt_attack",
  "cross_user_access",
  "injection",
  "mass_assignment",
  "data_exposure",
  "error_disclosure",
  "verbose_error",
  "rate_limit",
  "security_headers",
  "cors",
  "method_tampering",
  "content_type",
  "endpoint_consistency",
  "response_size_anomaly",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

/** An endpoint as the planner and the rules see it: enough to build a request and to judge one. */
export type EndpointMeta = {
  id: string;
  method: string;
  path: string;
  requiresAuth: boolean;
  operationId: string | null;
  /** `{name}` placeholders in the path, in order — the executor fills them. */
  pathParameters: string[];
  /** A JSON body to send with a write, when the project has one. */
  body: Record<string, unknown> | null;
};

/** A role the run presents, and what the project decided it may reach. */
export type RoleMeta = { name: string; sameRoleDataIsolation: boolean };

export type DataScope = "all" | "own" | "none";
export type PermissionMeta = {
  roleName: string;
  endpointId: string;
  access: "allow" | "deny";
  dataScope: DataScope;
};

/** Whether `target` may read, write and delete data `source` created. */
export type CrossRoleMeta = {
  source: string;
  target: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
};

/**
 * One planned request.
 *
 * `credential` names the role whose token the executor attaches; `null` sends none — that is the
 * unauthenticated probe. `token` overrides that with a literal (a forged JWT for the jwt-attack
 * probes). The executor never invents an auth header the plan did not ask for.
 */
export type Probe = {
  id: string;
  endpointId: string;
  testType: string;
  method: string;
  /** Relative to the environment base URL, with path parameters already substituted. */
  path: string;
  credential: string | null;
  /** A literal Authorization value to send instead of a stored credential. */
  token: string | null;
  headers: Record<string, string>;
  body: string | null;
  contentType: string | null;
  note: string;
};

/** A probe after the executor sent it. `status` 0 means the request never completed. */
export type ProbeResult = Probe & {
  status: number;
  responseHeaders: Record<string, string>;
  bodyText: string;
  bodyBytes: number;
  durationMs: number;
  error: string | null;
  /** Whether an Authorization header actually went out — a role with no credential sends none. */
  sentAuthorization: boolean;
};

export type Finding = {
  ruleKey: RuleKey;
  ruleId: string;
  ruleName: string;
  category: string;
  severity: Severity;
  /** The endpoint it is about, or null for a run-wide finding. */
  endpointId: string | null;
  title: string;
  detail: string;
  remediation: string;
  references: string[];
  reproduce: string[];
  evidence: Record<string, unknown>;
};

export type RuleContext = {
  /** Whether the target actually enforces authorization. When false, the auth cases are not judged:
   * against a backend that grants everything, a 200 means nothing about the endpoint. */
  authEnforced: boolean;
  endpoints: EndpointMeta[];
  roles: RoleMeta[];
  permissions: PermissionMeta[];
  crossRoleRules: CrossRoleMeta[];
};

export interface SecurityRule {
  key: RuleKey;
  id: string;
  name: string;
  category: string;
  references: string[];
  /** Reads the probe results (already narrowed to what the rule cares about) and returns findings. */
  evaluate(results: ProbeResult[], context: RuleContext): Finding[];
}

/** 2xx, the way every rule asks the question. */
export const isSuccess = (status: number): boolean => status >= 200 && status < 300;
export const isDenied = (status: number): boolean => status === 401 || status === 403;

/** The probe results of one endpoint, and every result with a given test type. */
export const byEndpoint = (results: ProbeResult[], endpointId: string): ProbeResult[] =>
  results.filter((result) => result.endpointId === endpointId);
export const byTestType = (results: ProbeResult[], prefix: string): ProbeResult[] =>
  results.filter((result) => result.testType === prefix || result.testType.startsWith(`${prefix}:`));

export const jsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
