/**
 * Endpoints: the list on the left, the editor on the right, the split between them draggable.
 *
 * The open endpoint is in the URL (`?e=`), so a reload or a shared link lands on it. Leaving an
 * endpoint with unsaved changes asks first — the analyzer discarded them silently.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { ConfirmDialog } from "@/components/overlay";
import { EndpointEditor } from "@/components/endpoint-editor";
import { EndpointList, type StatusFilter } from "@/components/endpoint-list";
import { EndpointsTabs } from "@/components/endpoints-tabs";
import type { EndpointPage } from "@/lib/types";

const WIDTH_KEY = "eq.endpoints-split-width";
export const SPLIT = { min: 280, max: 700, initial: 420 };

export function clampWidth(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= SPLIT.min && number <= SPLIT.max ? number : SPLIT.initial;
}

const NEW = "new";

export function EndpointsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const [status, setStatus] = useState<StatusFilter>("active");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const selected = params.get("e");

  const list = useQuery({
    queryKey: ["endpoints", projectId, status, search, page],
    enabled: Boolean(organization && projectId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      api<EndpointPage>(
        // `deleted` es otra lista, no otro estado: la papelera la contesta el servidor aparte, y
        // ahí el filtro de estado no se manda porque lo que se quiere ver es todo lo borrado.
        `${base}/endpoints?${status === "deleted" ? "state=deleted" : `status=${status}`}&page=${page}&limit=100${
          search ? `&search=${encodeURIComponent(search)}` : ""
        }`,
      ),
  });

  const dirty = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const open = useCallback(
    (id: string | null) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("e", id);
        else next.delete("e");
        return next;
      });
    },
    [setParams],
  );
  const request = (id: string | null) => {
    if (id === selected) return;
    if (dirty.current) setPending(id ?? "");
    else open(id);
  };

  const [width, setWidth] = useState(() => {
    try {
      return clampWidth(window.localStorage.getItem(WIDTH_KEY));
    } catch {
      return SPLIT.initial;
    }
  });
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(
        Math.min(SPLIT.max, Math.max(SPLIT.min, dragging.current.startWidth + event.clientX - dragging.current.startX)),
      );
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth((current) => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(current));
        } catch {
          // Storage denied: the width lasts this tab.
        }
        return current;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  if (!projectId) return null;

  return (
    <div>
      <EndpointsTabs projectId={projectId} />
      <div className="flex h-[calc(100dvh-12rem)] min-h-[28rem]">
        <div
          style={{ width }}
          className="shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
        >
          <EndpointList
            base={base}
            page={list.data}
            loading={list.isLoading}
            status={status}
            onStatus={(next) => {
              setStatus(next);
              setPage(1);
            }}
            search={search}
            onSearch={(next) => {
              setSearch(next);
              setPage(1);
            }}
            pageNumber={page}
            onPage={setPage}
            selectedId={selected}
            onSelect={request}
            onNew={() => request(NEW)}
            canEdit={canEdit}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ["endpoints", projectId] })}
            onRemoved={(ids) => {
              if (selected && ids.includes(selected)) {
                dirty.current = false;
                open(null);
              }
            }}
          />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar"
          className="group grid w-3 shrink-0 cursor-col-resize place-items-center"
          onMouseDown={(event) => {
            dragging.current = { startX: event.clientX, startWidth: width };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onDoubleClick={() => setWidth(SPLIT.initial)}
        >
          <span className="h-10 w-0.5 rounded-full bg-slate-200 transition-all group-hover:h-16 group-hover:bg-slate-500" />
        </div>

        <div className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {selected ? (
            <EndpointEditor
              key={selected}
              base={base}
              projectId={projectId}
              endpointId={selected === NEW ? null : selected}
              layout="inline"
              canEdit={canEdit}
              onDirtyChange={(value) => {
                dirty.current = value;
              }}
              onSaved={(endpoint, created) => {
                dirty.current = false;
                if (created) open(endpoint.id);
              }}
              onOpenFull={() => navigate(`/p/${projectId}/endpoints/${selected}`)}
            />
          ) : (
            <div className="grid h-full place-items-center text-center">
              <div>
                <p className="text-sm font-medium text-slate-700">Elige un endpoint para verlo y probarlo</p>
                <p className="mt-1 text-xs text-slate-500">
                  O crea uno nuevo, importa un fichero o un cURL.
                  {list.data && !list.data.hasContract && " Importar el contrato en Settings también los crea."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {pending !== null && (
        <ConfirmDialog
          title="Cambios sin guardar"
          message="Si cambias de endpoint se pierde lo que no has guardado."
          confirmLabel="Descartar"
          onConfirm={() => {
            dirty.current = false;
            open(pending || null);
            setPending(null);
          }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

/** One endpoint on the whole page: request and response side by side. */
export function EndpointEditorPage() {
  const { projectId, endpointId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  if (!projectId) return null;
  const id = endpointId && endpointId !== NEW ? endpointId : null;

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[32rem] flex-col">
      <Link
        to={`/p/${projectId}${id ? `?e=${id}` : ""}`}
        className="mb-3 inline-flex w-fit items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
      >
        ← Endpoints
      </Link>
      <div className="min-h-0 flex-1 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <EndpointEditor
          key={endpointId}
          base={`/orgs/${organization?.id}/projects/${projectId}`}
          projectId={projectId}
          endpointId={id}
          layout="full"
          canEdit={canEdit}
          onSaved={(endpoint, created) => {
            if (created) void navigate(`/p/${projectId}/endpoints/${endpoint.id}`, { replace: true });
          }}
        />
      </div>
    </div>
  );
}
