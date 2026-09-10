/**
 * The latency budgets the project committed to, as data.
 *
 * They are **acceptance criteria, not aspirations** — `digital-catalog-back-end/CLAUDE.md` lists them in
 * the same table as the throughput targets, and `docs/03-testing/T-03-load-plan.md` is the
 * contractual deliverable that demonstrates them.
 *
 * Before this file the dashboard's timing assertion read, literally:
 *
 *     { label: "Tiempo de respuesta < 12 s", pass: true, detail: `${durationMs} ms` }
 *
 * `pass: true` hardcoded. It measured the request, printed the number and asserted nothing —
 * the same vice the first version of the E2E suite had, on the one number that can disqualify
 * the delivery.
 *
 * **A budget that does not exist is not a budget that passes.** The RFP publishes no target for
 * the writes, so `budgetFor` returns `null` for them and the caller emits no assertion at all,
 * rather than a green tick that means nothing.
 */

/** @typedef {{ ms: number, label: string, source: string }} Budget */

/**
 * The published budget for one operation, or `null` when the RFP does not set one.
 *
 * @param {string} method
 * @param {string} operationPath the templated path, e.g. `/v1/products/{product_id}`
 * @param {string} [requestPath] the resolved path with its query string, to spot `?ean_sap=`
 * @returns {Budget | null}
 */
export function budgetFor(method, operationPath, requestPath = "") {
  if (operationPath === "/health") return { ms: 20, label: "GET /health < 20 ms", source: "RFP §6" };
  // Both bulk endpoints, not just the ART one: the RFP publishes the budget per *call of 5 000
  // records*, and `/v1/products/bulk` accepts the same 5 000. Matching by path suffix so the
  // next bulk the contract adds is covered instead of silently running unmeasured.
  if (operationPath.endsWith("/bulk")) return { ms: 5_000, label: "Bulk de 5.000 registros < 5 s", source: "RFP §6" };
  if (method.toUpperCase() !== "GET") return null;
  // The EAN path is the one the cache exists for, and it carries its own tighter target. It is
  // only claimed on a warm cache, so a first, cold sample is expected to miss it.
  if (/[?&]ean_sap=/.test(requestPath)) return { ms: 50, label: "?ean_sap= p95 con caché caliente < 50 ms", source: "RFP §6" };
  return { ms: 70, label: "GET p95 < 70 ms", source: "RFP §6" };
}

/**
 * The p-th percentile of a sample, nearest-rank.
 *
 * Nearest-rank and not interpolated on purpose: with the 10-to-30 samples the dashboard takes,
 * interpolating invents a value between two measurements and reads as more precision than the
 * sample carries. `percentile([a], 95)` is `a`.
 *
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * The latency assertion, or `null` when the operation has no published budget.
 *
 * **One sample is not a p95** and the label says so: with a single measurement the claim is
 * about that request, not about a distribution. Only from a real sample does it name the
 * percentile the RFP actually commits to.
 *
 * @param {Budget | null} budget
 * @param {number[]} samples milliseconds, one per request
 * @returns {{ label: string, pass: boolean, detail: string } | null}
 */
export function latencyAssertion(budget, samples) {
  if (!budget || samples.length === 0) return null;
  const p95 = percentile(samples, 95);
  const measured = samples.length === 1 ? samples[0] : p95;
  const how = samples.length === 1
    ? `1 muestra: ${measured} ms (una medición no es un p95)`
    : `${samples.length} muestras · p50 ${percentile(samples, 50)} ms · p95 ${p95} ms`;
  return { label: budget.label, pass: measured < budget.ms, detail: `${how} · objetivo ${budget.ms} ms (${budget.source})` };
}
