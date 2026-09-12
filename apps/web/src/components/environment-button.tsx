/**
 * The environment a project is working against, in the top bar.
 *
 * Which one is active is the first thing somebody needs to know before pressing «Ejecutar» or
 * «Enviar», and the last thing they remember to check. So it is always on screen while inside a
 * project, with its variables one click away and a way to change it without leaving the page.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { cn } from "@/lib/format";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { useToast } from "@/components/toast";
import type { Environment } from "@/lib/types";

const MASK = "••••••••";

export function EnvironmentButton({ projectId }: { projectId: string }) {
  const organization = useOrganization();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useActiveEnvironment(projectId);
  const root = useRef<HTMLDivElement>(null);

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization),
    queryFn: () => api<Environment[]>(`/orgs/${organization!.id}/projects/${projectId}/environments`),
  });
  const list = environments.data ?? [];
  const active = resolveActive(stored, list);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const variables = active ? Object.entries(active.variables) : [];

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex h-7 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <span className={cn("size-2 rounded-full", active ? "bg-emerald-500" : "bg-slate-300")} />
        <span className="max-w-32 truncate">{active?.name ?? "Sin entorno"}</span>
        <span className="text-slate-400">▾</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 z-40 mt-2 w-96 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Entornos</p>
            {environments.isLoading && <p className="mt-2 text-xs text-slate-500">Cargando…</p>}
            {!environments.isLoading && list.length === 0 && (
              <p className="mt-2 text-xs text-slate-500">Sin entornos configurados.</p>
            )}
            <div className="mt-2 space-y-1">
              {list.map((environment) => {
                const isActive = environment.id === active?.id;
                return (
                  <button
                    key={environment.id}
                    onClick={() => {
                      setStored(environment.id);
                      if (!isActive) toast.success(`Entorno «${environment.name}» activo`);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                      isActive ? "bg-slate-50" : "hover:bg-slate-50",
                    )}
                  >
                    <span
                      className={cn("size-2 shrink-0 rounded-full", isActive ? "bg-emerald-500" : "bg-slate-300")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-800">{environment.name}</span>
                      <span className="block truncate font-mono text-[10px] text-slate-400">{environment.baseUrl}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400">
                      {Object.keys(environment.variables).length} vars
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {active && (
            <div className="max-h-56 overflow-y-auto border-b border-slate-100 px-4 py-3">
              <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
                Variables de {active.name}
              </p>
              {variables.length === 0 ? (
                <p className="mt-2 text-[11px] text-slate-400">Ninguna activa.</p>
              ) : (
                <dl className="mt-2 space-y-1">
                  {variables.map(([name, variable]) => {
                    const value = variable.sensitive ? MASK : variable.current || variable.initial;
                    return (
                      <div key={name} className="flex gap-2 font-mono text-[11px]">
                        <dt className="shrink-0 text-slate-700">{name}</dt>
                        <span className="text-slate-300">=</span>
                        <dd
                          className={cn(
                            "min-w-0 truncate",
                            variable.sensitive ? "text-violet-700" : value ? "text-slate-500" : "text-slate-300 italic",
                          )}
                        >
                          {value || "vacía"}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          )}

          <div className="px-4 py-3">
            <Link
              to={`/p/${projectId}/settings/environments`}
              onClick={() => setOpen(false)}
              className="block rounded-lg border border-dashed border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900"
            >
              Gestionar entornos
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
