import { useEffect, useState } from "react";

import {
  BACKENDS,
  fetchDescriptor,
  missingModules,
  selectBackend,
  selectedBackendId,
  type BackendDescriptor,
  type BackendId,
} from "@/lib/backends";
import { cn } from "@/lib/format";

/**
 * Con cuál de las tres implementaciones de la API habla esta pestaña.
 *
 * Se elige **antes de entrar** —por eso vive también en la pantalla de acceso— y a partir de ahí
 * todo el flujo va por ahí. Los tres backends comparten base de datos y secretos, así que cambiar
 * no cierra la sesión: es el mismo producto contestado por otro proceso, que es justo lo que este
 * montaje existe para enseñar (ver `docs/backends-poliglotas.md`).
 *
 * Cada opción se sondea contra `/backend` en vez de fiarse de una lista escrita aquí. Un selector
 * que ofrece tres y falla al llegar a dos es peor que uno que dice cuáles están levantados y qué
 * cubre cada uno.
 */
type Probe = { state: "probing" } | { state: "down" } | { state: "up"; descriptor: BackendDescriptor };

const PROBING: Probe = { state: "probing" };

export function BackendSwitcher({
  variant = "compact",
  /** Qué hacer después de cambiar. Por defecto recargar: las respuestas cacheadas son de quien
   * las contestó, y enseñarlas bajo el nombre de otro backend es mentir con datos reales. */
  onSwitched = () => window.location.reload(),
}: {
  variant?: "compact" | "full";
  onSwitched?: () => void;
}) {
  const [selected] = useState<BackendId>(selectedBackendId());
  const [probes, setProbes] = useState<Record<string, Probe>>(() =>
    Object.fromEntries(BACKENDS.map((backend) => [backend.id, PROBING])),
  );

  useEffect(() => {
    const controller = new AbortController();
    for (const backend of BACKENDS) {
      void fetchDescriptor(backend, controller.signal).then((descriptor) => {
        if (controller.signal.aborted) return;
        setProbes((previous) => ({
          ...previous,
          [backend.id]: descriptor ? { state: "up", descriptor } : { state: "down" },
        }));
      });
    }
    return () => controller.abort();
  }, []);

  function choose(id: BackendId) {
    if (id === selected) return;
    selectBackend(id);
    onSwitched();
  }

  if (variant === "compact") {
    const probe = probes[selected];
    return (
      <label className="flex items-center gap-1.5" title="Con qué implementación de la API habla esta pestaña">
        <span
          aria-label={
            probe.state === "up" ? "backend disponible" : probe.state === "down" ? "backend caído" : "sondeando"
          }
          className={cn(
            "size-1.5 rounded-full",
            probe.state === "up" ? "bg-emerald-500" : probe.state === "down" ? "bg-red-500" : "bg-slate-300",
          )}
        />
        <select
          aria-label="Backend"
          className="h-7 rounded border border-slate-200 bg-white px-1 text-xs text-slate-600"
          value={selected}
          onChange={(event) => choose(event.target.value as BackendId)}
        >
          {BACKENDS.map((backend) => (
            <option key={backend.id} value={backend.id}>
              {backend.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500">Conectar con</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {BACKENDS.map((backend) => {
          const probe = probes[backend.id];
          const missing = probe.state === "up" ? missingModules(probe.descriptor) : [];
          return (
            <button
              key={backend.id}
              type="button"
              onClick={() => choose(backend.id)}
              aria-pressed={backend.id === selected}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors",
                backend.id === selected
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{backend.label}</span>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    probe.state === "up" ? "bg-emerald-500" : probe.state === "down" ? "bg-red-500" : "bg-slate-300",
                  )}
                />
              </span>
              <span className="block text-[11px] opacity-70">
                {probe.state === "up"
                  ? probe.descriptor.runtime
                  : probe.state === "down"
                    ? "no contesta"
                    : backend.language}
              </span>
              {missing.length > 0 && (
                <span className="mt-1 block text-[11px] opacity-70">
                  {/* Dicho antes de entrar, no descubierto al llegar a la pantalla que falta. */}
                  sin {missing.length} módulo{missing.length === 1 ? "" : "s"}: {missing.slice(0, 3).join(", ")}
                  {missing.length > 3 ? "…" : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
