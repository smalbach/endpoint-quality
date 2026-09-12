import { useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { PromptDialog } from "@/components/overlay";
import { cn } from "@/lib/format";
import type { SuiteView, WorkflowView } from "@/lib/types";

/**
 * The flows somebody runs in order before a release, as one thing.
 *
 * Without it, «¿estaba todo verde?» is nine answers somebody has to remember to collect, and the
 * one they forget is the one that mattered. A suite leaves a single row in the history with a
 * single verdict.
 *
 * The order is the content — the login flow has to run before the eight that spend the session —
 * so the list is reorderable and the checkbox list is not: a set of ticks has no order to it, and
 * the arrows next to each name say what the reading order is going to be.
 */
export function SuitesPanel({
  suites,
  workflows,
  canEdit,
  running,
  onCreate,
  onChange,
  onDelete,
  onRun,
}: {
  suites: SuiteView[];
  workflows: WorkflowView[];
  canEdit: boolean;
  running: boolean;
  onCreate: (name: string) => void;
  onChange: (suite: SuiteView) => void;
  onDelete: (suiteId: string) => void;
  onRun: (suiteId: string) => void;
}) {
  const [openId, setOpenId] = useState("");
  const [naming, setNaming] = useState(false);
  const nameOf = (id: string) => workflows.find((item) => item.id === id)?.name ?? "flujo eliminado";

  const move = (suite: SuiteView, index: number, by: number) => {
    const next = [...suite.workflowIds];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...suite, workflowIds: next });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Suites</p>
        {canEdit && (
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setNaming(true)}>
            + Nueva
          </Button>
        )}
        {naming && (
          <PromptDialog
            title="Nueva suite"
            label="Nombre de la suite"
            hint="Una suite ejecuta varios flujos en orden y deja un solo veredicto."
            placeholder="Antes de publicar"
            onClose={() => setNaming(false)}
            onSubmit={(name) => {
              setNaming(false);
              onCreate(name);
            }}
          />
        )}
      </div>

      {suites.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-400">
          Ninguna. Una suite ejecuta varios flujos en orden y deja un solo veredicto.
        </p>
      ) : (
        <div className="mt-2 space-y-1">
          {suites.map((suite) => (
            <div key={suite.id} className="rounded-lg border border-slate-200">
              <button
                className="flex w-full items-center justify-between px-2 py-2 text-left text-xs"
                onClick={() => setOpenId(openId === suite.id ? "" : suite.id)}
              >
                <span className="font-medium text-slate-700">{suite.name}</span>
                <span className="text-[10px] text-slate-400">{suite.workflowIds.length} flujos</span>
              </button>
              {openId === suite.id && (
                <div className="border-t border-slate-100 p-2">
                  <ol className="space-y-1">
                    {suite.workflowIds.map((id, index) => (
                      <li key={`${id}-${index}`} className="flex items-center gap-1 text-[11px] text-slate-600">
                        <span className="w-4 text-right text-slate-400">{index + 1}.</span>
                        <span
                          className={cn(
                            "flex-1 truncate",
                            !workflows.some((item) => item.id === id) && "text-rose-600",
                          )}
                        >
                          {nameOf(id)}
                        </span>
                        {canEdit && (
                          <>
                            <button
                              className="px-1 text-slate-400 hover:text-slate-700"
                              onClick={() => move(suite, index, -1)}
                            >
                              ↑
                            </button>
                            <button
                              className="px-1 text-slate-400 hover:text-slate-700"
                              onClick={() => move(suite, index, 1)}
                            >
                              ↓
                            </button>
                            <button
                              className="px-1 text-slate-400 hover:text-rose-600"
                              onClick={() =>
                                onChange({
                                  ...suite,
                                  workflowIds: suite.workflowIds.filter((_item, position) => position !== index),
                                })
                              }
                            >
                              ×
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ol>

                  {canEdit && (
                    <select
                      className={`${inputClass} mt-2 h-8 text-xs`}
                      value=""
                      onChange={(event) => {
                        if (!event.target.value) return;
                        onChange({ ...suite, workflowIds: [...suite.workflowIds, event.target.value] });
                      }}
                    >
                      <option value="">Añadir flujo…</option>
                      {workflows
                        // A flow already in the list is not offered again: the two runs would be
                        // indistinguishable in the report, which makes it a bad way to say it.
                        .filter((item) => !suite.workflowIds.includes(item.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  )}

                  <div className="mt-2 flex gap-1">
                    <Button
                      className="h-8 flex-1 text-xs"
                      disabled={running || suite.workflowIds.length === 0}
                      onClick={() => onRun(suite.id)}
                    >
                      Ejecutar
                    </Button>
                    {canEdit && (
                      <Button variant="danger" className="h-8 px-2 text-xs" onClick={() => onDelete(suite.id)}>
                        Eliminar
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
