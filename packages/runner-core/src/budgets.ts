/**
 * The latency targets a project committed to, as ordered data.
 *
 * The coupled version encoded one RFP's table as a chain of `if`s. What survives untouched is
 * the decision behind it: **a budget that does not exist is not a budget that passes**. An
 * operation no rule matches produces no assertion at all, rather than a green tick that means
 * nothing. That green tick — `{ label: "Tiempo de respuesta < 12 s", pass: true }`, hardcoded —
 * is what the budgets file replaced in the first place.
 */
import type { Assertion, Budget, HttpMethod } from "./types.ts";
import type { BudgetRule, ProjectConfig } from "./config.ts";

export function matchesBudgetRule(
  rule: BudgetRule,
  method: HttpMethod,
  operationPath: string,
  requestPath: string,
): boolean {
  if (rule.methods && !rule.methods.includes(method)) return false;
  if (rule.pathEquals !== undefined && operationPath !== rule.pathEquals) return false;
  if (rule.pathSuffix !== undefined && !operationPath.endsWith(rule.pathSuffix)) return false;
  if (rule.pathPrefix !== undefined && !operationPath.startsWith(rule.pathPrefix)) return false;
  if (rule.queryMatches !== undefined && !new RegExp(rule.queryMatches).test(requestPath)) return false;
  return true;
}

/** The published budget for one request, or `null` when the project set none. */
export function budgetFor(
  config: ProjectConfig,
  method: HttpMethod,
  operationPath: string,
  requestPath = "",
): Budget | null {
  const rule = config.budgets.find((candidate) => matchesBudgetRule(candidate, method, operationPath, requestPath));
  return rule ? { ms: rule.thresholdMs, label: rule.label, source: rule.source } : null;
}

/**
 * The p-th percentile of a sample, nearest-rank.
 *
 * Nearest-rank and not interpolated on purpose: over the 10 to 30 samples a run takes,
 * interpolating invents a value between two measurements and reads as more precision than the
 * sample carries. `percentile([a], 95)` is `a`.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * The latency assertion, or `null` when the operation has no published budget.
 *
 * **One sample is not a p95** and the label says so: with a single measurement the claim is
 * about that request, not about a distribution.
 */
export function latencyAssertion(budget: Budget | null, samples: number[]): Assertion | null {
  if (!budget || samples.length === 0) return null;
  const p95 = percentile(samples, 95);
  const measured = samples.length === 1 ? samples[0] : p95;
  const how =
    samples.length === 1
      ? `1 muestra: ${measured} ms (una medición no es un p95)`
      : `${samples.length} muestras · p50 ${percentile(samples, 50)} ms · p95 ${p95} ms`;
  return {
    label: budget.label,
    pass: measured < budget.ms,
    detail: `${how} · objetivo ${budget.ms} ms (${budget.source})`,
  };
}
