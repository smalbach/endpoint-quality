/**
 * The small vocabulary the screens are built from.
 *
 * Deliberately thin: a badge, a card, a button, an empty state. The coupled dashboard's visual
 * language is worth keeping — it reads well and an operator already knows it — and reproducing
 * it needs less than a component library.
 */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  info,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /** What the field means and how it is used, behind an «i» next to the label. */
  info?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center text-xs font-medium text-slate-600">
        {label}
        {info && <InfoTip label={`Qué es «${label}»`}>{info}</InfoTip>}
      </span>
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

/**
 * A small «i» that opens an explanation.
 *
 * Opened by click, not hover, so it works on touch and stays open while it is read. The bubble is
 * portalled and fixed: the inspector it lives in scrolls and clips, and a bubble cut in half by the
 * panel edge is worse than none. It closes on Escape, on a click elsewhere, and on scroll — a fixed
 * bubble left behind by a scroll points at the wrong field.
 */
export function InfoTip({ children, label = "Más información" }: { children: ReactNode; label?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useEffect(() => {
    if (!at) return;
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "mousedown" && button.current?.contains(event.target as Node)) return;
      if (event.type === "mousedown" && (event.target as Element).closest?.("[data-info-bubble]")) return;
      setAt(null);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  const toggle = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    // Inside a <label>, a click would also focus the input or flip the checkbox.
    event.preventDefault();
    event.stopPropagation();
    if (at || !button.current) return setAt(null);
    const rect = button.current.getBoundingClientRect();
    const width = 288;
    const left = Math.min(Math.max(8, rect.left - 12), window.innerWidth - width - 8);
    const above = rect.bottom + 220 > window.innerHeight && rect.top > 240;
    setAt({ left, top: above ? rect.top - 6 : rect.bottom + 6, above });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={Boolean(at)}
        onClick={toggle}
        className={cn(
          "ml-1 inline-grid size-3.5 shrink-0 place-items-center rounded-full border text-[9px] leading-none font-semibold normal-case",
          at
            ? "border-sky-500 bg-sky-500 text-white"
            : "border-slate-300 text-slate-400 hover:border-slate-500 hover:text-slate-700",
        )}
      >
        i
      </button>
      {at &&
        createPortal(
          <div
            data-info-bubble
            role="tooltip"
            style={{ left: at.left, top: at.top, width: 288, transform: at.above ? "translateY(-100%)" : undefined }}
            className="fixed z-[60] rounded-lg border border-slate-200 bg-white p-3 text-[11px] leading-5 font-normal tracking-normal whitespace-pre-line text-slate-600 normal-case shadow-lg"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
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
