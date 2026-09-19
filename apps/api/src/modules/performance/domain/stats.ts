/**
 * Turning a pile of request outcomes into the numbers a load test is read for.
 *
 * Pure and separate because this is the part that is easy to get subtly wrong — an off-by-one in a
 * percentile, an error rate over the wrong denominator — and a wrong number in a performance report
 * is worse than no report: it is a decision made on a lie. So it is arithmetic with samples in and a
 * summary out, tested exhaustively, with the network nowhere near it.
 */
import type {
  PerformanceEndpointStat,
  PerformanceSummary,
  PerformanceThresholdResult,
  PerformanceThresholds,
  PerformanceWindow,
} from "./model";

/** One request that happened: when it started, how long it took, whether it counted as a success,
 * and which endpoint it hit. The executor produces a list of these; everything else is derived. */
export type Sample = { atMs: number; durationMs: number; ok: boolean; method: string; path: string };

/**
 * The value at the p-th percentile of already-collected durations.
 *
 * Nearest-rank on a sorted copy: `p95` of a hundred samples is the 95th slowest, which is the
 * definition somebody comparing two runs expects, and it needs no interpolation to explain. `p` is a
 * percentage in `[0, 100]`; an empty set has no percentile and answers 0.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** The headline numbers over every sample. `durationS` is the wall-clock the run actually took, so
 * `rps` is throughput as observed, not as planned. */
export function summarize(samples: Sample[], durationS: number): PerformanceSummary {
  const durations = samples.map((sample) => sample.durationMs);
  const failures = samples.filter((sample) => !sample.ok).length;
  const requests = samples.length;
  const seconds = Math.max(durationS, 0.001);
  return {
    requests,
    failures,
    errorRate: requests ? failures / requests : 0,
    rps: round(requests / seconds, 2),
    // Folded, not spread: `Math.min(...durations)` passes every sample as an argument, and a run at
    // its 200 000-sample ceiling overflows the call stack there.
    minMs: durations.length ? durations.reduce((min, ms) => Math.min(min, ms), Infinity) : 0,
    maxMs: durations.length ? durations.reduce((max, ms) => Math.max(max, ms), -Infinity) : 0,
    avgMs: round(durations.reduce((sum, ms) => sum + ms, 0) / (durations.length || 1), 1),
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
  };
}

/**
 * The samples cut into fixed 5-second windows, for the live timeline.
 *
 * Fixed and not «one per event» so two runs are comparable and a chart has a steady x-axis. A
 * window with no samples is still emitted with zeroes: a gap in throughput is a thing worth seeing,
 * and a chart that simply skips it draws a lie of a flat line across the outage. `vusAt` supplies
 * the load for each window's start so the timeline can be read against it.
 */
export function toWindows(
  samples: Sample[],
  totalS: number,
  vusAt: (atS: number) => number,
  windowS = 5,
): PerformanceWindow[] {
  const windows: PerformanceWindow[] = [];
  const count = Math.max(1, Math.ceil(totalS / windowS));
  const buckets: Sample[][] = Array.from({ length: count }, () => []);
  for (const sample of samples) {
    const index = Math.min(count - 1, Math.floor(sample.atMs / 1000 / windowS));
    if (index >= 0) buckets[index].push(sample);
  }
  for (let index = 0; index < count; index += 1) {
    const bucket = buckets[index];
    const failures = bucket.filter((sample) => !sample.ok).length;
    const atS = index * windowS;
    windows.push({
      atS,
      requests: bucket.length,
      failures,
      rps: round(bucket.length / windowS, 2),
      errorRate: bucket.length ? failures / bucket.length : 0,
      p95Ms: percentile(
        bucket.map((sample) => sample.durationMs),
        95,
      ),
      vus: vusAt(atS),
    });
  }
  return windows;
}

/** The same numbers split per method+path, worst p95 first — «which endpoint bent». */
export function byEndpoint(samples: Sample[]): PerformanceEndpointStat[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.method} ${sample.path}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(sample);
  }
  const stats = [...groups.entries()].map(([key, bucket]) => {
    const failures = bucket.filter((sample) => !sample.ok).length;
    const durations = bucket.map((sample) => sample.durationMs);
    const [method, ...rest] = key.split(" ");
    return {
      method,
      path: rest.join(" "),
      requests: bucket.length,
      failures,
      // A group exists only because a sample landed in it, so it is never empty.
      errorRate: failures / bucket.length,
      p95Ms: percentile(durations, 95),
      avgMs: round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length, 1),
    };
  });
  return stats.sort((a, b) => b.p95Ms - a.p95Ms);
}

/**
 * Each threshold the plan set, checked against the summary.
 *
 * Only the thresholds that were set are returned — an absent limit is not a passing check, it is not
 * a check at all, and reporting it as green would claim the run proved something nobody asked. The
 * error-rate limit is compared as a fraction and shown as a percentage, because that is how the plan
 * is written and how the report is read.
 */
export function evaluateThresholds(
  summary: PerformanceSummary,
  thresholds: PerformanceThresholds,
): PerformanceThresholdResult[] {
  const results: PerformanceThresholdResult[] = [];
  if (thresholds.p95Ms !== undefined)
    results.push({
      label: "p95",
      ok: summary.p95Ms <= thresholds.p95Ms,
      actual: `${summary.p95Ms} ms`,
      limit: `≤ ${thresholds.p95Ms} ms`,
    });
  if (thresholds.p99Ms !== undefined)
    results.push({
      label: "p99",
      ok: summary.p99Ms <= thresholds.p99Ms,
      actual: `${summary.p99Ms} ms`,
      limit: `≤ ${thresholds.p99Ms} ms`,
    });
  if (thresholds.maxErrorRate !== undefined)
    results.push({
      label: "Tasa de error",
      ok: summary.errorRate <= thresholds.maxErrorRate,
      actual: `${round(summary.errorRate * 100, 2)}%`,
      limit: `≤ ${round(thresholds.maxErrorRate * 100, 2)}%`,
    });
  if (thresholds.minRps !== undefined)
    results.push({
      label: "Rendimiento",
      ok: summary.rps >= thresholds.minRps,
      actual: `${summary.rps} req/s`,
      limit: `≥ ${thresholds.minRps} req/s`,
    });
  return results;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
