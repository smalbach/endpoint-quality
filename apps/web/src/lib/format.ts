import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The colour of an HTTP method.
 *
 * A palette and not a meaning: the operator's eye finds the DELETEs in a list of forty-six rows
 * far faster than it reads them. An unknown method falls back to neutral rather than to a colour
 * that would imply something.
 */
export const methodClass: Record<string, string> = {
  GET: "bg-sky-50 text-sky-700 border-sky-200",
  POST: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PUT: "bg-amber-50 text-amber-700 border-amber-200",
  PATCH: "bg-violet-50 text-violet-700 border-violet-200",
  DELETE: "bg-rose-50 text-rose-700 border-rose-200",
};
export const methodStyle = (method: string) => methodClass[method] ?? "bg-slate-50 text-slate-700 border-slate-200";

export const statusClass: Record<string, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-700",
  passed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  // Amber and not red: a case the environment refused is not a finding about the API, and
  // colouring it like one teaches people to ignore red.
  skipped: "bg-amber-100 text-amber-700",
  cancelled: "bg-slate-200 text-slate-700",
  error: "bg-rose-200 text-rose-800",
};

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
