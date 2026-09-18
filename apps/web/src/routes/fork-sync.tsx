import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Empty } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { cn } from "@/lib/format";
import {
  KIND_LABELS,
  STATUS_LABELS,
  changeSummary,
  directionCopy,
  entryId,
  pendingConflicts,
  showValue,
  writesSomething,
  type ForkDirection,
  type ForkSide,
} from "@/lib/fork-sync";
import type { ForkDiffEntryView, ForkDiffView, ForkSyncOutcomeView } from "@/lib/types";

/**
 * Traer cambios del original, o fusionar en él: la comparación a tres bandas, elemento a elemento.
 *
 * Una pantalla y no un diálogo, como en Postman: una fusión con veinte elementos y tres conflictos
 * se lee campo a campo, y eso no cabe en una ventana encima de otra cosa.
 *
 * Lo que decide está a la vista antes de pulsar nada: qué llega, qué se queda porque solo cambió
 * aquí, y qué pide elegir. Un conflicto no tiene lado por defecto —elegir por alguien es perder el
 * trabajo del otro en silencio—, y el botón no se activa hasta que todos lo tienen. Fusionar escribe
 * en el original, que es de todos, así que pide confirmación nombrándolo.
 */
export function ForkSyncPage() {
  const { projectId, direction: raw } = useParams();
  const direction: ForkDirection = raw === "merge" ? "merge" : "pull";
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const copy = directionCopy(direction);
  const [resolutions, setResolutions] = useState<Record<string, ForkSide>>({});
  const [confirming, setConfirming] = useState(false);

  const diff = useQuery({
    queryKey: ["fork-diff", projectId, direction],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ForkDiffView>(`${base}/fork/${direction}`),
  });

  const apply = useMutation({
    mutationFn: () =>
      api<ForkSyncOutcomeView>(`${base}/fork/${direction}`, {
        method: "POST",
        body: { token: diff.data!.token, resolutions },
      }),
    onSuccess: async () => {
      setConfirming(false);
      setResolutions({});
      await queryClient.invalidateQueries();
    },
    onError: () => setConfirming(false),
  });

  const view = diff.data;
  const entries = view?.entries ?? [];
  const pending = pendingConflicts(entries, resolutions);
  const writes = writesSomething(entries, resolutions);
  const stale = apply.error instanceof ApiError && apply.error.status === 409;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">{copy.title}</h1>
          {view && (
            <p className="mt-1 text-xs text-slate-500">
              De <span className="font-medium text-slate-700">{view.source.name}</span> a{" "}
              <span className="font-medium text-slate-700">{view.target.name}</span>, contra lo que tenían en común en
              la versión {view.version}.
            </p>
          )}
        </div>
        <Link
          to={`/p/${projectId}/fork/${direction === "pull" ? "merge" : "pull"}`}
          className="text-xs text-slate-500 underline-offset-2 hover:underline"
        >
          {direction === "pull" ? "Fusionar en el original" : "Traer cambios del original"}
        </Link>
      </div>

      {diff.isLoading && <p className="text-sm text-slate-500">Comparando…</p>}
      {diff.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(diff.error as Error).message}</p>
      )}

      {apply.data && <Outcome outcome={apply.data} done={copy.done} />}
      {apply.error && (
        <div className="flex items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <p className="flex-1">{(apply.error as Error).message}</p>
          {stale && (
            <Button variant="ghost" className="h-7 text-xs" onClick={() => void diff.refetch()}>
              Volver a comparar
            </Button>
          )}
        </div>
      )}

      {view && entries.length === 0 && (
        <Empty title="Nada que sincronizar" hint="Los dos proyectos tienen lo mismo desde la última sincronización." />
      )}

      {view && entries.length > 0 && (
        <>
          <Summary entries={entries} />
          {(Object.keys(KIND_LABELS) as ForkDiffEntryView["kind"][]).map((kind) => {
            const group = entries.filter((entry) => entry.kind === kind);
            if (!group.length) return null;
            return (
              <Card key={kind} className="p-0">
                <p className="border-b border-slate-100 px-4 py-2 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
                  {KIND_LABELS[kind]}
                </p>
                <ul className="divide-y divide-slate-100">
                  {group.map((entry) => (
                    <EntryRow
                      key={entryId(entry)}
                      entry={entry}
                      view={view}
                      side={resolutions[entryId(entry)]}
                      onPick={(side) => setResolutions((current) => ({ ...current, [entryId(entry)]: side }))}
                    />
                  ))}
                </ul>
              </Card>
            );
          })}

          <div className="flex items-center justify-end gap-3">
            {pending.length > 0 && (
              <p className="text-xs text-amber-700">
                {pending.length === 1 ? "Falta decidir un conflicto" : `Faltan ${pending.length} conflictos`}
              </p>
            )}
            {!writes && pending.length === 0 && (
              <p className="text-xs text-slate-500">Nada de esto escribe en {view.target.name}.</p>
            )}
            <Button
              disabled={!canEdit || pending.length > 0 || apply.isPending}
              onClick={() => (direction === "merge" ? setConfirming(true) : apply.mutate())}
            >
              {apply.isPending ? "Aplicando…" : copy.action}
            </Button>
          </div>
        </>
      )}

      {confirming && view && (
        <ConfirmDialog
          title={`Fusionar en «${view.target.name}»`}
          message={
            <>
              Vas a escribir en <strong>{view.target.name}</strong>, el proyecto original, lo que cambió en esta
              bifurcación. Sus secretos no se tocan: un entorno que llega conserva los valores que el original ya tenía.
            </>
          }
          confirmLabel="Fusionar"
          danger={false}
          pending={apply.isPending}
          onConfirm={() => apply.mutate()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

const STATUS_TONES: Record<ForkDiffEntryView["status"], string> = {
  incoming: "bg-sky-50 text-sky-700",
  kept: "bg-slate-100 text-slate-600",
  same: "bg-emerald-50 text-emerald-700",
  conflict: "bg-amber-100 text-amber-800",
};

function Summary({ entries }: { entries: ForkDiffEntryView[] }) {
  const count = (status: ForkDiffEntryView["status"]) => entries.filter((entry) => entry.status === status).length;
  return (
    <p className="text-xs text-slate-600">
      {[
        `${count("incoming")} llegan`,
        `${count("conflict")} en conflicto`,
        `${count("kept")} se quedan como están`,
        count("same") ? `${count("same")} ya iguales` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}

/**
 * Un elemento: qué pasó en cada lado y, abierto, sus campos. En un conflicto, los dos botones que
 * deciden, con el nombre del proyecto de cada lado y no «origen» y «destino».
 */
function EntryRow({
  entry,
  view,
  side,
  onPick,
}: {
  entry: ForkDiffEntryView;
  view: ForkDiffView;
  side: ForkSide | undefined;
  onPick: (side: ForkSide) => void;
}) {
  const [open, setOpen] = useState(entry.status === "conflict");
  return (
    <li className="px-4 py-2.5" data-testid={`entry-${entryId(entry)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-slate-800"
          aria-expanded={open}
        >
          {entry.label}
        </button>
        <span className="text-[11px] text-slate-500">{changeSummary(entry, view.source.name, view.target.name)}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_TONES[entry.status])}>
          {STATUS_LABELS[entry.status]}
        </span>
      </div>
      {entry.status === "conflict" && (
        <div role="radiogroup" aria-label={`Qué lado gana en ${entry.label}`} className="mt-2 flex flex-wrap gap-2">
          {(["source", "target"] as const).map((option) => (
            <label
              key={option}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]",
                side === option ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 text-slate-600",
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={entryId(entry)}
                checked={side === option}
                onChange={() => onPick(option)}
              />
              Quedarse con {option === "source" ? view.source.name : view.target.name}
            </label>
          ))}
        </div>
      )}
      {open && entry.fields.length > 0 && (
        <table className="mt-2 w-full table-fixed text-[11px]">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="w-1/4 py-1 font-medium">Campo</th>
              <th className="py-1 font-medium">En común</th>
              <th className="py-1 font-medium">{view.source.name}</th>
              <th className="py-1 font-medium">{view.target.name}</th>
            </tr>
          </thead>
          <tbody>
            {entry.fields.map((field) => (
              <tr key={field.path} className="align-top">
                <td className="py-1 pr-2 font-mono text-slate-600">{field.path}</td>
                {[field.base, field.source, field.target].map((value, index) => (
                  <td key={index} className="py-1 pr-2 font-mono break-all text-slate-700">
                    {showValue(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

const APPLIED_LABELS: Record<keyof ForkSyncOutcomeView["applied"], string> = {
  endpoint: "endpoints",
  template: "pruebas",
  workflow: "flujos",
  environment: "entornos",
};

function Outcome({ outcome, done }: { outcome: ForkSyncOutcomeView; done: string }) {
  const applied = (Object.keys(APPLIED_LABELS) as (keyof ForkSyncOutcomeView["applied"])[])
    .filter((kind) => outcome.applied[kind] > 0)
    .map((kind) => `${outcome.applied[kind]} ${APPLIED_LABELS[kind]}`);
  return (
    <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
      <p>
        {done} (versión {outcome.version}): {applied.join(" · ") || "nada que escribir"}.
      </p>
      {outcome.skipped.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-amber-800">
          {outcome.skipped.map((entry, index) => (
            <li key={index}>
              <span className="font-medium">{entry.what}</span> — {entry.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
