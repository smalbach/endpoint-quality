/**
 * What sits on top of a screen: a modal, the two dialogs every screen needs, and a help chip.
 *
 * They replace `window.prompt` and `window.confirm`, which could not say what a name is for, could
 * not show why a deletion matters, and look like the browser asking rather than the product. Same
 * vocabulary as `ui.tsx` — white card, slate border, `rounded-2xl` — so a dialog reads as part of
 * the screen underneath it.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/format";
import { Button, Field, inputClass } from "@/components/ui";

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" } as const;

/**
 * A panel that slides in from a side, over whatever is behind it.
 *
 * The canvas is the screen now, so the flow list, the library and the inspector no longer take a
 * column beside it — they are drawers pulled over it when needed and pushed away when not. Same
 * skin as {@link Modal}, but anchored to an edge and full height, because their content is a long
 * list, not a short question. The scrim is lighter than a modal's: a drawer sits *next to* the work
 * rather than blocking it, and clicking the canvas behind it is a normal way to dismiss it.
 */
export function Drawer({
  title,
  side = "right",
  width = "24rem",
  modal = true,
  flush = false,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  side?: "left" | "right";
  width?: string;
  /** The content lays itself out: no padding and no scroll of its own, so it can pin a header or a
   * tab strip and scroll only what is under it. */
  flush?: boolean;
  /** A modal drawer dims the page and catches the click outside to close. A non-modal one leaves
   * the rest of the page live — used for the node panel, so the canvas and its toolbar stay usable
   * while a node is open. */
  modal?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    // Non-modal: the wrapper lets clicks through (pointer-events-none) so only the panel is live,
    // and the rest of the page — canvas, toolbar — keeps working while the panel is open.
    <div className={cn("fixed inset-0 z-40", !modal && "pointer-events-none")}>
      {modal && <div className="absolute inset-0 bg-slate-900/10" onMouseDown={onClose} />}
      <div
        role="dialog"
        aria-modal={modal}
        aria-labelledby={titleId}
        style={{ width }}
        className={cn(
          "pointer-events-auto absolute inset-y-0 flex max-w-[92vw] flex-col bg-white shadow-2xl",
          side === "left" ? "left-0 border-r border-slate-200" : "right-0 border-l border-slate-200",
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-slate-900">
            {title}
          </h2>
          <button
            aria-label="Cerrar"
            className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className={flush ? "flex min-h-0 flex-1 flex-col" : "flex-1 overflow-y-auto px-4 py-3"}>{children}</div>
        {footer && <div className="border-t border-slate-100 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
}) {
  const titleId = useId();

  // Escape closes, the same as clicking outside. Bound on the document and not the panel, because
  // focus is often still on the button that opened it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-900/30 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn("w-full rounded-2xl border border-slate-200 bg-white shadow-xl", SIZES[size])}
        // The panel swallows the mousedown so a drag that starts inside and ends on the backdrop
        // does not close a half-filled form.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-slate-900">
              {title}
            </h2>
            {description && <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>}
          </div>
          <button
            aria-label="Cerrar"
            className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children && <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>}
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A name, asked for properly: a label, a hint about what it is for, Enter to accept. */
export function PromptDialog({
  title,
  label,
  hint,
  placeholder,
  confirmLabel = "Crear",
  initialValue = "",
  pending,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  hint?: string;
  placeholder?: string;
  confirmLabel?: string;
  initialValue?: string;
  pending?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  }

  return (
    <Modal title={title} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <Field label={label} hint={hint}>
          <input
            ref={input}
            className={inputClass}
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!value.trim() || pending}>
            {pending ? "…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A confirmation that says what is about to be lost, with the destructive button in red. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Eliminar",
  danger = true,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} autoFocus>
            Cancelar
          </Button>
          <Button variant={danger ? "danger" : "primary"} disabled={pending} onClick={onConfirm}>
            {pending ? "…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-5 text-slate-600">{message}</p>
    </Modal>
  );
}

/**
 * A «?» next to a label that explains it.
 *
 * Focusable, unlike a hover-only chip: the explanation is for somebody who does not know what the
 * control does yet, and that person is as likely to be on a keyboard as on a mouse.
 */
export function HelpTooltip({ content, side = "top" }: { content: string; side?: "top" | "right" }) {
  return (
    <span className="group relative inline-flex" tabIndex={0} aria-label={content}>
      <span className="grid size-4 cursor-help place-items-center rounded-full border border-slate-200 bg-white text-[9px] font-semibold text-slate-400 group-hover:border-slate-400 group-hover:text-slate-700 group-focus:border-slate-400">
        ?
      </span>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-40 hidden w-60 rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-5 font-normal text-slate-100 shadow-lg group-hover:block group-focus:block",
          side === "top" ? "bottom-full left-1/2 mb-2 -translate-x-1/2" : "top-1/2 left-full ml-2 -translate-y-1/2",
        )}
      >
        {content}
      </span>
    </span>
  );
}
