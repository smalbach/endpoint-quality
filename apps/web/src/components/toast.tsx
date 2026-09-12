/**
 * Short confirmations in a corner: «Proyecto creado», «No se pudo archivar».
 *
 * An action that changes something elsewhere on the screen — a card moving to the archived list,
 * an environment becoming the active one — needs to say it happened, and an inline banner has no
 * obvious place to live when the thing it describes just disappeared.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/format";

type Tone = "success" | "error" | "info";
type Toast = { id: number; tone: Tone; message: string };
type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<Tone, string> = {
  success: "bg-emerald-500",
  error: "bg-rose-500",
  info: "bg-slate-400",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const push = useCallback(
    (tone: Tone, message: string) => {
      const id = ++next.current;
      // Four at most: a burst of failures should not bury the screen it is reporting on.
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
      // Errors stay longer, because they are the ones somebody needs to read to the end.
      window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
      info: (message) => push("info", message),
    }),
    [push],
  );

  return (
    <ToastContext value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
              className="pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white py-2.5 pr-2 shadow-lg"
            >
              <span className={cn("w-1 self-stretch rounded-r", TONE[toast.tone])} />
              <p className="flex-1 text-xs leading-5 text-slate-700">{toast.message}</p>
              <button
                aria-label="Cerrar aviso"
                className="grid size-5 place-items-center rounded text-slate-400 hover:text-slate-700"
                onClick={() => dismiss(toast.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast fuera de ToastProvider");
  return context;
}
