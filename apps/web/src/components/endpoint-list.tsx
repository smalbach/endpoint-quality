/**
 * The left half of Endpoints: the tree, its filters and the bulk bar.
 *
 * «Importar» aquí abría un panel propio que leía un fichero y sólo escribía endpoints: soltarle
 * una colección de Postman daba sus URL y ningún flujo, y nada lo decía. Ahora es el mismo
 * «Importar» de la cabecera, que reconoce lo que le das y lo reparte por sus destinos.
 *
 * What differs from the analyzer, on purpose: the status buttons carry their counts, and a single
 * endpoint can be archived from its row, not only in bulk.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { Badge, Button, inputClass } from "@/components/ui";
import { DeleteDialog } from "@/components/lifecycle";
import { useToast } from "@/components/toast";
import { useImport } from "@/components/import-provider";
import { cn, methodStyle } from "@/lib/format";
import {
  buildEndpointTree,
  endpointIdsOf,
  selectionState,
  toggleGroup,
  type EndpointFolder,
} from "@/lib/endpoint-tree";
import type { EndpointPage, EndpointStatus, EndpointView } from "@/lib/types";

/**
 * Lo que el control segmentado ofrece.
 *
 * `deleted` no es un `status` del endpoint —esos son activo, archivado e inactivo— sino la otra
 * lista: la papelera. Está aquí porque quien busca una ruta que falta no sabe si la archivó o la
 * borró, y son dos clics en el mismo control.
 */
export type StatusFilter = EndpointStatus | "all" | "deleted";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Activos" },
  { value: "archived", label: "Archivados" },
  { value: "inactive", label: "Inactivos" },
  { value: "all", label: "Todos" },
  { value: "deleted", label: "Eliminados" },
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
  const { open: openImport } = useImport();
  const [typed, setTyped] = useState(search);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{ ids: string[]; label: string; purge: boolean } | null>(null);

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
    mutationFn: ({ ids, purge }: { ids: string[]; purge: boolean }) =>
      // El definitivo es de uno en uno por ahora, que es como se pide desde la papelera: el lote
      // borra en blando, y «para siempre» se pulsa fila a fila a propósito.
      ids.length === 1
        ? api<void>(`${base}/endpoints/${ids[0]}${purge ? "?purge=true" : ""}`, { method: "DELETE" }).then(() => ({
            deleted: 1,
          }))
        : api<{ deleted: number }>(`${base}/endpoints/bulk-delete`, { method: "POST", body: { ids } }),
    onSuccess: async (result, { ids }) => {
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

  const restore = useMutation({
    mutationFn: (ids: string[]) =>
      ids.length === 1
        ? api<void>(`${base}/endpoints/${ids[0]}/restore`, { method: "POST" }).then(() => ({ restored: 1 }))
        : api<{ restored: number }>(`${base}/endpoints/bulk-restore`, { method: "POST", body: { ids } }),
    onSuccess: async (result) => {
      toast.success(`${result.restored} ${result.restored === 1 ? "endpoint restaurado" : "endpoints restaurados"}`);
      setSelected(new Set());
      await onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
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
  /** Cuántos hay en la papelera. Sin página cargada todavía, ninguno: nadie ha contado aún. */
  const deletedCount = page?.deleted ?? 0;

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
            {/* En la papelera la fila ofrece lo que se puede hacer ahí: volver, o irse del todo.
                Archivar no: eso se decide sobre algo que está en la lista. */}
            {status === "deleted" ? (
              <>
                <IconButton
                  title="Restaurar"
                  active={active}
                  onClick={() => restore.mutate([endpoint.id])}
                  path="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"
                />
                <IconButton
                  title="Eliminar para siempre"
                  active={active}
                  danger
                  onClick={() =>
                    setConfirming({
                      ids: [endpoint.id],
                      label: `${endpoint.method} ${endpoint.path}`,
                      purge: true,
                    })
                  }
                  path="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"
                />
              </>
            ) : (
              <>
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
                  onClick={() =>
                    setConfirming({
                      ids: [endpoint.id],
                      label: `${endpoint.method} ${endpoint.path}`,
                      purge: false,
                    })
                  }
                  path="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
                />
              </>
            )}
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
            <Button variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => openImport()}>
              Importar
            </Button>
          </>
        )}
        <span className="ml-auto text-[11px] text-slate-500">{page ? `${page.meta.total} de ${total}` : ""}</span>
      </div>

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
            {counts && (
              <span className="ml-1 opacity-60">
                {filter.value === "all" ? total : filter.value === "deleted" ? deletedCount : counts[filter.value]}
              </span>
            )}
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
          {status === "deleted" && (
            <SmallButton onClick={() => restore.mutate([...selected])} disabled={restore.isPending}>
              Restaurar
            </SmallButton>
          )}
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
          {status !== "active" && status !== "deleted" && (
            <SmallButton onClick={() => bulkStatus.mutate("active")} disabled={bulkStatus.isPending}>
              Activar
            </SmallButton>
          )}
          {status !== "deleted" && (
            <SmallButton
              danger
              onClick={() => setConfirming({ ids: [...selected], label: `${selected.size} endpoints`, purge: false })}
            >
              Eliminar
            </SmallButton>
          )}
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
        <DeleteDialog
          title={confirming.ids.length === 1 ? "Eliminar endpoint" : "Eliminar endpoints"}
          purge={confirming.purge}
          message={
            confirming.purge
              ? `${confirming.label} se va con sus ejemplos guardados. Sus corridas pasadas se conservan.`
              : `${confirming.label} dejará de aparecer para todo el mundo. Sus ejemplos y sus corridas pasadas se conservan.`
          }
          pending={remove.isPending}
          // Archivar un endpoint es su `status`, y vive en el icono de al lado: el diálogo no
          // duplica esa puerta, solo dice dónde está lo que se borra.
          onConfirm={() => remove.mutate({ ids: confirming.ids, purge: confirming.purge })}
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
