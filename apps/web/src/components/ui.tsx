/**
 * The small vocabulary the screens are built from.
 *
 * Deliberately thin: a badge, a card, a button, an empty state. The coupled dashboard's visual
 * language is worth keeping — it reads well and an operator already knows it — and reproducing
 * it needs less than a component library.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/format";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-slate-200 bg-white shadow-sm", className)} {...props} />;
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium", className)}>
      {children}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" };

export function Button({ className, variant = "primary", ...props }: ButtonProps) {
  const styles = {
    primary: "bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300",
    ghost: "border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40",
    danger: "bg-rose-600 text-white hover:bg-rose-500 disabled:bg-rose-300",
  }[variant];
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed",
        styles,
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {/* The error wins over the hint: when both are present the hint is what the person already
          read and did not help. */}
      {error ? (
        <span className="mt-1 block text-xs text-rose-600">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-slate-400">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-900 disabled:bg-slate-50";

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint && <p className="mt-1 max-w-md text-xs text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Json({ value, empty = "Sin contenido" }: { value: unknown; empty?: string }) {
  if (value === undefined || value === null || value === "") {
    return (
      <div className="grid min-h-32 place-items-center rounded-xl border border-dashed border-slate-700 bg-slate-950 text-sm text-slate-500">
        {empty}
      </div>
    );
  }
  return (
    <pre className="max-h-96 min-h-32 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-300">
      <code>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}

/** An assertion, shown as what it claims and whether it held. The detail is always visible:
 * "Schema OpenAPI ✗" without the reason is a red tick nobody can act on. */
/**
 * One assertion, and three outcomes rather than two.
 *
 * A warning is a claim that did not hold and did not make the case red — a field the API returned
 * that its own document does not declare, a step that only passed on the third try. Drawing it in
 * the same red as a failure would say the case failed, and drawing it green would hide it; amber,
 * with its own mark, is the only reading of the row that matches the verdict above it.
 */
export function AssertionRow({
  label,
  pass,
  detail,
  severity,
}: {
  label: string;
  pass: boolean;
  detail: string;
  severity?: "error" | "warning";
}) {
  const warned = !pass && severity === "warning";
  return (
    <div className="flex items-start gap-2 border-b border-slate-100 py-2 last:border-b-0">
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white",
          pass ? "bg-emerald-500" : warned ? "bg-amber-500" : "bg-rose-500",
        )}
      >
        {pass ? "✓" : warned ? "!" : "✗"}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-800">{label}</p>
        <p className="mt-0.5 break-words text-[11px] leading-5 text-slate-500">{detail}</p>
      </div>
    </div>
  );
}
