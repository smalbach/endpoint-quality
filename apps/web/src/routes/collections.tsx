/**
 * Colecciones: la lista, el editor y el informe de una corrida.
 *
 * Es la pantalla que le faltaba a este producto. Una colección de Postman entraba partida en
 * flujos —un grafo por carpeta, las aristas deducidas del orden— y a partir de ahí dejaba de ser
 * la colección de nadie: no se editaba como allí, no se corría de arriba abajo como allí, y no
 * volvía a salir. Aquí el árbol es el árbol, el editor tiene las pestañas de Postman y el Runner
 * corre la colección entera o una carpeta, con sus vueltas y su espera entre peticiones.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, streamRun } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { variablesOf } from "@/lib/endpoint-draft";
import { useImport } from "@/components/import-provider";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { ConfirmDialog, Modal, PromptDialog } from "@/components/overlay";
import { CollectionTree, type TreeAction } from "@/components/collection-tree";
import {
  CollectionFolderEditor,
  CollectionRequestEditor,
  CollectionVariablesEditor,
  Scripts,
} from "@/components/collection-item-editor";
import { AuthEditor } from "@/components/auth-editor";
import { CollectionResultDetail } from "@/components/collection-run-result";
import { cn, formatBytes, formatDate, formatDuration } from "@/lib/format";
import {
  RUN_STATUS_CLASS,
  RUN_STATUS_LABEL,
  duplicateItem,
  failureReason,
  findItem,
  insertItem,
  METHOD_CLASS,
  moveWithin,
  newFolder,
  newRequest,
  replaceItem,
  resultFailed,
  runDuration,
  sameJson,
  statusClass,
} from "@/lib/collections";
import type {
  CollectionItemView,
  CollectionRun,
  CollectionRunResultView,
  CollectionRunView,
  CollectionSummary,
  CollectionView,
  Environment,
  SentRequestView,
} from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;

export function CollectionsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { open: openImport } = useImport();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId);
  const [creating, setCreating] = useState(false);

  const collections = useQuery({
    queryKey: ["collections", projectId],
    enabled,
    queryFn: () => api<CollectionSummary[]>(`${base}/collections`),
  });

  const create = useMutation({
    mutationFn: (name: string) => api<{ id: string }>(`${base}/collections`, { method: "POST", body: { name } }),
    onSuccess: async ({ id }) => {
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
      void navigate(`/p/${projectId}/collections/${id}`);
    },
    onError: (error) => toast.error(message(error) ?? "No se pudo crear"),
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-slate-900">Colecciones</h1>
          <p className="text-sm text-slate-500">
            Las colecciones de Postman, tal cual: carpetas, peticiones y tests, editables y ejecutables aquí.
          </p>
        </div>
        <Button variant="ghost" type="button" onClick={() => openImport()}>
          Importar colección
        </Button>
        {canEdit && (
          <Button type="button" onClick={() => setCreating(true)}>
            Nueva colección
          </Button>
        )}
      </header>

      {collections.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
      {collections.data?.length === 0 && (
        <Empty
          title="Todavía no hay ninguna colección"
          hint="Importa la que ya tienes en Postman: entra con sus carpetas, sus scripts y su orden."
          action={
            <Button type="button" onClick={() => openImport()}>
              Importar colección
            </Button>
          }
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {collections.data?.map((collection) => (
          <Card key={collection.id} className="space-y-2 p-3">
            <Link
              to={`/p/${projectId}/collections/${collection.id}`}
              className="block font-medium text-slate-900 hover:text-sky-700"
            >
              {collection.name}
            </Link>
            {collection.description && (
              <p className="line-clamp-2 text-xs text-slate-500">{collection.description}</p>
            )}
            <p className="text-xs text-slate-500">
              {collection.requests} peticiones
              {collection.folders ? ` · ${collection.folders} carpetas` : ""}
            </p>
            <div className="flex items-center gap-2">
              {collection.lastRun ? (
                <Link to={`/p/${projectId}/collections/runs/${collection.lastRun.id}`}>
                  <Badge className={RUN_STATUS_CLASS[collection.lastRun.status]}>
                    {RUN_STATUS_LABEL[collection.lastRun.status]}
                    {collection.lastRun.failed ? ` · ${collection.lastRun.failed} rojas` : ""}
                  </Badge>
                </Link>
              ) : (
                <span className="text-xs text-slate-400">Sin corridas</span>
              )}
              <span className="ml-auto text-[11px] text-slate-400">{formatDate(collection.updatedAt)}</span>
            </div>
          </Card>
        ))}
      </div>

      {creating && (
        <PromptDialog
          title="Nueva colección"
          label="Nombre"
          placeholder="API del catálogo"
          pending={create.isPending}
          onSubmit={(name) => create.mutate(name)}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/** El editor: el árbol a la izquierda y lo que se esté mirando a la derecha. */
