/**
 * Security runs: the list, and one run in detail with its findings and the probes behind them.
 *
 * A finished run is evidence — findings by severity, a score, the request each finding came from —
 * and the detail page is where it is read. While a run is in flight the page follows it live over
 * SSE, falling back to polling if the stream cannot open.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, streamRun } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { RunsTabs } from "@/components/runs-tabs";
import { SecurityRunModal } from "@/components/security-run-modal";
import { cn, formatDate, formatDuration, methodStyle, httpStatusStyle } from "@/lib/format";
import {
  RISK_LABEL,
  RULE_LABEL,
  SEVERITY_CLASS,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  STATUS_CLASS,
  STATUS_LABEL,
  isTerminal,
  scoreColor,
  type RuleKey,
} from "@/lib/security-runs";
import type {
  EndpointView,
  SecurityFinding,
  SecurityProbe,
  SecurityRunDetailView,
  SecurityRunSummaryView,
  SecuritySeverity,
} from "@/lib/types";

export function SecurityRunsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const [creating, setCreating] = useState(false);

  const runs = useQuery({
    queryKey: ["security-runs", projectId],
    enabled: Boolean(organization && projectId),
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => !isTerminal(run.status)) ? 2000 : false),
    queryFn: () => api<SecurityRunSummaryView[]>(`${base}/security-runs`),
  });

  if (!projectId) return null;

  return (
    <div>
      <RunsTabs projectId={projectId} />
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Corridas de seguridad</h1>
          <p className="text-xs text-slate-500">
            Cada corrida envía la matriz de ataques y guarda los hallazgos con su severidad y la petición que los
            produjo.
          </p>
        </div>
        {canEdit && <Button onClick={() => setCreating(true)}>Nueva corrida</Button>}
      </div>

      {runs.isLoading ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : (runs.data ?? []).length === 0 ? (
        <Empty
          title="Ninguna corrida de seguridad todavía"
          hint="Lanza una para ver, por endpoint, qué falla: autorización, autenticación, inyección, exposición de datos y más."
          action={canEdit ? <Button onClick={() => setCreating(true)}>Nueva corrida</Button> : undefined}
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-[11px] text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Etiqueta</th>
                <th className="px-4 py-2 font-medium">Inicio</th>
                <th className="px-4 py-2 font-medium">Puntuación</th>
                <th className="px-4 py-2 font-medium">Hallazgos</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {runs.data?.map((run) => (
                <tr
                  key={run.id}
                  className="cursor-pointer border-b border-slate-50 last:border-b-0 hover:bg-slate-50"
                  onClick={() => navigate(`/p/${projectId}/security/${run.id}`)}
                >
                  <td className="px-4 py-2">
                    <Badge className={cn("border-transparent", STATUS_CLASS[run.status])}>
                      {STATUS_LABEL[run.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-slate-700">{run.label}</td>
                  <td className="px-4 py-2 text-slate-500">{formatDate(run.startedAt)}</td>
                  <td className="px-4 py-2">
                    {run.score === null ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className={cn("font-semibold", scoreColor(run.score))}>{run.score}</span>
                    )}
                    {run.risk && <span className="ml-1 text-[11px] text-slate-400">{RISK_LABEL[run.risk]}</span>}
                  </td>
                  <td className="px-4 py-2">
                    {run.summary ? (
                      <SeverityDots bySeverity={run.summary.bySeverity} />
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      className="font-medium text-slate-900 underline"
                      to={`/p/${projectId}/security/${run.id}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      Ver
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {creating && (
        <SecurityRunModal
          base={base}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onStarted={(runId) => {
            setCreating(false);
            void runs.refetch();
            void navigate(`/p/${projectId}/security/${runId}`);
          }}
        />
      )}
    </div>
  );
}

function SeverityDots({ bySeverity }: { bySeverity: Record<SecuritySeverity, number> }) {
  const shown = SEVERITY_ORDER.filter((severity) => severity !== "info" && bySeverity[severity] > 0);
  if (!shown.length) return <span className="text-[11px] text-emerald-600">sin hallazgos</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((severity) => (
        <span key={severity} className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", SEVERITY_CLASS[severity])}>
          {bySeverity[severity]} {SEVERITY_LABEL[severity]}
        </span>
      ))}
    </span>
  );
}

const emptyFilters = { severity: "", ruleKey: "", endpointId: "", method: "", statusFamily: "" };

export function SecurityRunDetailPage() {
  const { projectId, runId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [live, setLive] = useState<{ percentage: number; phase: string; detail: string } | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    params.set("page", String(page));
    params.set("pageSize", "50");
    return params.toString();
  }, [filters, page]);

  const run = useQuery({
    queryKey: ["security-run", projectId, runId, query],
    enabled: Boolean(organization && runId),
    placeholderData: keepPreviousData,
    queryFn: () => api<SecurityRunDetailView>(`${base}/security-runs/${runId}?${query}`),
  });
  const endpoints = useQuery({
    queryKey: ["endpoints", projectId, "all", "", 1, "security-detail"],
    enabled: Boolean(organization && projectId),
    queryFn: async () =>
      new Map(
        (await api<{ data: EndpointView[] }>(`${base}/endpoints?status=all&limit=500`)).data.map((e) => [
          e.id,
          `${e.method} ${e.path}`,
        ]),
      ),
  });
  const endpointLabel = (id: string | null) => (id ? (endpoints.data?.get(id) ?? id.slice(0, 8)) : "—");

  // Follow a live run over SSE; the query above refetches on each event.
  const running = run.data && !isTerminal(run.data.status);
  const refetch = run.refetch;
  useEffect(() => {
    if (!running || !runId) return;
    const controller = new AbortController();
    streamRun(`${base}/security-runs/${runId}/stream`, {
      signal: controller.signal,
      onEvent: (event) => {
        const data = event.data as { progress?: { percentage: number; phase: string; detail: string } };
        if (data.progress) setLive(data.progress);
        if (event.type === "finished") {
          setLive(null);
          void refetch();
        } else void refetch();
      },
    }).catch(() => undefined);
    return () => controller.abort();
  }, [running, runId, base, refetch]);

  const cancel = useMutation({
    mutationFn: () => api<void>(`${base}/security-runs/${runId}/cancel`, { method: "POST" }),
    onSuccess: () => toast.success("Cancelando…"),
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`${base}/security-runs/${runId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["security-runs", projectId] });
      void navigate(`/p/${projectId}/security`);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const share = useMutation({
    mutationFn: (visibility: "private" | "public") =>
      api<{ visibility: string; shareToken: string | null }>(`${base}/security-runs/${runId}/visibility`, {
        method: "PATCH",
        body: { visibility },
      }),
    onSuccess: () => run.refetch(),
  });

  if (run.isLoading) return <p className="p-4 text-sm text-slate-500">Cargando…</p>;
  if (run.error || !run.data)
    return <p className="m-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">No se encontró la corrida.</p>;
  const data = run.data;
  const summary = data.summary;

  return (
    <div>
      {projectId && <RunsTabs projectId={projectId} />}
      <Link to={`/p/${projectId}/security`} className="mb-3 inline-block text-xs text-slate-500 hover:text-slate-900">
        ← Corridas de seguridad
      </Link>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge className={cn("border-transparent", STATUS_CLASS[data.status])}>{STATUS_LABEL[data.status]}</Badge>
          <h1 className="text-base font-semibold text-slate-900">{data.label}</h1>
          <span className="text-xs text-slate-400">{formatDate(data.startedAt)}</span>
          <div className="ml-auto flex items-center gap-2">
            {running && canEdit && (
              <Button
                variant="ghost"
                className="h-8 text-xs"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancelar
              </Button>
            )}
            {isTerminal(data.status) && canEdit && (
              <>
                <Button
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => share.mutate(data.visibility === "public" ? "private" : "public")}
                >
                  {data.visibility === "public" ? "Hacer privada" : "Compartir"}
                </Button>
                <Button variant="ghost" className="h-8 text-xs text-rose-600" onClick={() => setConfirmDelete(true)}>
                  Eliminar
                </Button>
              </>
            )}
          </div>
        </div>

        {data.visibility === "public" && data.shareToken && (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
            Enlace público: {window.location.origin}/shared/security-runs/{data.shareToken}
          </p>
        )}

        {running && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>{live?.phase ?? data.progress.phase}</span>
              <span>{live?.detail ?? data.progress.detail}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-sky-500 transition-all"
                style={{ width: `${live?.percentage ?? data.progress.percentage}%` }}
              />
            </div>
          </div>
        )}
        {data.error && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{data.error}</p>}

        {summary && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Puntuación"
              value={<span className={scoreColor(summary.score)}>{summary.score}</span>}
              sub={data.risk ? RISK_LABEL[data.risk] : ""}
            />
            <Metric label="Hallazgos" value={summary.findings} sub={`${summary.bySeverity.critical} críticos`} />
            <Metric label="Endpoints probados" value={summary.endpointsTested} />
            <Metric label="Sin proteger" value={summary.unprotected.length} sub="responden sin token" />
          </div>
        )}
      </Card>

      {summary && summary.unprotected.length > 0 && (
        <Card className="mt-4 p-4">
          <p className="text-sm font-semibold text-slate-900">Endpoints sin proteger</p>
          <ul className="mt-2 space-y-1">
            {summary.unprotected.map((entry) => (
              <li key={entry.endpointId} className="flex items-center gap-2 text-[11px]">
                <span className={cn("w-14 rounded px-1 text-center font-mono", methodStyle(entry.method))}>
                  {entry.method}
                </span>
                <span className="font-mono text-slate-700">{entry.path}</span>
                <Badge className={httpStatusStyle(entry.status)}>{entry.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-slate-900">Hallazgos</p>
          <span className="text-[11px] text-slate-400">{data.findingsTotal}</span>
          <select
            className="ml-auto h-7 rounded-md border border-slate-200 px-1 text-[11px]"
            value={filters.severity}
            onChange={(event) => setFilters((f) => ({ ...f, severity: event.target.value }))}
          >
            <option value="">Toda severidad</option>
            {SEVERITY_ORDER.map((severity) => (
              <option key={severity} value={severity}>
                {SEVERITY_LABEL[severity]}
              </option>
            ))}
          </select>
        </div>
        {data.findings.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            {data.status === "passed"
              ? "Sin hallazgos: la matriz no encontró nada que marcar."
              : "Ningún hallazgo con este filtro."}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {data.findings.map((finding, index) => (
              <FindingCard
                key={`${finding.ruleKey}-${finding.endpointId}-${index}`}
                finding={finding}
                endpointLabel={endpointLabel}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-slate-900">Peticiones</p>
          <span className="text-[11px] text-slate-400">{data.probes.total}</span>
          <select
            className="ml-auto h-7 rounded-md border border-slate-200 px-1 text-[11px]"
            value={filters.method}
            onChange={(event) => setFilters((f) => ({ ...f, method: event.target.value }))}
          >
            <option value="">Todo método</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
          <select
            className="h-7 rounded-md border border-slate-200 px-1 text-[11px]"
            value={filters.statusFamily}
            onChange={(event) => setFilters((f) => ({ ...f, statusFamily: event.target.value }))}
          >
            <option value="">Todo código</option>
            {["2", "4", "5"].map((family) => (
              <option key={family} value={family}>
                {family}xx
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 space-y-1">
          {data.probes.data.map((probe) => (
            <ProbeRow key={probe.id} probe={probe} endpointLabel={endpointLabel} />
          ))}
        </div>
        <Pagination
          page={data.probes.page}
          pageSize={data.probes.pageSize}
          total={data.probes.total}
          onPage={setPage}
        />
      </Card>

      {confirmDelete && (
        <ConfirmDialog
          title="Eliminar corrida"
          message="La corrida y sus hallazgos se eliminan. No se puede deshacer."
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-800">{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

function FindingCard({
  finding,
  endpointLabel,
}: {
  finding: SecurityFinding;
  endpointLabel: (id: string | null) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-slate-200">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((value) => !value)}>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", SEVERITY_CLASS[finding.severity])}>
          {SEVERITY_LABEL[finding.severity]}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800">{finding.title}</span>
        <span className="text-[10px] text-slate-400">{RULE_LABEL[finding.ruleKey as RuleKey] ?? finding.ruleName}</span>
        <span className="text-[10px] text-slate-400">{endpointLabel(finding.endpointId)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-600">
          <p>{finding.detail}</p>
          <p>
            <span className="font-semibold text-slate-700">Cómo corregirlo: </span>
            {finding.remediation}
          </p>
          {finding.reproduce.length > 0 && (
            <div>
              <p className="font-semibold text-slate-700">Reproducir</p>
              <ol className="ml-4 list-decimal font-mono">
                {finding.reproduce.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </div>
          )}
          {finding.references.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {finding.references.map((reference) => (
                <a key={reference} href={reference} target="_blank" rel="noreferrer" className="text-sky-700 underline">
                  {new URL(reference).hostname}
                </a>
              ))}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function ProbeRow({ probe, endpointLabel }: { probe: SecurityProbe; endpointLabel: (id: string | null) => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-100">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px]"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={cn("w-12 rounded px-1 text-center font-mono text-[10px]", methodStyle(probe.method))}>
          {probe.method}
        </span>
        <span className="rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-500">{probe.testType}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-slate-600">{probe.path}</span>
        <span className="text-[10px] text-slate-400">{endpointLabel(probe.endpointId)}</span>
        {probe.status === 0 ? (
          <Badge className="bg-slate-100 text-slate-500">sin respuesta</Badge>
        ) : (
          <Badge className={httpStatusStyle(probe.status)}>{probe.status}</Badge>
        )}
        <span className="w-14 text-right text-[10px] text-slate-400">{formatDuration(probe.durationMs)}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-2 text-[11px]">
          {probe.error && <p className="text-rose-700">{probe.error}</p>}
          <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-slate-200">
            {probe.bodyText || "(sin cuerpo)"}
          </pre>
        </div>
      )}
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-center gap-2 text-xs">
      <button
        className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Anterior
      </button>
      <span className="text-slate-500">
        {page} / {pages}
      </span>
      <button
        className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        Siguiente
      </button>
    </div>
  );
}
