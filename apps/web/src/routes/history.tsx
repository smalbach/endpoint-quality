/**
 * One timeline of everything the organization has analysed, with a search and a type filter.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, inputClass } from "@/components/ui";
import { cn, formatDate } from "@/lib/format";
import type { HistoryKind, HistoryPageView } from "@/lib/types";

const KINDS: { value: HistoryKind | "all"; label: string }[] = [
  { value: "all", label: "Todo" },
  { value: "security", label: "Seguridad" },
  { value: "contract", label: "Contrato" },
  { value: "performance", label: "Rendimiento" },
  { value: "scan", label: "Escaneo" },
];
const KIND_CLASS: Record<HistoryKind, string> = {
  security: "bg-violet-50 text-violet-700 ring-violet-200",
  contract: "bg-sky-50 text-sky-700 ring-sky-200",
  performance: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  scan: "bg-amber-50 text-amber-700 ring-amber-200",
};
const KIND_LABEL: Record<HistoryKind, string> = {
  security: "Seguridad",
  contract: "Contrato",
  performance: "Rendimiento",
  scan: "Escaneo",
};

export function HistoryPage() {
  const organization = useOrganization();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<HistoryKind | "all">("all");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const history = useQuery({
    queryKey: ["history", organization?.id, search, kind, page],
    enabled: Boolean(organization),
    queryFn: () =>
      api<HistoryPageView>(
        `/orgs/${organization!.id}/history?search=${encodeURIComponent(search)}&kind=${kind}&page=${page}&pageSize=${pageSize}`,
      ),
  });

  const data = history.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Historial</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Todo lo que se ha analizado, de todos los proyectos, en una línea.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cn(inputClass, "max-w-xs")}
          placeholder="Buscar por proyecto o título…"
          value={search}
          onChange={(event) => {
            setPage(1);
            setSearch(event.target.value);
          }}
        />
        <div className="flex gap-1">
          {KINDS.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                setPage(1);
                setKind(option.value);
              }}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                kind === option.value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {history.isLoading ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : !data || data.entries.length === 0 ? (
        <Empty title="Nada todavía" hint="Las corridas y escaneos que ejecutes aparecerán aquí." />
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Fecha</th>
                <th className="px-3 py-2 text-left">Proyecto</th>
                <th className="px-3 py-2 text-left">Tipo</th>
                <th className="px-3 py-2 text-left">Análisis</th>
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-right">Métrica</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={`${entry.kind}-${entry.id}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">{formatDate(entry.createdAt)}</td>
                  <td className="px-3 py-2 text-slate-700">{entry.projectName}</td>
                  <td className="px-3 py-2">
                    <Badge className={cn("ring-1 ring-inset", KIND_CLASS[entry.kind])}>{KIND_LABEL[entry.kind]}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Link to={entry.href} className="text-slate-700 hover:underline">
                      {entry.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{entry.status}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{entry.metric ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data && pages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {data.total} análisis · página {data.page} de {pages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Anterior
            </Button>
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
