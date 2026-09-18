import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Empty, inputClass } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { cn, formatDate } from "@/lib/format";
import {
  EVENT_VERBS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
  isPending,
  pendingConflicts,
  type ForkSide,
} from "@/lib/fork-sync";
import { DiffEntries, Outcome } from "@/routes/fork-sync";
import type {
  ForkSyncOutcomeView,
  MergeRequestDetailView,
  MergeRequestStatus,
  MergeRequestSummaryView,
} from "@/lib/types";

function StatusBadge({ status }: { status: MergeRequestStatus }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", REQUEST_STATUS_TONES[status])}>
      {REQUEST_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Las solicitudes de fusión de un proyecto: las que otros piden llevar a este y las que este pidió
 * llevar a su original.
 *
 * Donde Postman pone las «pull requests» de una colección: una lista propia del proyecto, a la que
 * se llega desde su menú. Primero las pendientes, porque son las que esperan a alguien; las
 * decididas quedan debajo como historia.
 */
export function MergeRequestsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const [all, setAll] = useState(false);
  const list = useQuery({
    queryKey: ["merge-requests", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<MergeRequestSummaryView[]>(`/orgs/${organization!.id}/projects/${projectId}/merge-requests`),
  });
  const rows = (list.data ?? []).filter((row) => all || isPending(row.status));
  const decided = (list.data ?? []).length - (list.data ?? []).filter((row) => isPending(row.status)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Solicitudes de fusión</h1>
          <p className="mt-1 text-xs text-slate-500">
            Se crean desde una bifurcación, en «Fusionar en el original». Aquí se revisan y se deciden.
          </p>
        </div>
        {decided > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
            Ver también las decididas ({decided})
          </label>
        )}
      </div>

      {list.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
      {list.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(list.error as Error).message}</p>
      )}
      {list.data && rows.length === 0 && (
        <Empty
          title={all ? "Ninguna solicitud" : "Nada pendiente"}
          hint="Una bifurcación de este proyecto puede pedir que se fusionen sus cambios."
        />
      )}
      {rows.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/p/${projectId}/merge-requests/${row.id}`}
                    className="block truncate text-sm font-medium text-slate-900 hover:underline"
                  >
                    {row.title}
                  </Link>
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">
                    {row.fork.name} → {row.parent.name} · {row.author.name} · {formatDate(row.createdAt)}
                  </p>
                </div>
                <span className="text-[11px] text-slate-500">
                  {row.changes} cambios{row.conflicts ? ` · ${row.conflicts} en conflicto` : ""}
                  {row.comments ? ` · ${row.comments} comentarios` : ""}
                  {row.approvals ? ` · ${row.approvals} aprobaciones` : ""}
                </span>
                <StatusBadge status={row.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

type ReviewAction = "approve" | "decline" | "close";

/**
 * Una solicitud: qué se pidió, qué se aplicaría ahora, la conversación y la decisión.
 *
 * La comparación de arriba es **la de ahora**, recalculada en cada lectura, y es la que se fusiona:
 * con sus conflictos —que decide quien fusiona, como en la fusión directa— y con su huella, de modo
 * que si uno de los dos proyectos cambia mientras alguien la lee, fusionar dice que cambió en vez de
 * aplicar otra cosa. Lo que se pidió al crearla queda debajo, plegado, para quien quiera ver qué
 * cambió desde entonces.
 *
 * El comentario que se escribe acompaña a la decisión: aprobar o rechazar con el texto escrito lo
 * deja en la misma línea del hilo.
 */
export function MergeRequestDetailPage() {
  const { projectId, requestId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}/merge-requests/${requestId}`;
  const [comment, setComment] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, ForkSide>>({});
  const [confirming, setConfirming] = useState(false);

  const detail = useQuery({
    queryKey: ["merge-requests", projectId, requestId],
    enabled: Boolean(organization && projectId && requestId),
    queryFn: () => api<MergeRequestDetailView>(base),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["merge-requests"] });

  const say = useMutation({
    mutationFn: (input: { action: ReviewAction | "comment"; body: string }) =>
      input.action === "comment"
        ? api<void>(`${base}/comments`, { method: "POST", body: { body: input.body } })
        : api<void>(`${base}/${input.action}`, { method: "POST", body: { body: input.body } }),
    onSuccess: async () => {
      setComment("");
      await refresh();
    },
  });

  const merge = useMutation({
    mutationFn: () =>
      api<ForkSyncOutcomeView>(`${base}/merge`, {
        method: "POST",
        body: { token: detail.data!.current!.token, resolutions },
      }),
    onSuccess: async () => {
      setConfirming(false);
      setResolutions({});
      await queryClient.invalidateQueries();
    },
    onError: () => setConfirming(false),
  });

  const request = detail.data;
  if (detail.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;
  if (detail.error || !request)
    return (
      <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
        {(detail.error as Error | null)?.message ?? "La solicitud no existe"}
      </p>
    );

  const current = request.current;
  const pending = current ? pendingConflicts(current.entries, resolutions) : [];
  const stale = merge.error instanceof ApiError && merge.error.status === 409;
  const review = (action: ReviewAction) => say.mutate({ action, body: comment });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link to={`/p/${projectId}/merge-requests`} className="text-xs text-slate-500 hover:underline">
          ← Solicitudes de fusión
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold text-slate-900">{request.title}</h1>
          <StatusBadge status={request.status} />
        </div>
        <p className="text-xs text-slate-500">
          {request.author.name} pide llevar <span className="font-medium text-slate-700">{request.fork.name}</span> a{" "}
          <span className="font-medium text-slate-700">{request.parent.name}</span> · {formatDate(request.createdAt)}
          {request.approvals > 0 && ` · ${request.approvals} aprobaciones`}
        </p>
        {request.description && <p className="text-sm whitespace-pre-wrap text-slate-700">{request.description}</p>}
      </div>

      {merge.data && <Outcome outcome={merge.data} done="Fusionada" />}
      {(merge.error || say.error) && (
        <div className="flex items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <p className="flex-1">{((merge.error ?? say.error) as Error).message}</p>
          {stale && (
            <Button variant="ghost" className="h-7 text-xs" onClick={() => void detail.refetch()}>
              Volver a comparar
            </Button>
          )}
        </div>
      )}

      {isPending(request.status) && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">Lo que se fusionaría ahora</h2>
          {request.unavailable && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{request.unavailable}</p>
          )}
          {current && current.entries.length === 0 && (
            <Empty title="Nada que fusionar" hint="El original ya tiene todo lo de la bifurcación." />
          )}
          {current && current.entries.length > 0 && (
            <DiffEntries
              view={current}
              resolutions={resolutions}
              onPick={
                request.can.merge && canEdit
                  ? (id, side) => setResolutions((now) => ({ ...now, [id]: side }))
                  : undefined
              }
            />
          )}
        </section>
      )}

      <details className="rounded-lg border border-slate-200 bg-white px-4 py-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-600">
          Lo que se pidió al crearla (versión {request.requestedVersion})
        </summary>
        <div className="mt-2 space-y-2">
          <DiffEntries view={{ source: request.fork, target: request.parent, entries: request.requested }} />
        </div>
      </details>

      <Thread request={request} />

      {canEdit && (
        <Card className="space-y-2">
          <textarea
            aria-label="Comentario"
            className={cn(inputClass, "min-h-20")}
            placeholder="Un comentario. Si apruebas o rechazas, va con la decisión."
            value={comment}
            maxLength={10_000}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {pending.length > 0 && request.can.merge && (
              <p className="mr-auto text-xs text-amber-700">
                {pending.length === 1 ? "Falta decidir un conflicto" : `Faltan ${pending.length} conflictos`}
              </p>
            )}
            <Button
              variant="ghost"
              disabled={!comment.trim() || say.isPending}
              onClick={() => say.mutate({ action: "comment", body: comment })}
            >
              Comentar
            </Button>
            {request.can.close && (
              <Button variant="ghost" disabled={say.isPending} onClick={() => review("close")}>
                Retirar
              </Button>
            )}
            {request.can.decline && (
              <Button variant="danger" disabled={say.isPending} onClick={() => review("decline")}>
                Rechazar
              </Button>
            )}
            {request.can.approve && (
              <Button variant="ghost" disabled={say.isPending} onClick={() => review("approve")}>
                Aprobar
              </Button>
            )}
            {request.can.merge && (
              <Button disabled={pending.length > 0 || merge.isPending} onClick={() => setConfirming(true)}>
                {merge.isPending ? "Fusionando…" : "Fusionar"}
              </Button>
            )}
          </div>
        </Card>
      )}

      {confirming && current && (
        <ConfirmDialog
          title={`Fusionar en «${current.target.name}»`}
          message={
            <>
              Vas a escribir en <strong>{current.target.name}</strong> lo que se ve arriba, comparado ahora mismo, y a
              cerrar la solicitud como fusionada. Los secretos del original no se tocan.
            </>
          }
          confirmLabel="Fusionar"
          danger={false}
          pending={merge.isPending}
          onConfirm={() => merge.mutate()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** El hilo, en orden: comentarios y decisiones, cada una con quién y cuándo. */
function Thread({ request }: { request: MergeRequestDetailView }) {
  if (!request.events.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-900">Conversación</h2>
      <ol className="space-y-2">
        {request.events.map((event) => (
          <li key={event.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="text-[11px] text-slate-500">
              <span className="font-medium text-slate-700">{event.author.name}</span> {EVENT_VERBS[event.kind]} ·{" "}
              {formatDate(event.createdAt)}
            </p>
            {event.body && <p className="mt-1 text-sm whitespace-pre-wrap text-slate-700">{event.body}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
