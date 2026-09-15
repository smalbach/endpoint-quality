/**
 * «Configurar ejecución»: how the next run of this flow walks it.
 *
 * Every change applies as it is made — there is no «guardar» to forget — and the parent keeps the
 * settings per flow in this browser. Nothing here changes what the flow tests; see `lib/run-settings`.
 */
import { Modal } from "@/components/overlay";
import { Button, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import {
  CONCURRENCY_LIMIT,
  DEFAULT_RUN_SETTINGS,
  DELAY_LIMIT_MS,
  DELAY_PRESETS,
  runSettingsProblem,
  type PauseMode,
  type RunSettings,
} from "@/lib/run-settings";

const MODES: { value: PauseMode; title: string; hint: string }[] = [
  { value: "none", title: "Continuo", hint: "Recorre el flujo de principio a fin sin detenerse." },
  {
    value: "step",
    title: "Paso a paso",
    hint: "Se detiene antes de cada nodo. Avanzas con «Siguiente» o sigues hasta el final con «Continuar».",
  },
  {
    value: "breakpoints",
    title: "Puntos de parada",
    hint: "Corre normal y se detiene solo antes de los nodos que marques.",
  },
];

export function RunSettingsDialog({
  settings,
  nodes,
  onChange,
  onClose,
}: {
  settings: RunSettings;
  /** The flow's nodes, in canvas order, for the breakpoint list. */
  nodes: { id: string; label: string; kind: string }[];
  onChange: (settings: RunSettings) => void;
  onClose: () => void;
}) {
  const set = (change: Partial<RunSettings>) => onChange({ ...settings, ...change });
  const problem = runSettingsProblem(settings);
  const marked = new Set(settings.breakpoints);

  return (
    <Modal
      title="Configurar ejecución"
      description="Cómo recorre el flujo la próxima corrida. No cambia lo que se prueba, solo el ritmo y dónde se detiene."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" className="mr-auto h-8 text-xs" onClick={() => onChange({ ...DEFAULT_RUN_SETTINGS })}>
            Restablecer
          </Button>
          <Button className="h-8 text-xs" onClick={onClose}>
            Listo
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <SectionTitle>Modo</SectionTitle>
          <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Modo de ejecución">
            {MODES.map((mode) => {
              const active = settings.pauseMode === mode.value;
              return (
                <button
                  key={mode.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => set({ pauseMode: mode.value })}
                  className={cn(
                    "rounded-xl border px-3 py-2.5 text-left transition",
                    active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50",
                  )}
                >
                  <span className="block text-xs font-semibold">{mode.title}</span>
                  <span className={cn("mt-1 block text-[11px] leading-4", active ? "text-slate-300" : "text-slate-500")}>
                    {mode.hint}
                  </span>
                </button>
              );
            })}
          </div>

          {settings.pauseMode === "breakpoints" && (
            <div className="mt-3 rounded-xl border border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <span className="text-[11px] text-slate-500">
                  {marked.size} de {nodes.length} marcados
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
                    onClick={() => set({ breakpoints: nodes.map((node) => node.id) })}
                  >
                    Todos
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
                    onClick={() => set({ breakpoints: [] })}
                  >
                    Ninguno
                  </button>
                </span>
              </div>
              <ul className="max-h-56 overflow-y-auto py-1">
                {nodes.length === 0 && <li className="px-3 py-2 text-[11px] text-slate-400">El flujo no tiene nodos.</li>}
                {nodes.map((node) => (
                  <li key={node.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={marked.has(node.id)}
                        onChange={(event) =>
                          set({
                            breakpoints: event.target.checked
                              ? [...settings.breakpoints, node.id]
                              : settings.breakpoints.filter((id) => id !== node.id),
                          })
                        }
                      />
                      <span className="w-16 shrink-0 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
                        {node.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{node.label}</span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-400">{node.id}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {problem && <p className="mt-2 text-xs text-rose-700">{problem}</p>}
        </section>

        <section>
          <SectionTitle>Pausa entre nodos</SectionTitle>
          <p className="mt-1 text-[11px] text-slate-500">
            Espera entre un nodo y el siguiente: para mirar el recorrido o no chocar con el límite de peticiones del
            destino.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {DELAY_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => set({ delayMs: preset.value })}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px]",
                  settings.delayMs === preset.value
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50",
                )}
              >
                {preset.label}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <input
                className={cn(inputClass, "mt-0 h-7 w-24 px-2 py-0 text-xs")}
                type="number"
                min={0}
                max={DELAY_LIMIT_MS}
                step={100}
                value={settings.delayMs}
                aria-label="Pausa en milisegundos"
                onChange={(event) =>
                  set({ delayMs: Math.min(DELAY_LIMIT_MS, Math.max(0, Math.round(Number(event.target.value) || 0))) })
                }
              />
              ms
            </label>
          </div>
        </section>

        <section>
          <SectionTitle>Nodos a la vez</SectionTitle>
          <p className="mt-1 text-[11px] text-slate-500">
            Solo corren juntos los que no dependen unos de otros.
            {settings.pauseMode !== "none" && settings.concurrency > 1 && (
              <span className="text-amber-700"> Con pausas conviene 1: los que ya salieron no esperan.</span>
            )}
          </p>
          <input
            className={cn(inputClass, "w-24")}
            type="number"
            min={1}
            max={CONCURRENCY_LIMIT}
            value={settings.concurrency}
            aria-label="Nodos a la vez"
            onChange={(event) =>
              set({ concurrency: Math.min(CONCURRENCY_LIMIT, Math.max(1, Math.round(Number(event.target.value) || 1))) })
            }
          />
        </section>

        <section>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.stopOnFailure}
              onChange={(event) => set({ stopOnFailure: event.target.checked })}
            />
            <span>
              <span className="block text-xs font-semibold text-slate-800">Detener al primer fallo</span>
              <span className="block text-[11px] text-slate-500">
                El primer nodo que falle termina la corrida y lo que faltaba queda sin ejecutar. Los nodos con «si
                falla: continuar» mantienen su regla.
              </span>
            </span>
          </label>
        </section>
      </div>
    </Modal>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{children}</h3>;
}
