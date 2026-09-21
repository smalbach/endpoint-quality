/**
 * Performance: plans on the left, the editor in the middle, and the plan's run history on the right.
 * Launching navigates to the run detail, which streams its own timeline.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, streamRun } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { PromptDialog } from "@/components/overlay";
import { DeleteDialog, LifecycleRowActions, LifecycleTabs, stateQuery } from "@/components/lifecycle";
import { cn, formatDate } from "@/lib/format";
import { PerformancePlanEditor } from "@/components/performance-plan-editor";
import {
  RUN_STATUS_CLASS,
  RUN_STATUS_LABEL,
  describeProfile,
  emptyPlanDefinition,
  formatMs,
  formatPct,
  isTerminal,
  peakVus,
} from "@/lib/performance";
import type {
  Environment,
  LifecycleState,
  PerformanceComparisonView,
  PerformancePlanDefinitionView,
  PerformancePlanView,
  PerformanceRunDetailView,
  PerformanceRunSummaryView,
} from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function PerformancePage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId);

  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<PerformancePlanView | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [activeEnvironment, setActiveEnvironment] = useActiveEnvironment(projectId);
  const [naming, setNaming] = useState(false);
  /** Qué lista de planes se está mirando: los que se usan, los archivados o la papelera. */
  const [state, setState] = useState<LifecycleState>("active");
  /** El plan al que se le está preguntando si se borra, y si es el definitivo. */
  const [deleting, setDeleting] = useState<{ plan: PerformancePlanView; purge: boolean } | null>(null);
  const preselected = useRef(false);

  const plans = useQuery({
    queryKey: ["perf-plans", projectId, state],
    enabled,
    queryFn: () => api<PerformancePlanView[]>(`${base}/performance/plans${stateQuery(state)}`),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled,
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const runs = useQuery({
    queryKey: ["perf-runs", projectId, selectedId],
    enabled: enabled && Boolean(selectedId),
    queryFn: () => api<PerformanceRunSummaryView[]>(`${base}/performance/runs?planId=${selectedId}`),
    refetchInterval: 4000,
  });

  useEffect(() => {
    if (preselected.current || !environments.data) return;
    preselected.current = true;
    const active = resolveActive(activeEnvironment, environments.data);
    if (active) setEnvironmentId(active.id);
  }, [environments.data, activeEnvironment]);

  const saved = plans.data?.find((plan) => plan.id === selectedId);
  /**
   * La selección sigue a la lista que se está mirando.
   *
   * Antes solo elegía uno cuando no había ninguno elegido, que bastaba con una sola lista. Con el
   * filtro de estado la elección puede quedarse apuntando a un plan que ya no sale —se archivó, o
   * se cambió de pestaña— y el editor seguiría enseñándolo: un formulario de algo que no está en
   * la lista de al lado.
   */
  useEffect(() => {
    const list = plans.data;
    if (!list) return;
    if (!list.some((plan) => plan.id === selectedId)) setSelectedId(list[0]?.id ?? "");
  }, [plans.data, selectedId]);
  useEffect(() => {
    if (saved) setDraft(structuredClone(saved));
    else if (!selectedId) setDraft(null);
  }, [saved?.id, saved?.updatedAt, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["perf-plans", projectId] });

  const createPlan = useMutation({
    mutationFn: (name: string) =>
      api<{ planId: string }>(`${base}/performance/plans`, {
        method: "POST",
        body: { name, definition: emptyPlanDefinition() },
      }),
    onSuccess: async ({ planId }) => {
      await invalidate();
      setSelectedId(planId);
    },
  });
  const savePlan = useMutation({
    mutationFn: () =>
      api<void>(`${base}/performance/plans/${draft!.id}`, {
        method: "PUT",
        body: { name: draft!.name, description: draft!.description, definition: draft!.definition },
      }),
    onSuccess: invalidate,
  });
  const deletePlan = useMutation({
    mutationFn: ({ planId, purge }: { planId: string; purge: boolean }) =>
      api<void>(`${base}/performance/plans/${planId}${purge ? "?purge=true" : ""}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeleting(null);
      setSelectedId("");
      setDraft(null);
      await invalidate();
    },
  });
  const archivePlan = useMutation({
    mutationFn: ({ planId, archived }: { planId: string; archived: boolean }) =>
      api<void>(`${base}/performance/plans/${planId}/archived`, { method: "PATCH", body: { archived } }),
    onSuccess: async () => {
      setDeleting(null);
      setSelectedId("");
      setDraft(null);
      await invalidate();
    },
  });
  const restorePlan = useMutation({
    mutationFn: (planId: string) => api<void>(`${base}/performance/plans/${planId}/restore`, { method: "POST" }),
    onSuccess: async () => {
      setSelectedId("");
      setDraft(null);
      await invalidate();
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`${base}/performance/plans/${draft!.id}/runs`, {
        method: "POST",
        body: { environmentId },
      }),
    onSuccess: ({ runId }) => void navigate(`/p/${projectId}/performance/${runId}`),
  });

  const dirty = Boolean(draft && saved && !sameJson(draft, saved));
  const setDefinition = (definition: PerformancePlanDefinitionView) =>
    setDraft((current) => current && { ...current, definition });

  if (plans.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">Pruebas de carga</h1>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
              Un plan define escenarios con peso, la forma de la carga y los umbrales que debe cumplir. Se ejecuta
              contra un entorno, siempre desde el servidor y detrás del guard SSRF.
            </p>
          </div>
          {canEdit && draft && (
            <Button disabled={!dirty || savePlan.isPending} onClick={() => savePlan.mutate()}>
              Guardar
            </Button>
          )}
        </div>
        {(message(savePlan.error) ?? message(start.error) ?? message(createPlan.error)) && (
          <p className="mt-3 text-xs text-rose-700">
            {message(savePlan.error) ?? message(start.error) ?? message(createPlan.error)}
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
        <Card className="p-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Planes</p>
            {canEdit && (
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={createPlan.isPending}
                onClick={() => setNaming(true)}
              >
                + Nuevo
              </Button>
            )}
          </div>
          {deleting && (
            <DeleteDialog
              title="Eliminar el plan"
              purge={deleting.purge}
              name={deleting.purge ? deleting.plan.name : undefined}
              message={
                deleting.purge
                  ? `Se va «${deleting.plan.name}» con sus escenarios y sus umbrales. Sus corridas se quedan: cada una guarda el plan como era.`
                  : `«${deleting.plan.name}» sale de la lista de planes. Sus corridas pasadas no se tocan: cada una guarda el plan como era.`
              }
              pending={deletePlan.isPending || archivePlan.isPending}
              onArchive={
                deleting.purge ? undefined : () => archivePlan.mutate({ planId: deleting.plan.id, archived: true })
              }
              onConfirm={() => deletePlan.mutate({ planId: deleting.plan.id, purge: deleting.purge })}
              onClose={() => setDeleting(null)}
            />
          )}
          {naming && (
            <PromptDialog
              title="Nuevo plan"
              label="Nombre del plan"
              hint="Qué carga simula, en pocas palabras."
              placeholder="Catálogo bajo carga"
              onClose={() => setNaming(false)}
              onSubmit={(name) => {
                setNaming(false);
                createPlan.mutate(name);
              }}
            />
          )}
          <LifecycleTabs className="mt-2" state={state} onState={setState} />
          <div className="mt-2 space-y-1">
            {plans.data?.length === 0 && (
              <p className="text-[11px] text-slate-400">
                {state === "active" ? "Ninguno todavía." : state === "archived" ? "Ninguno archivado." : "Papelera vacía."}
              </p>
            )}
            {plans.data?.map((plan) => (
              <button
                key={plan.id}
                onClick={() => setSelectedId(plan.id)}
                className={cn(
                  "w-full rounded-lg px-2 py-2 text-left text-xs",
                  plan.id === selectedId ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50",
                )}
              >
                <span className="block truncate font-medium">{plan.name}</span>
                <span
                  className={cn(
                    "mt-0.5 block text-[10px]",
                    plan.id === selectedId ? "text-slate-300" : "text-slate-400",
                  )}
                >
                  {describeProfile(plan.definition.profile)}
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          {!draft ? (
            <Empty title="Crea tu primer plan" hint="Después añade escenarios y elige la forma de la carga." />
          ) : (
            <div className="space-y-4">
              <Field label="Nombre del plan">
                <input
                  className={inputClass}
                  value={draft.name}
                  disabled={!canEdit}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="Descripción">
                <textarea
                  className={`${inputClass} h-16`}
                  value={draft.description ?? ""}
                  disabled={!canEdit}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </Field>
              <PerformancePlanEditor definition={draft.definition} canEdit={canEdit} onChange={setDefinition} />
              {canEdit && (
                <div className="flex justify-end border-t border-slate-100 pt-3">
                  <LifecycleRowActions
                    state={state}
                    pending={archivePlan.isPending || restorePlan.isPending || deletePlan.isPending}
                    onArchive={(archived) => archivePlan.mutate({ planId: draft.id, archived })}
                    onRestore={() => restorePlan.mutate(draft.id)}
                    onDelete={() => setDeleting({ plan: draft, purge: false })}
                    onPurge={() => setDeleting({ plan: draft, purge: true })}
                  />
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="p-3">
          <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Ejecutar</p>
          <Field label="Entorno">
            <select
              className={inputClass}
              value={environmentId}
              onChange={(event) => {
                setEnvironmentId(event.target.value);
                if (event.target.value) setActiveEnvironment(event.target.value);
              }}
            >
              <option value="">Selecciona…</option>
              {environments.data?.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          </Field>
          <Button
            className="mt-2 w-full"
            disabled={!draft || !environmentId || dirty || !draft.definition.scenarios.length || start.isPending}
            onClick={() => start.mutate()}
          >
            Ejecutar plan
          </Button>
          {dirty && <p className="mt-1 text-[10px] text-amber-600">Guarda los cambios antes de ejecutar.</p>}

          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Historial</p>
            <div className="mt-2 space-y-1">
              {(!runs.data || runs.data.length === 0) && (
                <p className="text-[11px] text-slate-400">Sin corridas todavía.</p>
              )}
              {runs.data?.map((run) => (
                <button
                  key={run.id}
                  onClick={() => navigate(`/p/${projectId}/performance/${run.id}`)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-700">{formatDate(run.startedAt)}</span>
                    {run.summary && (
                      <span className="block text-[10px] text-slate-400">
                        p95 {formatMs(run.summary.p95Ms)} · {run.summary.rps} req/s
                      </span>
                    )}
                  </span>
                  <Badge className={cn("shrink-0 ring-1 ring-inset", RUN_STATUS_CLASS[run.status])}>
                    {RUN_STATUS_LABEL[run.status]}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Run detail
// ------------------------------------------------------------------------------------------------

export function PerformanceRunDetailPage() {
  const { projectId, runId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId && runId);

  const run = useQuery({
    queryKey: ["perf-run", runId],
    enabled,
    queryFn: () => api<PerformanceRunDetailView>(`${base}/performance/runs/${runId}`),
  });
  const others = useQuery({
    queryKey: ["perf-runs-all", projectId],
    enabled,
    queryFn: () => api<PerformanceRunSummaryView[]>(`${base}/performance/runs`),
  });

  // Live timeline: subscribe while the run is going, refetch on each tick and on finish.
  useEffect(() => {
    if (!enabled || !run.data) return;
    if (isTerminal(run.data.status)) return;
    const controller = new AbortController();
    void streamRun(`${base}/performance/runs/${runId}/stream`, {
      signal: controller.signal,
      onEvent: (event) => {
        void queryClient.invalidateQueries({ queryKey: ["perf-run", runId] });
        if (event.type === "finished") controller.abort();
      },
    }).catch(() => undefined);
    return () => controller.abort();
  }, [enabled, run.data?.status, base, runId, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useMutation({
    mutationFn: () => api<void>(`${base}/performance/runs/${runId}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["perf-run", runId] }),
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`${base}/performance/runs/${runId}`, { method: "DELETE" }),
    onSuccess: () => void navigate(`/p/${projectId}/performance`),
  });

  if (run.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;
  if (!run.data) return <p className="text-sm text-slate-500">La corrida no existe.</p>;
  const data = run.data;
  const running = data.status === "queued" || data.status === "running";

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <button
              className="text-[11px] text-slate-400 hover:text-slate-700"
              onClick={() => navigate(`/p/${projectId}/performance`)}
            >
              ← Pruebas de carga
            </button>
            <h1 className="mt-1 text-base font-semibold text-slate-900">{data.planName}</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              {formatDate(data.startedAt)} · {describeProfile(data.definition.profile)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(() => {
              const comparable = (others.data ?? []).filter((other) => other.id !== runId && isTerminal(other.status));
              if (comparable.length === 0) return null;
              return (
                <select
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600"
                  value=""
                  onChange={(event) => {
                    if (event.target.value)
                      void navigate(`/p/${projectId}/performance/compare/${event.target.value}/${runId}`);
                  }}
                >
                  <option value="">Comparar con…</option>
                  {comparable.map((other) => (
                    <option key={other.id} value={other.id}>
                      {formatDate(other.startedAt)} · {RUN_STATUS_LABEL[other.status]}
                    </option>
                  ))}
                </select>
              );
            })()}
            <Badge className={cn("ring-1 ring-inset", RUN_STATUS_CLASS[data.status])}>
              {RUN_STATUS_LABEL[data.status]}
            </Badge>
            {running && canEdit && (
              <Button
                variant="ghost"
                className="h-8 px-3 text-xs"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancelar
              </Button>
            )}
            {!running && canEdit && (
              <Button
                variant="danger"
                className="h-8 px-3 text-xs"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Eliminar
              </Button>
            )}
          </div>
        </div>
        {data.error && <p className="mt-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{data.error}</p>}
        {running && (
          <p className="mt-2 text-xs text-slate-500">
            {data.progress.elapsedS}/{data.progress.totalS} s · {data.progress.requests} peticiones ·{" "}
            {data.progress.vus} usuarios
          </p>
        )}
      </Card>

      {data.summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Metric label="Peticiones" value={String(data.summary.requests)} />
          <Metric label="Errores" value={formatPct(data.summary.errorRate)} bad={data.summary.errorRate > 0} />
          <Metric label="req/s" value={String(data.summary.rps)} />
          <Metric label="p50" value={formatMs(data.summary.p50Ms)} />
          <Metric label="p90" value={formatMs(data.summary.p90Ms)} />
          <Metric label="p95" value={formatMs(data.summary.p95Ms)} />
          <Metric label="p99" value={formatMs(data.summary.p99Ms)} />
        </div>
      )}

      {data.thresholds.length > 0 && (
        <Card className="p-4">
          <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Umbrales</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.thresholds.map((threshold) => (
              <span
                key={threshold.label}
                className={cn(
                  "rounded-md px-2 py-1 text-xs ring-1 ring-inset",
                  threshold.ok
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                    : "bg-rose-50 text-rose-700 ring-rose-200",
                )}
              >
                {threshold.ok ? "✓" : "✗"} {threshold.label}: {threshold.actual}{" "}
                <span className="text-slate-400">({threshold.limit})</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      {data.windows.length > 0 && <WindowsChart windows={data.windows} profile={data.definition.profile} />}

      {data.endpoints.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Endpoint</th>
                <th className="px-3 py-2 text-right">Peticiones</th>
                <th className="px-3 py-2 text-right">Errores</th>
                <th className="px-3 py-2 text-right">p95</th>
                <th className="px-3 py-2 text-right">media</th>
              </tr>
            </thead>
            <tbody>
              {data.endpoints.map((endpoint) => (
                <tr key={`${endpoint.method} ${endpoint.path}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-slate-700">
                    {endpoint.method} {endpoint.path}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{endpoint.requests}</td>
                  <td className={cn("px-3 py-2 text-right", endpoint.failures ? "text-rose-600" : "text-slate-400")}>
                    {formatPct(endpoint.errorRate)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{formatMs(endpoint.p95Ms)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{formatMs(endpoint.avgMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <Card className="p-3">
      <p className="text-[10px] tracking-wide text-slate-400 uppercase">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold", bad ? "text-rose-600" : "text-slate-900")}>{value}</p>
    </Card>
  );
}

/** rps bars with a p95 line and the virtual-user line over them — the timeline, read at a glance. */
function WindowsChart({
  windows,
  profile,
}: {
  windows: PerformanceRunDetailView["windows"];
  profile: PerformanceRunDetailView["definition"]["profile"];
}) {
  const width = 720;
  const height = 160;
  const pad = 28;
  const maxRps = Math.max(1, ...windows.map((w) => w.rps));
  const maxP95 = Math.max(1, ...windows.map((w) => w.p95Ms));
  const maxVus = Math.max(1, peakVus(profile));
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const x = (index: number) => pad + (windows.length <= 1 ? innerW / 2 : (index / (windows.length - 1)) * innerW);
  const barW = Math.max(2, innerW / windows.length - 2);
  const line = (pick: (w: PerformanceRunDetailView["windows"][number]) => number, max: number) =>
    windows.map((w, index) => `${x(index)},${pad + innerH - (pick(w) / max) * innerH}`).join(" ");

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Timeline (ventanas de 5 s)</p>
        <p className="text-[10px] text-slate-400">
          <span className="text-slate-500">▮</span> req/s · <span className="text-sky-500">━</span> p95 ·{" "}
          <span className="text-amber-500">━</span> usuarios
        </p>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 w-full" role="img" aria-label="Evolución de la corrida">
        {windows.map((w, index) => (
          <rect
            key={index}
            x={x(index) - barW / 2}
            y={pad + innerH - (w.rps / maxRps) * innerH}
            width={barW}
            height={(w.rps / maxRps) * innerH}
            className={w.failures ? "fill-rose-200" : "fill-slate-200"}
          />
        ))}
        <polyline points={line((w) => w.p95Ms, maxP95)} fill="none" className="stroke-sky-500" strokeWidth={1.5} />
        <polyline
          points={line((w) => w.vus, maxVus)}
          fill="none"
          className="stroke-amber-500"
          strokeWidth={1.5}
          strokeDasharray="3 2"
        />
        <text x={pad} y={height - 6} className="fill-slate-400 text-[9px]">
          0 s
        </text>
        <text x={width - pad} y={height - 6} textAnchor="end" className="fill-slate-400 text-[9px]">
          {windows[windows.length - 1].atS + 5} s
        </text>
      </svg>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------
// Compare two runs
// ------------------------------------------------------------------------------------------------

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;
const signedMs = (value: number) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatMs(Math.abs(value))}`;
/** A difference between two rates, in percentage points (0.01 = one point). */
const signedPoints = (fraction: number) => `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(2)} pt`;
/** A relative change, as a percentage of the base. */
const signedRel = (ratio: number) => `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`;

/** Colour a delta by which run it favours — the query already decided `better`, so the screen only
 * paints it. A tie is grey, never green. */
const betterClass = (better: "target" | "base" | "same") =>
  better === "target" ? "text-emerald-600" : better === "base" ? "text-rose-600" : "text-slate-400";

export function PerformanceComparePage() {
  const { projectId, baseRunId = "", targetRunId = "" } = useParams();
  const organization = useOrganization();
  const navigate = useNavigate();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId && baseRunId && targetRunId);

  const comparison = useQuery({
    queryKey: ["perf-compare", projectId, baseRunId, targetRunId],
    enabled,
    queryFn: () =>
      api<PerformanceComparisonView>(`${base}/performance/compare?base=${baseRunId}&target=${targetRunId}`),
  });
  const runs = useQuery({
    queryKey: ["perf-runs-all", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<PerformanceRunSummaryView[]>(`${base}/performance/runs`),
  });

  const terminal = (runs.data ?? []).filter((run) => isTerminal(run.status));
  const go = (nextBase: string, nextTarget: string) => {
    if (nextBase && nextTarget && nextBase !== nextTarget)
      void navigate(`/p/${projectId}/performance/compare/${nextBase}/${nextTarget}`);
  };
  const picker = (value: string, onPick: (id: string) => void) => (
    <select
      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700"
      value={value}
      onChange={(event) => onPick(event.target.value)}
    >
      {terminal.map((run) => (
        <option key={run.id} value={run.id}>
          {run.planName} · {formatDate(run.startedAt)} · {RUN_STATUS_LABEL[run.status]}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <button
          className="text-[11px] text-slate-400 hover:text-slate-700"
          onClick={() => navigate(`/p/${projectId}/performance`)}
        >
          ← Pruebas de carga
        </button>
        <h1 className="mt-1 text-base font-semibold text-slate-900">Comparar corridas</h1>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Base</p>
            <div className="mt-1">{picker(baseRunId, (id) => go(id, targetRunId))}</div>
          </div>
          <span className="hidden text-slate-300 sm:block">vs</span>
          <div>
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Comparada</p>
            <div className="mt-1">{picker(targetRunId, (id) => go(baseRunId, id))}</div>
          </div>
        </div>
      </Card>

      {comparison.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
      {message(comparison.error) && (
        <Card className="p-4">
          <p className="text-xs text-rose-700">{message(comparison.error)}</p>
        </Card>
      )}

      {comparison.data && (
        <>
          <ComparisonHeads data={comparison.data} />
          {comparison.data.metrics.length > 0 ? (
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Métrica</th>
                    <th className="px-3 py-2 text-right">Base</th>
                    <th className="px-3 py-2 text-right">Comparada</th>
                    <th className="px-3 py-2 text-right">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.data.metrics.map((metric) => (
                    <tr key={metric.metric} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-600">{metric.label}</td>
                      <td className="px-3 py-2 text-right text-slate-700">
                        {formatMetric(metric.metric, metric.base)}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-700">
                        {formatMetric(metric.metric, metric.target)}
                      </td>
                      <td className={cn("px-3 py-2 text-right font-medium", betterClass(metric.better))}>
                        {formatDelta(metric)}
                        {metric.pct !== null && metric.metric !== "errorRate" && (
                          <span className="ml-1 text-[10px] text-slate-400">({signedRel(metric.pct)})</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <Empty title="Sin resumen que comparar" hint="Alguna de las corridas no terminó con métricas." />
          )}

          {comparison.data.thresholds.length > 0 && (
            <Card className="p-4">
              <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Umbrales</p>
              <div className="mt-2 space-y-1">
                {comparison.data.thresholds.map((threshold) => (
                  <div key={threshold.label} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-600">{threshold.label}</span>
                    <span className="flex items-center gap-3">
                      <ThresholdCell side={threshold.base} />
                      <span className="text-slate-300">→</span>
                      <ThresholdCell side={threshold.target} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {comparison.data.endpoints.length > 0 && (
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Endpoint</th>
                    <th className="px-3 py-2 text-right">p95 base</th>
                    <th className="px-3 py-2 text-right">p95 comp.</th>
                    <th className="px-3 py-2 text-right">Δ p95</th>
                    <th className="px-3 py-2 text-right">Δ errores</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.data.endpoints.map((endpoint) => (
                    <tr key={`${endpoint.method} ${endpoint.path}`} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-slate-700">
                        {endpoint.method} {endpoint.path}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {endpoint.base ? formatMs(endpoint.base.p95Ms) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {endpoint.target ? formatMs(endpoint.target.p95Ms) : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-medium",
                          endpoint.p95Delta === null
                            ? "text-slate-400"
                            : endpoint.p95Delta > 0
                              ? "text-rose-600"
                              : endpoint.p95Delta < 0
                                ? "text-emerald-600"
                                : "text-slate-400",
                        )}
                      >
                        {endpoint.p95Delta === null
                          ? endpoint.base
                            ? "quitado"
                            : "nuevo"
                          : signedMs(endpoint.p95Delta)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right",
                          endpoint.errorRateDelta === null
                            ? "text-slate-400"
                            : endpoint.errorRateDelta > 0
                              ? "text-rose-600"
                              : endpoint.errorRateDelta < 0
                                ? "text-emerald-600"
                                : "text-slate-400",
                        )}
                      >
                        {endpoint.errorRateDelta === null ? "—" : signedPoints(endpoint.errorRateDelta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const formatMetric = (metric: PerformanceComparisonView["metrics"][number]["metric"], value: number) =>
  metric === "errorRate" ? formatPct(value) : metric === "rps" ? String(value) : formatMs(value);

const formatDelta = (metric: PerformanceComparisonView["metrics"][number]) => {
  if (metric.delta === 0) return "=";
  if (metric.metric === "errorRate") return signedPoints(metric.delta);
  if (metric.metric === "rps") return signed(metric.delta);
  return signedMs(metric.delta);
};

function ComparisonHeads({ data }: { data: PerformanceComparisonView }) {
  const head = (run: PerformanceComparisonView["base"], tag: string) => (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{tag}</p>
        <Badge className={cn("ring-1 ring-inset", RUN_STATUS_CLASS[run.status])}>{RUN_STATUS_LABEL[run.status]}</Badge>
      </div>
      <p className="mt-1 truncate text-sm font-medium text-slate-800">{run.planName}</p>
      <p className="text-[11px] text-slate-500">{formatDate(run.startedAt)}</p>
    </Card>
  );
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {head(data.base, "Base")}
      {head(data.target, "Comparada")}
    </div>
  );
}

function ThresholdCell({ side }: { side: PerformanceComparisonView["thresholds"][number]["base"] }) {
  if (!side) return <span className="text-slate-400">—</span>;
  return (
    <span className={cn("font-medium", side.ok ? "text-emerald-600" : "text-rose-600")}>
      {side.ok ? "✓" : "✗"} {side.actual}
    </span>
  );
}
