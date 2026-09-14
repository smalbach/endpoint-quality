import type { Finding, ProbeResult, RuleContext, RuleKey, SecurityRule } from "./types.ts";
import { bolaRule, bflaRule, crossUserRule, methodTamperingRule } from "./rules/authz.ts";
import { authJwtRule, jwtAttackRule } from "./rules/auth.ts";
import { injectionRule, massAssignmentRule, dataExposureRule } from "./rules/injection.ts";
import {
  contentTypeRule,
  corsRule,
  endpointConsistencyRule,
  errorDisclosureRule,
  rateLimitRule,
  responseSizeRule,
  securityHeadersRule,
  verboseErrorRule,
} from "./rules/infra.ts";

/** Every rule, in report order. Keyed by the same key a run stores and a preset selects. */
export const RULES: SecurityRule[] = [
  bolaRule,
  bflaRule,
  authJwtRule,
  jwtAttackRule,
  crossUserRule,
  injectionRule,
  massAssignmentRule,
  dataExposureRule,
  errorDisclosureRule,
  verboseErrorRule,
  rateLimitRule,
  securityHeadersRule,
  corsRule,
  methodTamperingRule,
  contentTypeRule,
  endpointConsistencyRule,
  responseSizeRule,
];

export const RULE_BY_KEY: Record<RuleKey, SecurityRule> = Object.fromEntries(
  RULES.map((rule) => [rule.key, rule]),
) as Record<RuleKey, SecurityRule>;

/**
 * Every finding from the enabled rules.
 *
 * A rule that throws is not allowed to sink the run: its failure is turned into one `info` finding
 * naming the rule, exactly as a case that errors is still a row. The report is evidence, and a
 * missing rule with no explanation is worse than a rule that says it broke.
 */
export function evaluateRules(
  results: ProbeResult[],
  context: RuleContext,
  enabled: Record<RuleKey, boolean>,
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (!enabled[rule.key]) continue;
    try {
      findings.push(...rule.evaluate(results, context));
    } catch (error) {
      findings.push({
        ruleKey: rule.key,
        ruleId: rule.id,
        ruleName: rule.name,
        category: rule.category,
        severity: "info",
        endpointId: null,
        title: `La regla «${rule.name}» no se pudo evaluar`,
        detail: error instanceof Error ? error.message : String(error),
        remediation: "Es un fallo de la herramienta, no del destino. Reporta la corrida.",
        references: rule.references,
        reproduce: [],
        evidence: {},
      });
    }
  }
  return findings;
}
