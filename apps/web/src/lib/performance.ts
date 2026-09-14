/**
 * The labels and shapes the performance screens share, kept out of the components.
 *
 * Same reason as the security lib: a status colour or a default plan that two screens disagree on is
 * a bug you only see in one of them. One source here.
 */
import type {
  LoadProfileView,
  PerformancePlanDefinitionView,
  PerformanceRunStatusView,
  PerformanceScenarioView,
} from "@/lib/types";

export const RUN_STATUS_LABEL: Record<PerformanceRunStatusView, string> = {
  queued: "En cola",
  running: "En curso",
  passed: "Superada",
  failed: "No superada",
  cancelled: "Cancelada",
  error: "Error",
};

export const RUN_STATUS_CLASS: Record<PerformanceRunStatusView, string> = {
  queued: "bg-slate-100 text-slate-600 ring-slate-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  passed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  cancelled: "bg-amber-50 text-amber-700 ring-amber-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
};

export const isTerminal = (status: PerformanceRunStatusView): boolean =>
  status === "passed" || status === "failed" || status === "cancelled" || status === "error";

export const PROFILE_LABEL: Record<LoadProfileView["type"], string> = {
  constant: "Constante",
  ramp: "Rampa",
  spike: "Pico",
};

/** «50 usuarios · 60 s», «0→100 · 120 s», «5↑50 · 90 s» — the plan's load in a phrase. */
export function describeProfile(profile: LoadProfileView): string {
  switch (profile.type) {
    case "constant":
      return `${profile.vus} usuarios · ${profile.durationS} s`;
    case "ramp":
      return `${profile.startVus}→${profile.endVus} · ${profile.durationS} s`;
    case "spike":
      return `${profile.baseVus}↑${profile.peakVus} · ${profile.durationS} s`;
  }
}

/** The virtual users a profile asks for at its peak — for the y-axis of the load line. */
export function peakVus(profile: LoadProfileView): number {
  switch (profile.type) {
    case "constant":
      return profile.vus;
    case "ramp":
      return Math.max(profile.startVus, profile.endVus);
    case "spike":
      return Math.max(profile.baseVus, profile.peakVus);
  }
}

export const emptyScenario = (id: string): PerformanceScenarioView => ({
  id,
  name: "Escenario",
  weight: 1,
  thinkMs: 0,
  requests: [{ method: "GET", path: "/" }],
});

export const emptyPlanDefinition = (): PerformancePlanDefinitionView => ({
  scenarios: [emptyScenario("s1")],
  profile: { type: "constant", vus: 10, durationS: 30 },
  thresholds: { p95Ms: 500, maxErrorRate: 0.01 },
});

export const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const formatPct = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;
