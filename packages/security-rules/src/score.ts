import { isSuccess, SEVERITIES, type Finding, type ProbeResult, type Severity } from "./types.ts";

export type RiskLevel = "critical" | "high" | "medium" | "low";

export type SecuritySummary = {
  score: number;
  risk: RiskLevel;
  findings: number;
  bySeverity: Record<Severity, number>;
  endpointsTested: number;
  /** Endpoints that answered 2xx with no credential while declaring they need one. */
  unprotected: { endpointId: string; method: string; path: string; status: number }[];
};

/** What each severity subtracts from 100. Deterministic on purpose: the same run always scores the
 * same, which an AI summary alone could not promise. */
const WEIGHT: Record<Severity, number> = { critical: 25, high: 12, medium: 5, low: 1, info: 0 };

function riskFrom(bySeverity: Record<Severity, number>): RiskLevel {
  if (bySeverity.critical > 0) return "critical";
  if (bySeverity.high > 0) return "high";
  if (bySeverity.medium > 0) return "medium";
  return "low";
}

/**
 * The run's score, risk and totals.
 *
 * The score starts at 100 and each finding subtracts its weight, floored at 0 — a curve that keeps
 * one critical from being lost among many lows, which a plain pass/fail ratio does. The AI, when it
 * runs, may narrate this number but does not replace it: a report whose score changed because a
 * model felt differently on a Tuesday is not evidence.
 */
export function summarize(
  findings: Finding[],
  results: ProbeResult[],
  endpoints: { id: string; method: string; path: string; requiresAuth: boolean }[],
): SecuritySummary {
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  let penalty = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    penalty += WEIGHT[finding.severity];
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  const unprotected = endpoints
    .filter((endpoint) => endpoint.requiresAuth)
    .map((endpoint) => {
      const noAuth = results.find((result) => result.endpointId === endpoint.id && result.testType === "no-auth");
      return noAuth && isSuccess(noAuth.status)
        ? { endpointId: endpoint.id, method: endpoint.method, path: endpoint.path, status: noAuth.status }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    score,
    risk: riskFrom(bySeverity),
    findings: findings.length,
    bySeverity,
    endpointsTested: new Set(results.map((result) => result.endpointId)).size,
    unprotected,
  };
}
