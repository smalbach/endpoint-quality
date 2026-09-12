/**
 * The left half of Endpoints: the tree, its filters, the bulk bar and the import panel.
 *
 * What differs from the analyzer, on purpose: the import says what came in and what did not, with
 * the reason, instead of a toast; the status buttons carry their counts; and a single endpoint can
 * be archived from its row, not only in bulk.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { Badge, Button, inputClass } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { cn, methodStyle } from "@/lib/format";
import {
  buildEndpointTree,
  endpointIdsOf,
  selectionState,
  toggleGroup,
  type EndpointFolder,
} from "@/lib/endpoint-tree";
import type { EndpointImportResult, EndpointPage, EndpointStatus, EndpointView } from "@/lib/types";

export type StatusFilter = EndpointStatus | "all";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Activos" },
  { value: "archived", label: "Archivados" },
  { value: "inactive", label: "Inactivos" },
  { value: "all", label: "Todos" },
];

const STATUS_BADGE: Record<EndpointStatus, { label: string; className: string }> = {
  active: { label: "activo", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  archived: { label: "archivado", className: "border-amber-200 bg-amber-50 text-amber-700" },
  inactive: { label: "inactivo", className: "border-slate-200 bg-slate-100 text-slate-500" },
};

export function EndpointList({
  base,
  page,
  loading,
  status,
  onStatus,
  search,
  onSearch,
  pageNumber,
  onPage,
  selectedId,
  onSelect,
  onNew,
  canEdit,
  onChanged,
  onRemoved,
}: {
  base: string;
  page: EndpointPage | undefined;
  loading: boolean;
  status: StatusFilter;
  onStatus: (status: StatusFilter) => void;
  search: string;
  onSearch: (search: string) => void;
  pageNumber: number;
  onPage: (page: number) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  canEdit: boolean;
  onChanged: () => Promise<unknown>;
  onRemoved: (ids: string[]) => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState(search);
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{ ids: string[]; label: string } | null>(null);

  // 350 ms after the last keystroke, like the analyzer; the page goes back to 1 with it.
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  useEffect(() => {
    if (typed === search) return;
    const timer = window.setTimeout(() => onSearchRef.current(typed), 350);
    return () => window.clearTimeout(timer);
  }, [typed, search]);

  // A filter change is a different list: what was selected in the old one is not in view.
  useEffect(() => setSelected(new Set()), [status, search]);

  const endpoints = page?.data ?? [];
  const tree = buildEndpointTree(endpoints);
  // Searching opens every folder: a match hidden inside a closed one reads as no match.
  const isOpen = (id: string) => Boolean(search) || expanded.has(id);

  const bulkStatus = useMutation({
    mutationFn: (next: EndpointStatus) =>
      api<{ updated: number }>(`${base}/endpoints/bulk-status`, {
        method: "PATCH",
        body: { ids: [...selected], status: next },
      }),
    onSuccess: async (result) => {
      toast.success(`${result.updated} ${result.updated === 1 ? "endpoint actualizado" : "endpoints actualizados"}`);
      setSelected(new Set());
      await onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      ids.length === 1
        ? api<void>(`${base}/endpoints/${ids[0]}`, { method: "DELETE" }).then(() => ({ deleted: 1 }))
        : api<{ deleted: number }>(`${base}/endpoints/bulk-delete`, { method: "POST", body: { ids } }),
    onSuccess: async (result, ids) => {
      toast.success(`${result.deleted} ${result.deleted === 1 ? "endpoint eliminado" : "endpoints eliminados"}`);
      setConfirming(null);
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
      onRemoved(ids);
      await onChanged();
    },
    onError: (error: Error) => {
      setConfirming(null);
      toast.error(error.message);
    },
  });

  const archiveOne = useMutation({
    mutationFn: (endpoint: EndpointView) =>
      api<{ updated: number }>(`${base}/endpoints/bulk-status`, {
        method: "PATCH",
        body: { ids: [endpoint.id], status: endpoint.status === "active" ? "archived" : "active" },
      }),
    onSuccess: async (_result, endpoint) => {
      toast.success(endpoint.status === "active" ? "Endpoint archivado" : "Endpoint activado");
      await onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const counts = page?.counts;
  const total = counts ? counts.active + counts.archived + counts.inactive : 0;

  function renderFolder(folder: EndpointFolder<EndpointView>, depth: number) {
    const ids = endpointIdsOf(folder);
    const open = isOpen(folder.id);
    return (
      <div key={folder.id}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() =>
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(folder.id)) next.delete(folder.id);
              else next.add(folder.id);
              return next;
            })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              (event.currentTarget as HTMLElement).click();
            }
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-xs text-slate-700 hover:bg-slate-50"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <GroupCheckbox
            state={selectionState(ids, selected)}
            label={`Seleccionar ${folder.label}`}
            onToggle={() => setSelected((current) => toggleGroup(ids, current))}
          />
          <span className="w-3 text-[10px] text-slate-400">{open ? "▾" : "▸"}</span>
          <span className="truncate font-mono text-[11px] font-medium">{folder.label}</span>
          {folder.isVersion && (
            <span className="rounded bg-sky-50 px-1 text-[9px] font-semibold text-sky-700">versión</span>
          )}
          <span className="ml-auto text-[10px] text-slate-400">{ids.length}</span>
        </div>
        {open && (
          <div>
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.endpoints.map((endpoint) => renderRow(endpoint, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  function renderRow(endpoint: EndpointView, depth: number) {
    const active = endpoint.id === selectedId;
    return (
      <div
        key={endpoint.id}
        className={cn(
          "group flex items-center gap-1.5 rounded-md py-[3px] pr-1 text-xs",
          active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-50",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <input
          type="checkbox"
          className="size-3"
          aria-label={`Seleccionar ${endpoint.method} ${endpoint.path}`}
          checked={selected.has(endpoint.id)}
          onChange={() =>
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(endpoint.id)) next.delete(endpoint.id);
              else next.add(endpoint.id);
              return next;
            })
          }
        />
        <button
          onClick={() => onSelect(endpoint.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={endpoint.description || `${endpoint.method} ${endpoint.path}`}
        >
          <span
            className={cn(
              "w-12 shrink-0 rounded border py-px text-center font-mono text-[9px] font-bold",
              methodStyle(endpoint.method),
            )}
          >
            {endpoint.method}
          </span>
          <span
            className={cn(
              "truncate font-mono text-[11px]",
              endpoint.status === "inactive" && "line-through opacity-60",
            )}
          >
            {endpoint.path}
          </span>
          {endpoint.requiresAuth && (
            <span title="Pide autenticación" className={cn("text-[10px]", active ? "text-sky-200" : "text-sky-600")}>
              🔒
            </span>
          )}
          {endpoint.inContract === false && (
            <span
              title="El contrato activo no declara este endpoint"
              className={cn("text-[9px] font-semibold", active ? "text-amber-200" : "text-amber-600")}
            >
              fuera
            </span>
          )}
        </button>
        {(status === "all" || endpoint.status !== "active") && (
          <Badge className={cn("px-1 py-0 text-[9px]", STATUS_BADGE[endpoint.status].className)}>
            {STATUS_BADGE[endpoint.status].label}
          </Badge>
        )}
        {canEdit && (
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <IconButton
              title={endpoint.status === "active" ? "Archivar" : "Activar"}
              active={active}
              onClick={() => archiveOne.mutate(endpoint)}
              path={endpoint.status === "active" ? "M21 8v13H3V8M1 3h22v5H1zM10 12h4" : "M20 6L9 17l-5-5"}
            />
            <IconButton
              title="Eliminar"
              active={active}
              danger
              onClick={() => setConfirming({ ids: [endpoint.id], label: `${endpoint.method} ${endpoint.path}` })}
              path="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
            />
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5">
        {canEdit && (
          <>
            <Button className="h-7 px-2.5 text-xs" onClick={onNew}>
              + Nuevo
            </Button>
            <Button variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => setImporting((open) => !open)}>
              {importing ? "Ocultar" : "Importar"}
            </Button>
          </>
        )}
        <span className="ml-auto text-[11px] text-slate-500">{page ? `${page.meta.total} de ${total}` : ""}</span>
      </div>

      {importing && canEdit && <ImportPanel base={base} onImported={onChanged} onSelect={onSelect} />}

      <div className="mt-2 flex flex-wrap gap-1">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => onStatus(filter.value)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium",
              status === filter.value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            {filter.label}
            {counts && <span className="ml-1 opacity-60">{filter.value === "all" ? total : counts[filter.value]}</span>}
          </button>
        ))}
      </div>
      <input
        className={cn(inputClass, "mt-2 h-8 py-1 text-xs")}
        placeholder="Buscar por ruta o descripción…"
        aria-label="Buscar endpoints"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />

      {selected.size > 0 && canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
          <span className="font-medium text-slate-700">{selected.size} seleccionados</span>
          {(status === "active" || status === "all") && (
            <>
              <SmallButton onClick={() => bulkStatus.mutate("archived")} disabled={bulkStatus.isPending}>
                Archivar
              </SmallButton>
              <SmallButton onClick={() => bulkStatus.mutate("inactive")} disabled={bulkStatus.isPending}>
                Desactivar
              </SmallButton>
            </>
          )}
          {status !== "active" && (
            <SmallButton onClick={() => bulkStatus.mutate("active")} disabled={bulkStatus.isPending}>
              Activar
            </SmallButton>
          )}
          <SmallButton
            danger
            onClick={() => setConfirming({ ids: [...selected], label: `${selected.size} endpoints` })}
          >
            Eliminar
          </SmallButton>
          <button className="ml-auto text-slate-500 underline" onClick={() => setSelected(new Set())}>
            limpiar
          </button>
        </div>
      )}

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <p className="px-1 py-4 text-xs text-slate-500">Cargando…</p>
        ) : endpoints.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-xs font-medium text-slate-700">
              {search ? "Sin resultados" : "Todavía no hay endpoints"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              {search
                ? "Prueba con otra búsqueda."
                : status === "active"
                  ? "Crea uno, importa un fichero o un cURL, o importa el contrato en Settings."
                  : "Ninguno en este estado."}
            </p>
            {search && (
              <button
                className="mt-2 text-[11px] text-slate-700 underline"
                onClick={() => {
                  setTyped("");
                  onSearch("");
                }}
              >
                Limpiar búsqueda
              </button>
            )}
          </div>
        ) : (
          tree.map((folder) => renderFolder(folder, 0))
        )}
      </div>

      {page && page.meta.totalPages > 1 && (
        <div className="mt-2 flex items-center justify-center gap-1 border-t border-slate-100 pt-2 text-[11px]">
          <SmallButton disabled={pageNumber <= 1} onClick={() => onPage(pageNumber - 1)}>
            Anterior
          </SmallButton>
          {Array.from({ length: page.meta.totalPages }, (_, index) => index + 1)
            .filter((number) => Math.abs(number - pageNumber) <= 2)
            .map((number) => (
              <button
                key={number}
                onClick={() => onPage(number)}
                className={cn(
                  "min-w-6 rounded px-1.5 py-0.5",
                  number === pageNumber ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {number}
              </button>
            ))}
          <SmallButton disabled={pageNumber >= page.meta.totalPages} onClick={() => onPage(pageNumber + 1)}>
            Siguiente
          </SmallButton>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.ids.length === 1 ? "Eliminar endpoint" : "Eliminar endpoints"}
          message={`${confirming.label} dejará de aparecer para todo el mundo. Sus corridas pasadas se conservan.`}
          confirmLabel="Eliminar"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(confirming.ids)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function GroupCheckbox({
  state,
  label,
  onToggle,
}: {
  state: ReturnType<typeof selectionState>;
  label: string;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "partial";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="size-3.5"
      aria-label={label}
      checked={state === "all"}
      onClick={(event) => event.stopPropagation()}
      onChange={onToggle}
    />
  );
}

function SmallButton({
  children,
  danger,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...props}
      className={cn(
        "rounded border px-1.5 py-0.5 font-medium disabled:opacity-40",
        danger ? "border-rose-200 text-rose-700 hover:bg-rose-50" : "border-slate-200 text-slate-700 hover:bg-white",
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  title,
  path,
  onClick,
  active,
  danger,
}: {
  title: string;
  path: string;
  onClick: () => void;
  active: boolean;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid size-5 place-items-center rounded",
        active
          ? "text-slate-300 hover:text-white"
          : danger
            ? "text-slate-400 hover:text-rose-600"
            : "text-slate-400 hover:text-slate-800",
      )}
    >
      <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}

/** «Importar»: a file of any of the four formats, or one cURL. The result is listed, not toasted. */
function ImportPanel({
  base,
  onImported,
  onSelect,
}: {
  base: string;
  onImported: () => Promise<unknown>;
  onSelect: (id: string) => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [curl, setCurl] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const importFile = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("file", file!, file!.name);
      return api<EndpointImportResult>(`${base}/endpoints/import/file`, { method: "POST", body: form });
    },
    onSuccess: async () => {
      setFile(null);
      if (input.current) input.current.value = "";
      await onImported();
    },
  });

  const importCurl = useMutation({
    mutationFn: () => api<EndpointView>(`${base}/endpoints/import/curl`, { method: "POST", body: { curl } }),
    onSuccess: async (endpoint) => {
      setCurl("");
      toast.success(`${endpoint.method} ${endpoint.path} añadido`);
      await onImported();
      onSelect(endpoint.id);
    },
  });

  const result = importFile.data;
  const fileError = importFile.error instanceof ApiError ? importFile.error : null;

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
      <div>
        <p className="text-[11px] font-medium text-slate-700">Fichero</p>
        <p className="text-[10px] text-slate-500">
          OpenAPI (JSON o YAML), Postman v2.1, Insomnia v4 o markdown con curls.
        </p>
        <div className="mt-1 flex items-center gap-1">
          <input
            ref={input}
            type="file"
            aria-label="Fichero a importar"
            accept=".yaml,.yml,.json,.md,.markdown,.txt"
            className="min-w-0 flex-1 text-[11px] file:mr-2 file:rounded file:border file:border-slate-200 file:bg-white file:px-2 file:py-0.5 file:text-[11px]"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Button
            className="h-6 px-2 text-[11px]"
            disabled={!file || importFile.isPending}
            onClick={() => importFile.mutate()}
          >
            {importFile.isPending ? "…" : "Importar"}
          </Button>
        </div>
        {fileError && (
          <p className="mt-1 text-[11px] text-rose-600">
            {fileError.message}
            {fileError.fields[0] && `: ${fileError.fields[0].detail}`}
          </p>
        )}
        {result && (
          <div className="mt-1 rounded-md border border-slate-200 bg-white p-1.5 text-[11px]">
            <p className="font-medium text-slate-700">
              {result.imported.length} importados · {result.skipped.length} no · leído como {result.format}
            </p>
            {result.skipped.length > 0 && (
              <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">
                {result.skipped.map((entry, index) => (
                  <li key={index} className="text-slate-500">
                    <span className="font-mono">
                      {entry.method} {entry.path || entry.name}
                    </span>{" "}
                    — {entry.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div>
        <p className="text-[11px] font-medium text-slate-700">cURL</p>
        <div className="mt-1 flex items-start gap-1">
          <textarea
            aria-label="Comando cURL"
            className="h-14 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] outline-none focus:border-slate-900"
            placeholder="curl -X POST https://api.example.com/orders -d '{…}'"
            value={curl}
            spellCheck={false}
            onChange={(event) => setCurl(event.target.value)}
          />
          <Button
            className="h-6 px-2 text-[11px]"
            disabled={!curl.trim() || importCurl.isPending}
            onClick={() => importCurl.mutate()}
          >
            {importCurl.isPending ? "…" : "Añadir"}
          </Button>
        </div>
        {importCurl.error && <p className="mt-1 text-[11px] text-rose-600">{importCurl.error.message}</p>}
      </div>
    </div>
  );
}