export function CollectionPage() {
  const { projectId, collectionId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId && collectionId);

  const collection = useQuery({
    queryKey: ["collection", collectionId],
    enabled,
    queryFn: () => api<CollectionView>(`${base}/collections/${collectionId}`),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled,
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const [storedEnvironment] = useActiveEnvironment(projectId);
  const environment = resolveActive(storedEnvironment, environments.data ?? []);
  const variableNames = useMemo(() => Object.keys(variablesOf(environment)).sort(), [environment]);

  const [draft, setDraft] = useState<CollectionView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState<{ folderId: string | null } | null>(null);
  const [removing, setRemoving] = useState<CollectionItemView | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current || !collection.data) return;
    loaded.current = true;
    setDraft(collection.data);
  }, [collection.data]);

  const dirty = Boolean(draft && collection.data && !sameJson(draft, collection.data));
  const selected = draft && selectedId ? findItem(draft.items, selectedId) : null;

  const save = useMutation({
    mutationFn: () =>
      api<void>(`${base}/collections/${collectionId}`, {
        method: "PUT",
        body: {
          name: draft?.name,
          description: draft?.description,
          document: {
            auth: draft?.auth,
            variables: draft?.variables,
            preRequestScript: draft?.preRequestScript,
            postResponseScript: draft?.postResponseScript,
            items: draft?.items,
          },
        },
      }),
    onSuccess: async () => {
      loaded.current = false;
      await queryClient.invalidateQueries({ queryKey: ["collection", collectionId] });
      await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
      toast.success("Colección guardada");
    },
    onError: (error) => toast.error(message(error) ?? "No se pudo guardar"),
  });

  const send = useMutation({
    mutationFn: () => {
      // El servidor compone los scripts de encima y resuelve de quién hereda: enviar a mano y
      // correr la colección tienen que significar lo mismo.
      // El botón vive dentro del editor de una petición: cuando se puede pulsar, hay una abierta.
      const item = selected!.item;
      return api<SentRequestView>(`${base}/collections/${collectionId}/send`, {
        method: "POST",
        body: {
          environmentId: environment?.id ?? null,
          itemId: item.id,
          request: item.request,
          preRequestScript: item.preRequestScript,
          postResponseScript: item.postResponseScript,
        },
      });
    },
  });

  const exportFile = useMutation({
    mutationFn: () =>
      api<{ name: string; file: unknown; redacted: string[] }>(`${base}/collections/${collectionId}/export`),
    onSuccess: (result) => {
      const blob = new Blob([JSON.stringify(result.file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${result.name}.postman_collection.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      if (result.redacted.length)
        toast.info(`Credenciales que salen vacías: ${result.redacted.join("; ")}`);
    },
    onError: (error) => toast.error(message(error) ?? "No se pudo exportar"),
  });

  const removeCollection = useMutation({
    mutationFn: () => api<void>(`${base}/collections/${collectionId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
      void navigate(`/p/${projectId}/collections`);
    },
  });

  if (!draft) return <p className="text-sm text-slate-500">Cargando…</p>;

  const apply = (items: CollectionItemView[]) => setDraft({ ...draft, items });

  const onAction = (action: TreeAction) => {
    switch (action.kind) {
      case "select":
        setSelectedId(action.id);
        return;
      case "add-request": {
        const item = newRequest("Nueva petición");
        apply(insertItem(draft.items, action.parentId, item));
        setSelectedId(item.id);
        return;
      }
      case "add-folder": {
        const item = newFolder("Nueva carpeta");
        apply(insertItem(draft.items, action.parentId, item));
        setSelectedId(item.id);
        return;
      }
      // Los dos vienen del árbol, que solo ofrece ids que están en él: buscar no puede fallar.
      case "duplicate": {
        const found = findItem(draft.items, action.id)!;
        const copy = duplicateItem(found.item);
        apply(insertItem(draft.items, found.trail.at(-1)?.id ?? null, copy));
        setSelectedId(copy.id);
        return;
      }
      case "delete":
        setRemoving(findItem(draft.items, action.id)!.item);
        return;
      case "move":
        apply(moveWithin(draft.items, action.id, action.direction));
        return;
      case "run-folder":
        setRunning({ folderId: action.id });
        return;
    }
  };

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Nombre de la colección"
          className={cn(inputClass, "max-w-sm text-base font-semibold")}
          value={draft.name}
          disabled={!canEdit}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <Link to={`/p/${projectId}/collections`} className="text-xs text-sky-700 underline">
          Todas las colecciones
        </Link>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700">Sin guardar</span>}
          <Button variant="ghost" type="button" onClick={() => exportFile.mutate()}>
            Exportar
          </Button>
          <Button type="button" onClick={() => setRunning({ folderId: null })}>
            Correr
          </Button>
          {canEdit && (
            <Button type="button" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar"}
            </Button>
          )}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 gap-3">
        <Card className="flex w-72 shrink-0 flex-col gap-2 p-2">
          <input
            aria-label="Buscar en la colección"
            className={cn(inputClass, "text-xs")}
            placeholder="Buscar…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex gap-1">
            <button
              type="button"
              className={cn(
                "flex-1 rounded px-2 py-1 text-left text-xs",
                selectedId === null ? "bg-sky-50 text-sky-900" : "text-slate-600 hover:bg-slate-100",
              )}
              onClick={() => setSelectedId(null)}
            >
              La colección
            </button>
            {canEdit && (
              <>
                <button
                  type="button"
                  aria-label="Nueva petición"
                  className="rounded px-2 text-xs hover:bg-slate-200"
                  onClick={() => onAction({ kind: "add-request", parentId: null })}
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Nueva carpeta"
                  className="rounded px-2 text-xs hover:bg-slate-200"
                  onClick={() => onAction({ kind: "add-folder", parentId: null })}
                >
                  ⊞
                </button>
              </>
            )}
          </div>
          <CollectionTree
            items={draft.items}
            selectedId={selectedId}
            search={search}
            canEdit={canEdit}
            onAction={onAction}
          />
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col p-3">
          {selected?.item.kind === "request" && (
            <CollectionRequestEditor
              item={selected.item}
              variables={variableNames}
              canEdit={canEdit}
              onChange={(item) => apply(replaceItem(draft.items, item.id, () => item))}
              onSend={() => send.mutate()}
              send={send}
            />
          )}
          {selected?.item.kind === "folder" && (
            <CollectionFolderEditor
              item={selected.item}
              variables={variableNames}
              canEdit={canEdit}
              onChange={(item) => apply(replaceItem(draft.items, item.id, () => item))}
            />
          )}
          {!selected && (
            <CollectionSettings
              draft={draft}
              variables={variableNames}
              canEdit={canEdit}
              onChange={setDraft}
              onDelete={() => removeCollection.mutate()}
            />
          )}
        </Card>
      </div>

      {running && (
        <RunDialog
          base={base}
          collectionId={collectionId!}
          projectId={projectId!}
          folderId={running.folderId}
          // Si hay carpeta, salió del árbol: buscarla no puede fallar.
          folderName={running.folderId ? findItem(draft.items, running.folderId)!.item.name : null}
          environments={environments.data ?? []}
          activeEnvironmentId={environment?.id ?? null}
          dirty={dirty}
          onClose={() => setRunning(null)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Eliminar ${removing.name}`}
          message={
            removing.kind === "folder"
              ? "Se va la carpeta y todo lo que tiene dentro. Todavía puedes salir sin guardar."
              : "Se va la petición. Todavía puedes salir sin guardar."
          }
          onConfirm={() => {
            apply(replaceItem(draft.items, removing.id, () => null));
            if (selectedId === removing.id) setSelectedId(null);
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

/** La colección misma: su descripción, sus variables, de qué se autentica y sus scripts. */
function CollectionSettings({
  draft,
  variables,
  canEdit,
  onChange,
  onDelete,
}: {
  draft: CollectionView;
  variables: string[];
  canEdit: boolean;
  onChange: (draft: CollectionView) => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-4 overflow-y-auto">
      <Field label="Descripción">
        <textarea
          className={cn(inputClass, "h-24")}
          value={draft.description}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </Field>
      <CollectionVariablesEditor
        variables={draft.variables}
        disabled={!canEdit}
        onChange={(next) => onChange({ ...draft, variables: next })}
      />
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Autenticación de la colección</h3>
        <AuthEditor
          auth={draft.auth}
          variables={variables}
          disabled={!canEdit}
          inheritHint="Hereda la del proyecto, que es la que ya usa el resto del producto."
          onChange={(auth) => onChange({ ...draft, auth })}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Scripts de la colección</h3>
        <Scripts
          item={draft}
          disabled={!canEdit}
          onChange={(patch) => onChange({ ...draft, ...patch })}
          hint="Corren antes y después de cada petición de la colección."
        />
      </div>
      {canEdit && (
        <div className="border-t border-slate-200 pt-3">
          <Button variant="danger" type="button" onClick={() => setConfirming(true)}>
            Eliminar la colección
          </Button>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={`Eliminar ${draft.name}`}
          message="Se va la colección entera. Sus corridas se quedan en el historial."
          onConfirm={onDelete}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** El Runner: contra qué entorno, cuántas vueltas y cuánto espera entre peticiones. */
function RunDialog({
  base,
  projectId,
  collectionId,
  folderId,
  folderName,
  environments,
  activeEnvironmentId,
  dirty,
  onClose,
}: {
  base: string;
  projectId: string;
  collectionId: string;
  folderId: string | null;
  folderName: string | null;
  environments: Environment[];
  activeEnvironmentId: string | null;
  dirty: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [environmentId, setEnvironmentId] = useState(activeEnvironmentId ?? "");
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [stopOnFailure, setStopOnFailure] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`${base}/collections/${collectionId}/runs`, {
        method: "POST",
        body: { environmentId: environmentId || null, iterations, delayMs, stopOnFailure, folderId },
      }),
    onSuccess: ({ runId }) => navigate(`/p/${projectId}/collections/runs/${runId}`),
    onError: (error) => toast.error(message(error) ?? "No se pudo lanzar"),
  });

  return (
    <Modal
      title={folderName ? `Correr ${folderName}` : "Correr la colección"}
      description="Las peticiones salen en el orden del árbol, y las variables que escriben viajan a la siguiente."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? "Lanzando…" : "Correr"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {dirty && (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
            Tienes cambios sin guardar: la corrida usa lo guardado, no lo que hay en pantalla.
          </p>
        )}
        <Field label="Entorno">
          <select className={inputClass} value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
            <option value="">Sin entorno (la URL base del proyecto)</option>
            {environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vueltas">
            <input
              type="number"
              min={1}
              max={50}
              className={inputClass}
              value={iterations}
              onChange={(event) => setIterations(Number(event.target.value))}
            />
          </Field>
          <Field label="Espera entre peticiones (ms)">
            <input
              type="number"
              min={0}
              max={60000}
              className={inputClass}
              value={delayMs}
              onChange={(event) => setDelayMs(Number(event.target.value))}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={stopOnFailure} onChange={(event) => setStopOnFailure(event.target.checked)} />
          Parar en la primera roja
        </label>
      </div>
    </Modal>
  );
}

/**
 * El informe de una corrida, en vivo.
 *
 * Llega por SSE una petición cada vez que termina —no la corrida entera— así que la lista crece
 * fila a fila sin volver a bajarse las ochenta anteriores en cada paso.
 */
export function CollectionRunPage() {
  const { projectId, runId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId && runId);
  const [live, setLive] = useState<CollectionRunView | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** Cuántas van de cuántas: solo el stream lo sabe, porque el plan se resuelve al correr. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [only, setOnly] = useState<"all" | "failed" | "passed">("all");
  const [search, setSearch] = useState("");

  const run = useQuery({
    queryKey: ["collection-run", runId],
    enabled,
    queryFn: () => api<CollectionRunView>(`${base}/collections/runs/${runId}`),
  });

  useEffect(() => {
    if (!run.data || run.data.status !== "running") return;
    const controller = new AbortController();
    void streamRun(`${base}/collections/runs/${runId}/stream`, {
      signal: controller.signal,
      onEvent: (event) => {
        const data = event.data as {
          status: CollectionRun["status"];
          totals: CollectionRunView["totals"];
          result?: CollectionRunView["results"][number];
          progress?: { done: number; total: number };
        };
        if (data.progress) setProgress(data.progress);
        setLive((current) => {
          const previous = current ?? run.data;
          return {
            ...previous,
            status: data.status,
            totals: data.totals ?? previous.totals,
            results: data.result ? [...previous.results, data.result] : previous.results,
          };
        });
        if (event.type === "finished") void queryClient.invalidateQueries({ queryKey: ["collection-run", runId] });
      },
    }).catch(() => {
      // El stream se cae con la pestaña o con la red; el fetch de arriba ya trae lo persistido.
    });
    return () => controller.abort();
  }, [run.data?.status, base, runId]);

  const cancel = useMutation({
    mutationFn: () => api<void>(`${base}/collections/runs/${runId}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["collection-run", runId] }),
  });

  const view = live ?? run.data;
  if (!view) return <p className="text-sm text-slate-500">Cargando…</p>;

  const failedCount = view.results.filter(resultFailed).length;
  const needle = search.trim().toLowerCase();
  // Con su posición en la corrida: la clave de «abierta» tiene que sobrevivir a cambiar el filtro,
  // y la posición dentro de lo filtrado no es la misma fila de un filtro al siguiente.
  const shown = view.results
    .map((result, index) => ({ result, key: keyOf(result, index) }))
    .filter(({ result }) => {
      const bad = resultFailed(result);
      if (only === "failed" && !bad) return false;
      if (only === "passed" && bad) return false;
      if (!needle) return true;
      return `${result.folder} ${result.name} ${result.sent?.url ?? result.url}`.toLowerCase().includes(needle);
    });
  const allOpen = shown.length > 0 && shown.every(({ key }) => open[key]);
  const elapsed = runDuration(view.startedAt, view.finishedAt);
  const bytes = view.results.reduce((total, result) => total + result.sizeBytes, 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-slate-900">
            {view.collectionName}
            {view.folderName ? ` · ${view.folderName}` : ""}
          </h1>
          <p className="text-sm text-slate-500">
            {formatDate(view.startedAt)} · {view.environmentName ?? "sin entorno"} ·{" "}
            {view.iterations === 1 ? "una vuelta" : `${view.iterations} vueltas`}
            {view.delayMs ? ` · ${view.delayMs} ms entre peticiones` : ""}
            {view.stopOnFailure ? " · para en la primera roja" : ""}
            {elapsed === null ? "" : ` · duró ${formatDuration(elapsed)}`}
          </p>
        </div>
        <Badge className={RUN_STATUS_CLASS[view.status]}>{RUN_STATUS_LABEL[view.status]}</Badge>
        {view.status === "running" && canEdit && (
          <Button variant="ghost" type="button" onClick={() => cancel.mutate()}>
            Cancelar
          </Button>
        )}
        <Link to={`/p/${projectId}/collections/${view.collectionId}`} className="text-xs text-sky-700 underline">
          Abrir la colección
        </Link>
      </header>

      {view.error && <p className="rounded bg-rose-50 p-2 text-sm text-rose-700">{view.error}</p>}

      <div className="flex flex-wrap gap-4 text-sm">
        <Metric label="Peticiones" value={view.totals.requests} />
        <Metric label="Rojas" value={view.totals.failed} tone={view.totals.failed ? "bad" : "good"} />
        <Metric label="Tests" value={view.totals.tests} />
        <Metric label="Pasaron" value={view.totals.testsPassed} tone="good" />
        <Metric label="Fallaron" value={view.totals.testsFailed} tone={view.totals.testsFailed ? "bad" : "good"} />
        <Metric label="Datos" text={formatBytes(bytes)} />
      </div>

      {view.status === "running" && progress && (
        <div>
          <p className="text-xs text-slate-500">
            {progress.done} de {progress.total} peticiones
          </p>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-200">
            <div
              className="h-full bg-sky-500 transition-[width]"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Un informe de ochenta peticiones no se lee entero: lo que se busca es «cuáles fallaron». */}
      {view.results.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 text-xs">
            {(
              [
                ["all", `Todas (${view.results.length})`],
                ["failed", `Rojas (${failedCount})`],
                ["passed", `Verdes (${view.results.length - failedCount})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={cn(
                  "rounded px-2 py-1",
                  only === id ? "bg-slate-200 font-medium text-slate-800" : "text-slate-500 hover:text-slate-700",
                )}
                onClick={() => setOnly(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className={cn(inputClass, "h-8 max-w-xs flex-1 text-xs")}
            placeholder="Buscar por nombre, carpeta o URL"
            aria-label="Buscar en la corrida"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="ml-auto text-xs text-slate-500 underline hover:text-slate-700"
            onClick={() =>
              setOpen(allOpen ? {} : Object.fromEntries(shown.map(({ key }) => [key, true])))
            }
          >
            {allOpen ? "Plegar todas" : "Desplegar todas"}
          </button>
        </div>
      )}

      <Card className="divide-y divide-slate-100">
        {shown.map(({ result, key }) => {
          const failed = result.tests.filter((test) => !test.passed).length;
          const bad = resultFailed(result);
          const reason = failureReason(result);
          return (
            <div key={key} className="px-3 py-2 text-sm">
              <button
                type="button"
                className="flex w-full items-center gap-2 text-left"
                onClick={() => setOpen((state) => ({ ...state, [key]: !state[key] }))}
              >
                <span className={cn("w-12 shrink-0 text-[10px] font-bold", METHOD_CLASS[result.method])}>
                  {result.method}
                </span>
                <span className="flex-1 truncate">
                  {result.folder && <span className="text-slate-400">{result.folder} / </span>}
                  {result.name}
                </span>
                {view.iterations > 1 && <span className="text-[11px] text-slate-400">#{result.iteration}</span>}
                <span className={cn("w-12 text-right font-medium", statusClass(result.status))}>
                  {result.status ?? "—"}
                </span>
                <span className="w-16 text-right text-xs text-slate-500">{formatDuration(result.durationMs)}</span>
                <span className="w-16 text-right text-xs text-slate-500">{formatBytes(result.sizeBytes)}</span>
                <span className={cn("w-20 text-right text-xs", bad ? "text-rose-600" : "text-emerald-600")}>
                  {result.tests.length ? `${result.tests.length - failed}/${result.tests.length}` : "sin tests"}
                </span>
              </button>
              {/* La URL que salió de verdad y el motivo, sin desplegar: es lo que se lee en diagonal. */}
              <p className="truncate pl-14 font-mono text-[11px] text-slate-400">{result.sent?.url || result.url}</p>
              {reason && !open[key] && <p className="truncate pl-14 text-[11px] text-rose-600">{reason}</p>}
              {open[key] && <CollectionResultDetail result={result} />}
            </div>
          );
        })}
        {!view.results.length && <p className="px-3 py-4 text-sm text-slate-500">Todavía no ha terminado ninguna.</p>}
        {Boolean(view.results.length) && !shown.length && (
          <p className="px-3 py-4 text-sm text-slate-500">Ninguna petición encaja con lo que buscas.</p>
        )}
      </Card>
    </div>
  );
}

/** La clave de una fila del informe: la misma petición puede salir varias veces, una por vuelta. */
const keyOf = (result: CollectionRunResultView, index: number): string =>
  `${result.iteration}-${result.itemId}-${index}`;

function Metric({
  label,
  value,
  text,
  tone,
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold",
          tone === "bad" ? "text-rose-600" : tone === "good" ? "text-emerald-600" : "text-slate-900",
        )}
      >
        {text ?? value}
      </p>
    </div>
  );
}
