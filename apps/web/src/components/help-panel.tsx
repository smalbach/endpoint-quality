/**
 * «Ayuda y documentación»: a panel that slides in from the right, one tab per topic.
 *
 * A panel and not a page, because the question comes up in the middle of doing something and the
 * answer is only useful next to it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HELP_TOPICS } from "@/lib/help-content";
import { cn } from "@/lib/format";

type HelpApi = { openHelp: (topic?: string) => void; closeHelp: () => void };
const HelpContext = createContext<HelpApi | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [topic, setTopic] = useState<string | null>(null);
  const closeHelp = useCallback(() => setTopic(null), []);
  const value = useMemo<HelpApi>(
    () => ({ openHelp: (next) => setTopic(next ?? HELP_TOPICS[0].id), closeHelp }),
    [closeHelp],
  );

  return (
    <HelpContext value={value}>
      {children}
      {topic && <HelpPanel topic={topic} onTopic={setTopic} onClose={closeHelp} />}
    </HelpContext>
  );
}

export function useHelp(): HelpApi {
  const context = useContext(HelpContext);
  if (!context) throw new Error("useHelp fuera de HelpProvider");
  return context;
}

function HelpPanel({ topic, onTopic, onClose }: { topic: string; onTopic: (id: string) => void; onClose: () => void }) {
  const current = HELP_TOPICS.find((entry) => entry.id === topic) ?? HELP_TOPICS[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} />
      <aside
        role="dialog"
        aria-label="Ayuda y documentación"
        className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-xl"
      >
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Ayuda y documentación</p>
            <h2 className="mt-1 text-sm font-semibold text-slate-900">{current.title}</h2>
          </div>
          <button
            aria-label="Cerrar ayuda"
            className="grid size-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <nav className="flex gap-1 overflow-x-auto border-b border-slate-100 px-4 py-2">
          {HELP_TOPICS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => onTopic(entry.id)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
                entry.id === current.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {entry.title}
            </button>
          ))}
        </nav>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-xs leading-5 text-slate-600">{current.intro}</p>
          <ol className="space-y-4">
            {current.steps.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-slate-900 text-[10px] font-semibold text-white">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-900">{step.title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">{step.body}</p>
                  {step.tip && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                      <span className="font-semibold">Consejo: </span>
                      {step.tip}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
