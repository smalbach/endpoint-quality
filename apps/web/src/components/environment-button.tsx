/**
 * The environment a project is working against, in the top bar, and the session token next to it.
 *
 * Which one is active is the first thing somebody needs to know before pressing «Ejecutar» or
 * «Enviar», and the last thing they remember to check. So it is always on screen while inside a
 * project, with its variables one click away, a way to change it without leaving the page, and —
 * the analyzer's other half of this button — the token the last login or script captured, with how
 * long it has left.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { cn } from "@/lib/format";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { countdownTone, formatCountdown, useSessionToken, visibleClaims } from "@/lib/session-token";
import { EnvironmentManager } from "@/components/environment-manager";
import { useToast } from "@/components/toast";
import type { Environment, SessionTokenView } from "@/lib/types";

const MASK = "••••••••";

export function EnvironmentButton({ projectId }: { projectId: string }) {
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [stored, activate] = useActiveEnvironment(projectId);
  const root = useRef<HTMLDivElement>(null);

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization),
    queryFn: () => api<Environment[]>(`/orgs/${organization!.id}/projects/${projectId}/environments`),
  });
  const session = useSessionToken(projectId);
  const list = environments.data ?? [];
  const active = resolveActive(stored, list);
  const token = session.data ?? null;
  const now = useNow(Boolean(token?.expiresAt));
  const tokenLive = token && !token.expired && (!token.expiresAt || new Date(token.expiresAt).getTime() > now);

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
        {tokenLive && (
          <span className="rounded bg-violet-50 px-1 text-[10px] font-semibold text-violet-700">Token</span>
        )}
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
                    disabled={!canEdit && !isActive}
                    title={!canEdit ? "Cambiar el entorno activo necesita el rol editor" : undefined}
                    onClick={() => {
                      if (isActive) return;
                      activate(environment.id);
                      toast.success(`Entorno «${environment.name}» activo`);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left disabled:cursor-not-allowed",
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

          <SessionTokenSection projectId={projectId} token={token} now={now} />

          <div className="px-4 py-3">
            <button
              onClick={() => {
                setOpen(false);
                setManaging(true);
              }}
              className="block w-full rounded-lg border border-dashed border-slate-300 px-3 py-2 text-center text-xs font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900"
            >
              Gestionar entornos
            </button>
          </div>
        </div>
      )}

      {managing && <EnvironmentManager projectId={projectId} onClose={() => setManaging(false)} />}
    </div>
  );
}

/** A clock that ticks every second while something on screen counts down, and not otherwise. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

const TONE: Record<ReturnType<typeof countdownTone>, string> = {
  expired: "text-rose-600",
  urgent: "text-rose-600",
  soon: "text-amber-600",
  ok: "text-emerald-600",
};

function SessionTokenSection({
  projectId,
  token,
  now,
}: {
  projectId: string;
  token: SessionTokenView | null;
  now: number;
}) {
  const organization = useOrganization();
  const queryClient = useQueryClient();
  const toast = useToast();
  const clear = useMutation({
    mutationFn: () => api<void>(`/orgs/${organization?.id}/projects/${projectId}/session-token`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["session-token", projectId] });
      toast.success("Token de sesión olvidado");
    },
  });

  return (
    <div className="border-b border-slate-100 px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Token de sesión</p>
        {token && (
          <button
            className="ml-auto text-[11px] text-slate-500 hover:text-rose-600"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            Olvidar
          </button>
        )}
      </div>
      {!token ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-slate-500">
            Ninguno capturado. Se captura al enviar el login del proyecto, o desde un script:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-slate-950 px-2 py-1.5 font-mono text-[10px] leading-4 text-slate-100">
            {'const data = pm.response.json();\npm.environment.set("token", data.access_token);'}
          </pre>
        </div>
      ) : (
        <div className="mt-2 space-y-1.5 text-[11px]">
          <p className="text-slate-500">
            {token.source === "login" ? "Del login" : "De un script"} ·{" "}
            <span className="font-mono text-slate-600">{token.preview}</span>
          </p>
          <p>
            <span className="text-slate-500">Caduca en: </span>
            {token.expiresAt ? (
              <span
                className={cn(
                  "font-semibold",
                  TONE[countdownTone(token.expired ? 0 : new Date(token.expiresAt).getTime() - now)],
                )}
              >
                {formatCountdown(token.expired ? 0 : new Date(token.expiresAt).getTime() - now)}
              </span>
            ) : (
              <span className="text-slate-400">desconocido</span>
            )}
          </p>
          {visibleClaims(token.claims).length > 0 && (
            <dl className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg bg-slate-50 px-2 py-1.5 font-mono text-[10px]">
              {visibleClaims(token.claims).map(([name, value]) => (
                <div key={name} className="flex gap-1.5">
                  <dt className="shrink-0 text-slate-500">{name}:</dt>
                  <dd className="min-w-0 truncate text-slate-700" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-slate-400">«Enviar» con autenticación heredada lo usa mientras no caduque.</p>
        </div>
      )}
    </div>
  );
}
