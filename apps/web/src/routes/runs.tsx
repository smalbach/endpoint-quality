import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, streamRun } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { AssertionRow, Badge, Button, Card, Empty, Json } from "@/components/ui";
import { cn, formatDate, formatDuration, methodStyle, statusClass } from "@/lib/format";
import type { FailureKind, Run, RunCase, RunCaseView, RunSource, RunTotals, RunView } from "@/lib/types";

export function RunsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const runs = useQuery({
    queryKey: ["runs", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<Run[]>(`${base}/runs`),
  });

  if (runs.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;
  if (runs.data?.length === 0) {
    return (
      <Empty
        title="Ninguna corrida todavía"
        hint="Una corrida queda guardada con cada petición que hizo y cada aserción que comprobó. Eso es lo que permite responder a «¿esto estaba en verde la semana pasada?»."
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-slate-100 text-[11px] text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Estado</th>
            <th className="px-4 py-2 font-medium">Inicio</th>
            <th className="px-4 py-2 font-medium">Qué</th>
            <th className="px-4 py-2 font-medium">Casos</th>
            <th className="px-4 py-2 font-medium">Resultado</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {runs.data?.map((run) => (
            <tr key={run.id} className="border-b border-slate-50 last:border-b-0">
              <td className="px-4 py-2">
                <Badge className={cn("border-transparent", statusClass[run.status])}>{run.status}</Badge>
              </td>
              <td className="px-4 py-2 text-slate-600">{formatDate(run.startedAt)}</td>
              <td className="max-w-[18rem] truncate px-4 py-2 text-slate-600" title={sourceLabel(run.source)}>
                {sourceLabel(run.source)}
              </td>
              <td className="px-4 py-2 font-mono text-slate-600">{run.totals.cases}</td>
              <td className="px-4 py-2">
                <Totals totals={run.totals} />
              </td>
              <td className="px-4 py-2 text-right">
                <Link className="font-medium text-slate-900 underline" to={`/p/${projectId}/runs/${run.id}`}>
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Qué ejecutó una corrida, en una línea.
 *
 * Hay tres formas de lanzar una —la matriz generada, un flujo (a veces una vez por fila de datos)
 * y una suite— y en el historial eran la misma fila. «¿Esto estaba verde la semana pasada?» no se
 * contesta en una lista donde todas las entradas se leen igual.
 *
 * Un nombre en `null` es una fila que ya no existe. Se dice, en vez de callarlo: la corrida sigue
 * siendo evidencia de lo que pasó, y el flujo que la produjo ya no está para volver a mirarlo.
 */
function sourceLabel(source: RunSource): string {
  if (source.kind === "suite") {
    return `Suite ${source.name ?? "(eliminada)"} · ${source.flowNames.length} flujos`;
  }
  if (source.kind === "workflow") {
    const flow = `Flujo ${source.name ?? "(eliminado)"}`;
    if (!source.datasetId) return flow;
    return `${flow} · ${source.datasetName ?? "(datos eliminados)"}, ${source.rows} filas`;
  }
  return source.operationIds.length ? `Matriz · ${source.operationIds.length} operaciones` : "Matriz completa";
}

/**
 * De quién es el fallo, en una palabra.
 *
 * Una lista de cuarenta rojos cuesta lo mismo por fila hasta que esto existe: un destino que
 * contestó 5xx, una respuesta cuya forma rompe su propio contrato y una corrida que no salió
 * porque faltaba una variable son tres conversaciones con tres personas distintas.
 *
 * Los colores no son decoración. El ámbar es «no es del destino» —la corrida no llegó a llamarlo,
 * o el presupuesto es nuestro—; el rojo es «sí lo es».
 */
const FAILURE_LABEL: Record<FailureKind, { text: string; className: string }> = {
  network: { text: "red", className: "bg-rose-50 text-rose-700" },
  config: { text: "configuración", className: "bg-amber-50 text-amber-700" },
  server: { text: "5xx", className: "bg-rose-100 text-rose-800" },
  status: { text: "estado", className: "bg-rose-50 text-rose-700" },
  contract: { text: "contrato", className: "bg-rose-50 text-rose-700" },
  check: { text: "comprobación", className: "bg-violet-50 text-violet-700" },
  flow: { text: "flujo", className: "bg-amber-50 text-amber-700" },
  latency: { text: "presupuesto", className: "bg-amber-50 text-amber-700" },
};

function FailureTag({ failure }: { failure: FailureKind }) {
  const { text, className } = FAILURE_LABEL[failure];
  return <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", className)}>{text}</span>;
}

function Totals({ totals }: { totals: RunTotals }) {
  return (
    <span className="flex flex-wrap gap-1">
      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">{totals.passed} ✓</span>
      {totals.failed > 0 && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">{totals.failed} ✗</span>}
      {/* Amber, not red: a case the environment refused is not a finding about the API. */}
      {totals.skipped > 0 && (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">{totals.skipped} ⃠</span>
      )}
    </span>
  );
}

/**
 * One run, followed live.
 *
 * The stream is opened alongside the query rather than instead of it: the SSE connection carries
 * a snapshot first, so a tab opened halfway through sees where things stand instead of waiting
 * for the next case. If the stream cannot be opened — a proxy that buffers `text/event-stream`
 * is a real thing in corporate networks — it falls back to polling and says so, because a
 * progress bar that silently stops moving is worse than one that admits it is polling.
 */
export function RunDetailPage() {
  const { projectId, runId } = useParams();
  const organization = useOrganization();
  const canCancel = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const [live, setLive] = useState<{ totals: RunTotals; cases: Map<string, RunCase> } | null>(null);
  const [streaming, setStreaming] = useState<"connecting" | "live" | "polling">("connecting");
  const [openCase, setOpenCase] = useState<string | null>(null);
  const finished = useRef(false);

  const run = useQuery({
    queryKey: ["run", runId],
    enabled: Boolean(organization && projectId && runId),
    queryFn: () => api<RunView>(`${base}/runs/${runId}`),
    // Only while the stream is not carrying the updates. With SSE live this is a single fetch.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const running = status === "queued" || status === "running";
      return running && streaming === "polling" ? 2000 : false;
    },
  });

  useEffect(() => {
    if (!organization || !projectId || !runId) return;
    const controller = new AbortController();
    finished.current = false;

    void streamRun(`${base}/runs/${runId}/stream`, {
      signal: controller.signal,
      onEvent: (event) => {
        setStreaming("live");
        const payload = event.data as { case?: RunCase; totals?: RunTotals; status?: string };
        setLive((current) => {
          const cases = new Map(current?.cases ?? []);
          if (payload.case) cases.set(payload.case.id, payload.case);
          // An event without totals leaves the last ones standing rather than resetting the bar
          // to zero — which is what a malformed frame used to do, and it read as "the run lost
          // everything it had done".
          const totals = payload.totals ?? current?.totals;
          return totals ? { totals, cases } : current;
        });
        if (payload.status) {
          finished.current = true;
          // The stored run is the source of truth once it is over; the stream was only the
          // running commentary.
          void queryClient.invalidateQueries({ queryKey: ["run", runId] });
        }
      },
    }).catch(() => {
      if (!controller.signal.aborted && !finished.current) setStreaming("polling");
    });

    return () => controller.abort();
  }, [base, organization, projectId, runId, queryClient]);

  const cancel = useMutation({
    mutationFn: () => api<void>(`${base}/runs/${runId}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", runId] }),
  });

  const detail = useQuery({
    queryKey: ["run-case", runId, openCase],
    enabled: Boolean(openCase),
    queryFn: () => api<RunCaseView>(`${base}/runs/${runId}/cases/${openCase}`),
  });

  if (run.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;
  if (!run.data) return <p className="text-sm text-rose-600">No se encontró la corrida.</p>;

  // The live map wins per case while the run is going, so a row flips the moment its case ends —
  // and it can also carry cases the first fetch never saw. A step that loops writes one case per
  // element while the run is walking, so the list has to be the union of the two and not a map
  // over the one that was queued; ordered by `position`, which is what the server orders by.
  const known = new Map(run.data.cases.map((runCase) => [runCase.id, runCase]));
  for (const [id, runCase] of live?.cases ?? []) known.set(id, runCase);
  const cases = [...known.values()].sort((left, right) => left.position - right.position);
  const totals = live?.totals ?? run.data.totals;
  const running = run.data.status === "queued" || run.data.status === "running";
  const progress = totals.cases ? Math.round((totals.completed / totals.cases) * 100) : 0;
  // Counted from the rows and not from the totals, because the totals count verdicts and this
  // counts reasons — and a run whose forty failures are one reason is a different morning from one
  // whose forty are eight.
  const counts = new Map<FailureKind, number>();
  for (const runCase of cases) if (runCase.failure) counts.set(runCase.failure, (counts.get(runCase.failure) ?? 0) + 1);
  const breakdown = [...counts.entries()].sort((left, right) => right[1] - left[1]);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-slate-900 bg-slate-950 text-white">
        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={cn("border-transparent", statusClass[run.data.status])}>{run.data.status}</Badge>
              <span className="text-xs text-slate-400">{formatDate(run.data.startedAt)}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] text-slate-200">
                {sourceLabel(run.data.source)}
              </span>
              {running && (
                <span className="text-[11px] text-slate-500">
                  {streaming === "live"
                    ? "en vivo"
                    : streaming === "polling"
                      ? "consultando cada 2 s (el stream no está disponible)"
                      : "conectando…"}
                </span>
              )}
            </div>
            {run.data.error && (
              <p className="mt-2 rounded bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{run.data.error}</p>
            )}
            <div className="mt-4 flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="w-24 text-right font-mono text-xs text-slate-300">
                {totals.completed}/{totals.cases} · {progress}%
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-emerald-300">
                {totals.passed} correctos
              </span>
              <span className="rounded-full bg-rose-400/10 px-2.5 py-1 text-rose-300">{totals.failed} fallidos</span>
              {/* El desglose por culpable, que es lo que convierte «40 fallidos» en un plan. */}
              {breakdown.map(([failure, count]) => (
                <span key={failure} className="rounded-full bg-white/5 px-2.5 py-1 text-slate-300">
                  {count} {FAILURE_LABEL[failure].text}
                </span>
              ))}
              <span className="rounded-full bg-amber-400/10 px-2.5 py-1 text-amber-300">
                {totals.skipped} no ejecutados
              </span>
            </div>
          </div>
          {running && canCancel && (
            <Button
              variant="ghost"
              className="border-white/20 text-white hover:bg-white/10"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancelar
            </Button>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Card className="max-h-[70vh] overflow-y-auto">
          {cases.map((runCase) => (
            <button
              key={runCase.id}
              onClick={() => setOpenCase(runCase.id)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left last:border-b-0",
                openCase === runCase.id && "bg-slate-50",
              )}
            >
              <Badge className={cn("w-14 shrink-0 justify-center", methodStyle(runCase.method))}>
                {runCase.method}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate font-mono text-[11px] text-slate-700">{runCase.path}</span>
                <span className="block truncate text-[10px] text-slate-400">{runCase.scenarioId}</span>
              </span>
              {runCase.failure && <FailureTag failure={runCase.failure} />}
              <span className="shrink-0 text-[10px] text-slate-400">{formatDuration(runCase.durationMs)}</span>
              <Badge className={cn("shrink-0 border-transparent", statusClass[runCase.status])}>{runCase.status}</Badge>
            </button>
          ))}
        </Card>

        <Card className="p-4">
          {!openCase && (
            <p className="text-xs text-slate-500">
              Elige un caso para ver lo que se envió, lo que llegó y qué se afirmó sobre ello.
            </p>
          )}
          {detail.isLoading && openCase && <p className="text-xs text-slate-500">Cargando…</p>}
          {detail.data && <CaseDetail runCase={detail.data} />}
        </Card>
      </div>
    </div>
  );
}

/** Every request the case made, in order, with its assertions. A `create-read` is three of these
 * and all three are shown: a flow that writes to a database should show everything it wrote and
 * everything it undid. */
function CaseDetail({ runCase }: { runCase: RunCaseView }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={cn(methodStyle(runCase.method))}>{runCase.method}</Badge>
        <span className="font-mono text-xs text-slate-800">{runCase.path}</span>
        <Badge className={cn("border-transparent", statusClass[runCase.status])}>{runCase.status}</Badge>
        <span className="ml-auto font-mono text-[10px] text-slate-400">{runCase.scenarioId}</span>
      </div>

      {runCase.steps.map((step) => (
        <div key={step.id} className="rounded-xl border border-slate-200">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
            <span className={cn("size-2 rounded-full", step.ok ? "bg-emerald-500" : "bg-rose-500")} />
            <span className="text-xs font-medium text-slate-800">{step.label}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{step.purpose}</span>
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              {step.actual
                ? `${step.actual.status} · ${formatDuration(step.durationMs)}`
                : step.prunedAt
                  ? formatDuration(step.durationMs)
                  : "sin respuesta"}
            </span>
          </div>

          <div className="px-3 py-2">
            <p className="truncate font-mono text-[10px] text-slate-500">
              {step.request ? `${step.request.method} ${step.request.url}` : "petición retirada"}
            </p>
            <div className="mt-2">
              {step.assertions.map((assertion, index) => (
                <AssertionRow key={`${assertion.label}-${index}`} {...assertion} />
              ))}
            </div>
            {step.latency && step.latency.samples.length > 1 && (
              <p className="mt-2 font-mono text-[10px] text-slate-400">
                muestras: {step.latency.samples.join(", ")} ms
              </p>
            )}
            {/* El desglose solo cuando alguna parte es visible: en local el DNS es 0 y la descarga
                también, y tres ceros al pie de cada paso son ruido en todas las corridas para que
                una lo agradezca. */}
            {step.latency?.timing && step.latency.timing.dnsMs + step.latency.timing.downloadMs > 0 && (
              <p className="mt-1 font-mono text-[10px] text-slate-400">
                dns {step.latency.timing.dnsMs} ms · respuesta {step.latency.timing.ttfbMs} ms · descarga{" "}
                {step.latency.timing.downloadMs} ms
              </p>
            )}
            {step.prunedAt ? (
              // Sin esto, una corrida vieja se lee como una pared de timeouts: `actual` en null
              // significa «no contestó», y aquí significa «se retiró el cuerpo». Son dos cosas.
              <p className="mt-2 text-[11px] text-slate-400">
                Los cuerpos de esta petición se retiraron el {formatDate(step.prunedAt)} por la política de retención.
                El veredicto y sus aserciones se conservan.
              </p>
            ) : (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-slate-500">Ver petición y respuesta</summary>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Enviado</p>
                    <Json
                      value={step.request ? { headers: step.request.headers, body: step.request.body } : undefined}
                      empty="Sin petición registrada"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Recibido</p>
                    <Json value={step.actual?.body} empty="La API no respondió" />
                  </div>
                </div>
              </details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
