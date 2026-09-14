import type { Finding } from "@eq/security-rules";
import type { SecurityRun, SecurityRunAi } from "./model";

export const SECURITY_AI = Symbol("SECURITY_AI");

/**
 * The optional narrator over a finished run.
 *
 * A port with two adapters: a deterministic one that always works, and a real one that calls a
 * model when a key is present. The score and the findings are **not** its to decide — those are
 * computed and are evidence — so this only writes prose: an executive summary, the top few, and a
 * suggested fix per rule. A report whose numbers moved because a model felt differently on a
 * Tuesday is not a report, which is why the analyzer letting the AI set the score is not copied.
 */
export interface SecurityAiPort {
  analyze(run: SecurityRun): Promise<SecurityRunAi>;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

/** The fallback: real numbers turned into sentences, no model. Also the shape the real one fills. */
export function deterministicAnalysis(run: SecurityRun): SecurityRunAi {
  const summary = run.summary;
  const counts = summary?.bySeverity ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const worst = [...run.findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} crítico(s)`);
  if (counts.high) parts.push(`${counts.high} alto(s)`);
  if (counts.medium) parts.push(`${counts.medium} medio(s)`);
  const executiveSummary =
    run.findings.length === 0
      ? "La corrida no encontró hallazgos: los endpoints probados resistieron la matriz."
      : `La corrida encontró ${run.findings.length} hallazgo(s): ${parts.join(", ") || "de severidad baja"}. Empieza por los críticos.`;

  return {
    executiveSummary,
    scoreJustification: `Puntuación ${run.score ?? 100}/100: cada hallazgo resta según su severidad. Riesgo ${run.risk ?? "low"}.`,
    top: worst
      .slice(0, 5)
      .map((finding) => ({ title: finding.title, description: finding.detail, severity: finding.severity })),
    groups: groupsFrom(run.findings),
  };
}

/** One entry per rule that fired, with its own remediation as the common fix. */
export function groupsFrom(findings: Finding[]): SecurityRunAi["groups"] {
  const byRule = new Map<string, Finding>();
  for (const finding of findings) if (!byRule.has(finding.ruleKey)) byRule.set(finding.ruleKey, finding);
  return [...byRule.values()].map((finding) => ({
    ruleKey: finding.ruleKey,
    solution: finding.remediation,
    commonFix: finding.remediation,
    codeExample: null,
  }));
}
