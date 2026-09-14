/**
 * Two runs, side by side.
 *
 * A run is a fact about a minute; two runs of the same plan a week apart are the only way to answer
 * «did the change help or hurt». This aligns their headline metrics, their per-endpoint numbers and
 * their thresholds so the difference reads at a glance — target minus base, and which side won.
 *
 * Pure: it takes two finished runs and returns the shape a screen draws. No repository, no dates
 * beyond the ones it copies through, so it tests without a database.
 */
import type {
  PerformanceComparisonViewOf,
  PerformanceEndpointDeltaView,
  PerformanceMetricDeltaView,
  PerformanceThresholdDeltaView,
} from "@eq/contracts";

import type { PerformanceRun } from "./model";

type MetricKey = PerformanceMetricDeltaView["metric"];

/** Each headline metric and whether more of it is better (throughput) or worse (latency, errors). */
const METRICS: { key: MetricKey; label: string; higherIsBetter: boolean }[] = [
  { key: "rps", label: "Peticiones/s", higherIsBetter: true },
  { key: "errorRate", label: "Tasa de error", higherIsBetter: false },
  { key: "avgMs", label: "Media (ms)", higherIsBetter: false },
  { key: "p50Ms", label: "p50 (ms)", higherIsBetter: false },
  { key: "p90Ms", label: "p90 (ms)", higherIsBetter: false },
  { key: "p95Ms", label: "p95 (ms)", higherIsBetter: false },
  { key: "p99Ms", label: "p99 (ms)", higherIsBetter: false },
  { key: "maxMs", label: "Máximo (ms)", higherIsBetter: false },
];

const runHead = (run: PerformanceRun) => ({
  id: run.id,
  planName: run.planName,
  status: run.status,
  startedAt: run.startedAt,
  summary: run.summary,
});

const metricDelta = (
  metric: { key: MetricKey; label: string; higherIsBetter: boolean },
  baseValue: number,
  targetValue: number,
): PerformanceMetricDeltaView => {
  const delta = targetValue - baseValue;
  const pct = baseValue === 0 ? null : delta / baseValue;
  let better: "target" | "base" | "same" = "same";
  if (delta !== 0) {
    const targetWins = metric.higherIsBetter ? delta > 0 : delta < 0;
    better = targetWins ? "target" : "base";
  }
  return { metric: metric.key, label: metric.label, base: baseValue, target: targetValue, delta, pct, better };
};

const key = (endpoint: { method: string; path: string }) => `${endpoint.method} ${endpoint.path}`;

export function compareRuns(base: PerformanceRun, target: PerformanceRun): PerformanceComparisonViewOf<Date> {
  const metrics: PerformanceMetricDeltaView[] =
    base.summary && target.summary
      ? METRICS.map((metric) => metricDelta(metric, base.summary![metric.key], target.summary![metric.key]))
      : [];

  const endpointKeys = [...new Set([...base.endpoints, ...target.endpoints].map(key))];
  const endpoints: PerformanceEndpointDeltaView[] = endpointKeys.map((endpointKey) => {
    const b = base.endpoints.find((endpoint) => key(endpoint) === endpointKey) ?? null;
    const t = target.endpoints.find((endpoint) => key(endpoint) === endpointKey) ?? null;
    const head = (b ?? t)!;
    return {
      method: head.method,
      path: head.path,
      base: b,
      target: t,
      p95Delta: b && t ? t.p95Ms - b.p95Ms : null,
      errorRateDelta: b && t ? t.errorRate - b.errorRate : null,
    };
  });

  const thresholdLabels = [...new Set([...base.thresholds, ...target.thresholds].map((threshold) => threshold.label))];
  const thresholds: PerformanceThresholdDeltaView[] = thresholdLabels.map((label) => {
    const b = base.thresholds.find((threshold) => threshold.label === label);
    const t = target.thresholds.find((threshold) => threshold.label === label);
    return {
      label,
      base: b ? { ok: b.ok, actual: b.actual } : null,
      target: t ? { ok: t.ok, actual: t.actual } : null,
    };
  });

  return { base: runHead(base), target: runHead(target), metrics, endpoints, thresholds };
}
