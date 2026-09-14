import type { Finding, ProbeResult, RiskLevel, RuleKey, SecuritySummary, Severity } from "@eq/security-rules";

/**
 * One execution of the security matrix.
 *
 * A row of its own, next to the contract runs but not one of them: what it stores — findings by
 * severity, a score, the probes that produced them — is a different shape, and folding it into the
 * contract run would make both tables lie about half their columns.
 *
 * The credentials it ran with are **never here**. They arrive in the start request, are held in
 * the queue's memory while the worker uses them, and are gone when it finishes — a stored token for
 * somebody's staging user is exactly what this product tells other people not to keep.
 */
export type SecurityRunStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "error";

export type SecurityRunOptions = {
  rateLimitIterations: number;
  requestTimeoutMs: number;
  crossUserPermutations: boolean;
  /** Empty means every active endpoint of the project. */
  endpointIds: string[];
  adminRole: string | null;
};

export type SecurityRunProgress = {
  phase: string;
  percentage: number;
  detail: string;
  endpointsTested: number;
  endpointsTotal: number;
};

export type SecurityRunVisibility = "private" | "public";

export type SecurityRun = {
  id: string;
  projectId: string;
  environmentId: string;
  label: string;
  status: SecurityRunStatus;
  rules: Record<RuleKey, boolean>;
  options: SecurityRunOptions;
  progress: SecurityRunProgress;
  score: number | null;
  risk: RiskLevel | null;
  summary: SecuritySummary | null;
  findings: Finding[];
  probes: ProbeResult[];
  /** Executive summary, top 5 and grouped fixes, when AI ran (phase 6d). Null otherwise. */
  ai: SecurityRunAi | null;
  visibility: SecurityRunVisibility;
  shareToken: string | null;
  triggeredByKind: "user" | "api-token";
  triggeredBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
};

export type SecurityRunAi = {
  executiveSummary: string;
  scoreJustification: string;
  top: { title: string; description: string; severity: Severity }[];
  groups: { ruleKey: RuleKey; solution: string; commonFix: string; codeExample: string | null }[];
};

/** The status a finished run gets from what it found: any critical or high is a fail. */
export function statusFromFindings(findings: Finding[]): "passed" | "failed" {
  return findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
    ? "failed"
    : "passed";
}

export const SECURITY_RUN_LIST_FIELDS = [
  "id",
  "label",
  "status",
  "score",
  "risk",
  "summary",
  "visibility",
  "startedAt",
  "finishedAt",
] as const;
