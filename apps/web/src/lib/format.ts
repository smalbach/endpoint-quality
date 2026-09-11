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

/**
 * The colour of an HTTP status code, by class.
 *
 * By class and not by «pasó o no pasó», which is a different question this must not answer: a
 * case that expected a 404 and got one is green in the verdict above and the 404 here stays
 * amber. Conflating the two would make every negative case look like a failure.
 */
export function httpStatusStyle(status: number): string {
  if (status < 300) return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status < 400) return "bg-sky-50 text-sky-700 border-sky-200";
  if (status < 500) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

/**
 * How much came back.
 *
 * Worth showing next to the duration because the two together say something neither says alone:
 * «200 en 40 ms» is fine and «200 en 40 ms con 3 MB» is an endpoint that will be slow for
 * somebody on a worse connection. Decimal units, which is what every browser's network panel
 * shows — a reader comparing the two numbers should not have to notice they disagree by 2,4 %.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}
