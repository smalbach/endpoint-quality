/**
 * Reusable requests and the flows built from them.
 *
 * Two views of one document: the canvas and the JSON. Neither is the source of truth — the flow's
 * `definition` is, and both edit it. The graph is written whole on save, which is what makes «node
 * deleted, edge still pointing at it» a state that cannot be stored.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Drawer, PromptDialog } from "@/components/overlay";
import { RunProgress, useRunProgress } from "@/routes/runs";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Empty } from "@/components/ui";
import { cn } from "@/lib/format";
import { unchanged } from "@/lib/config-draft";
import {
  addStep,
  flowNodeStatuses,
  flowProblems,
  replaceStep,
  templateUsage,
  uniqueName,
  uniqueTemplateName,
  WORKFLOW_STATUS_META,
  type OperationSummary,
} from "@/lib/workflow-draft";
import { WorkflowCanvas } from "@/components/workflow-canvas";
import { WorkflowInspector } from "@/components/workflow-inspector";
import { TemplateLibrary, type NewTemplate } from "@/components/template-library";
import { ImportRequests } from "@/components/import-requests";
import { DatasetsPanel } from "@/components/datasets-panel";
import { SuitesPanel } from "@/components/suites-panel";
import type {
  DatasetRowsView,
  Environment,
  RequestTemplateView,
  RunView,
  SuiteView,
  WorkflowStatusView,
  WorkflowStepView,
  WorkflowView,
  WorkflowsView,
} from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;

/** The status a fresh request expects, guessed from the verb. A starting point the inspector can
 * change — most GETs answer 200, a POST 201, a DELETE 204. */
const DEFAULT_STATUS: Record<string, number> = { GET: 200, POST: 201, PUT: 200, PATCH: 200, DELETE: 204 };

export function WorkflowsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const [selectedId, setSelectedId] = useState("");
  const [selectedStep, setSelectedStep] = useState("");
  const [draft, setDraft] = useState<WorkflowView | null>(null);
  const [templateEdits, setTemplateEdits] = useState<Record<string, RequestTemplateView>>({});
  const [asJson, setAsJson] = useState(false);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [activeEnvironment, setActiveEnvironment] = useActiveEnvironment(projectId);
  const preselected = useRef(false);
  const [naming, setNaming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [datasetId, setDatasetId] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // The canvas is the screen now; everything else is pulled over it. `tab` swaps the whole area
  // between the editor and the run being analysed (in place, never a URL away); `drawer` is which
  // side panel is open, and `inspectorOpen` the node/settings panel — split out because a node
  // click opens it while the dock buttons open the others.
  const [tab, setTab] = useState<"editor" | "run">("editor");
  const [drawer, setDrawer] = useState<null | "flows" | "library" | "data">(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // The live run being watched, if any. The hook no-ops on an empty id, so it is safe to call
  // every render; when a run is active its cases colour the canvas nodes as they execute.
  const runProgress = useRunProgress(base, activeRunId ?? "");
  const stepStatus = useMemo(
    () => (activeRunId ? flowNodeStatuses(runProgress.cases) : {}),
    [activeRunId, runProgress.cases],
  );
  const [concurrency, setConcurrency] = useState(1);
  // A pause between steps, so the live timeline can be watched. It is the run's `delayMs`, which the
  // orchestrator already honours; it changes the rhythm, never what is tested.
  const [delayMs, setDelayMs] = useState(0);

  const enabled = Boolean(organization && projectId);
  const workflows = useQuery({
    queryKey: ["workflows", projectId],
    enabled,
    queryFn: () => api<WorkflowsView>(`${base}/workflows`),
  });
  const operations = useQuery({
    queryKey: ["operations", projectId],
    enabled,
    queryFn: () => api<{ operations: OperationSummary[] }>(`${base}/operations`),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled,
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });

  // Start from the project's active environment, once. After that the select is the person's.
  useEffect(() => {
    if (preselected.current || !environments.data) return;
    preselected.current = true;
    const active = resolveActive(activeEnvironment, environments.data);
    if (active) setEnvironmentId(active.id);
  }, [environments.data, activeEnvironment]);

  const allWorkflows = workflows.data?.workflows ?? [];
  const saved = allWorkflows.find((item) => item.id === selectedId);
  // Archived flows are hidden unless asked for — but the one open stays visible, so «archivar» does
  // not make the flow you are looking at vanish out from under you.
  const visibleWorkflows = allWorkflows.filter(
    (item) => showArchived || item.status !== "archived" || item.id === selectedId,
  );
  const archivedCount = allWorkflows.filter((item) => item.status === "archived").length;
  const templates = (workflows.data?.requestTemplates ?? []).map((template) => templateEdits[template.id] ?? template);
  const steps = draft?.steps ?? [];
  const problems = flowProblems(steps);

  // The draft follows the selection, and a refetch replaces it: the server's copy is the one that
  // went through validation, so keeping a local version on top of it would hide what it changed.
  useEffect(() => {
    const first = workflows.data?.workflows[0];
    if (!selectedId && first) setSelectedId(first.id);
  }, [workflows.data, selectedId]);
  useEffect(() => {
    if (!saved) return;
    setDraft(saved);
    setJson(JSON.stringify({ steps: saved.steps }, null, 2));
    setSelectedStep("");
    setTemplateEdits({});
  }, [saved?.id, saved?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });

  const createTemplate = useMutation({
    mutationFn: (template: NewTemplate) =>
      api<{ requestTemplateId: string }>(`${base}/request-templates`, { method: "POST", body: template }),
    onSuccess: invalidate,
  });
  const deleteTemplate = useMutation({
    mutationFn: (templateId: string) => api<void>(`${base}/request-templates/${templateId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const createWorkflow = useMutation({
    mutationFn: (name: string) => api<{ workflowId: string }>(`${base}/workflows`, { method: "POST", body: { name } }),
    onSuccess: async ({ workflowId }) => {
      await invalidate();
      setSelectedId(workflowId);
    },
  });
  const deleteWorkflow = useMutation({
    mutationFn: (workflowId: string) => api<void>(`${base}/workflows/${workflowId}`, { method: "DELETE" }),
    onSuccess: async () => {
      setSelectedId("");
      setDraft(null);
      await invalidate();
    },
  });
  const duplicateWorkflow = useMutation({
    mutationFn: (workflowId: string) =>
      api<{ workflowId: string }>(`${base}/workflows/${workflowId}/duplicate`, { method: "POST" }),
    onSuccess: async ({ workflowId }) => {
      await invalidate();
      setSelectedId(workflowId);
    },
  });
  // Rename and status are partial writes of the row, not the graph: they go straight to the server
  // rather than through the draft, so «archivar» is one click and does not wait on a valid diagram.
  const patchWorkflow = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; status?: WorkflowStatusView }) =>
      api<void>(`${base}/workflows/${id}`, { method: "PUT", body }),
    onSuccess: invalidate,
  });

  /**
   * One save: the requests that changed, then the graph.
   *
   * In that order, because a step may name a request created in the same sitting, and the server
   * refuses a flow whose step points at a request it cannot find.
   */
  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      for (const edited of Object.values(templateEdits)) {
        const original = workflows.data?.requestTemplates.find((item) => item.id === edited.id);
        if (original && unchanged(original, edited)) continue;
        await api<void>(`${base}/request-templates/${edited.id}`, {
          method: "PATCH",
          body: {
            name: edited.name,
            operationId: edited.operationId,
            expectedStatus: edited.expectedStatus,
            parameters: edited.parameters,
            // Listed field by field rather than spread, so a field the editor learns to change and
            // this list does not is a compile error and not an edit that silently does not save.
            disabledParameters: edited.disabledParameters,
            headers: edited.headers,
            disabledHeaders: edited.disabledHeaders,
            body: edited.body,
            auth: edited.auth,
          } satisfies Omit<RequestTemplateView, "id" | "description" | "updatedAt">,
        });
      }
      await api<void>(`${base}/workflows/${draft.id}`, {
        method: "PUT",
        body: { name: draft.name, description: draft.description, definition: { steps: draft.steps } },
      });
    },
    onSuccess: invalidate,
  });

  // Launching runs it here, in an overlay over the canvas, instead of navigating away: the flow
  // stays open behind it, and the run's live progress and final summary show without a trip to Runs.
  const run = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`${base}/runs`, {
        method: "POST",
        body: { environmentId, workflowId: draft?.id, concurrency, delayMs, ...(datasetId ? { datasetId } : {}) },
      }),
    onSuccess: ({ runId }) => setActiveRunId(runId),
  });

  const runSuite = useMutation({
    mutationFn: (suiteId: string) =>
      api<{ runId: string }>(`${base}/runs`, {
        method: "POST",
        body: { environmentId, suiteId, concurrency, delayMs },
      }),
    onSuccess: ({ runId }) => setActiveRunId(runId),
  });

  const createDataset = useMutation({
    mutationFn: (name: string) =>
      api<{ datasetId: string }>(`${base}/workflows/${draft?.id}/datasets`, {
        method: "POST",
        body: { name, rows: [] },
      }),
    onSuccess: invalidate,
  });
  const saveDataset = useMutation({
    mutationFn: ({ id, rows }: { id: string; rows: Record<string, string>[] }) =>
      api<void>(`${base}/datasets/${id}`, { method: "PUT", body: { rows } }),
    onSuccess: invalidate,
  });
  const deleteDataset = useMutation({
    mutationFn: (id: string) => api<void>(`${base}/datasets/${id}`, { method: "DELETE" }),
    onSuccess: async (_result, id) => {
      // A run cannot walk what is no longer there, and leaving it selected would fail at the
      // click rather than here.
      if (datasetId === id) setDatasetId("");
      await invalidate();
    },
  });

  const createSuite = useMutation({
    mutationFn: (name: string) => api<{ suiteId: string }>(`${base}/suites`, { method: "POST", body: { name } }),
    onSuccess: invalidate,
  });
  const saveSuite = useMutation({
    mutationFn: (suite: SuiteView) =>
      api<void>(`${base}/suites/${suite.id}`, { method: "PUT", body: { workflowIds: suite.workflowIds } }),
    onSuccess: invalidate,
  });
  const deleteSuite = useMutation({
    mutationFn: (suiteId: string) => api<void>(`${base}/suites/${suiteId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  // Ctrl/Cmd+S guarda, Ctrl/Cmd+Enter ejecuta. Por un ref actualizado en cada render, para que el
  // atajo vea el estado de ahora sin volver a suscribir el listener en cada tecla.
  const shortcut = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcut.current = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      const isDirty = Boolean(draft && saved && (!unchanged(saved, draft) || Object.keys(templateEdits).length > 0));
      if (canEdit && draft && isDirty && problems.length === 0 && !save.isPending) save.mutate();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (draft && environmentId && steps.length && !run.isPending) run.mutate();
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => shortcut.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function setSteps(next: WorkflowStepView[]) {
    setDraft((current) => (current ? { ...current, steps: next } : current));
    setJson(JSON.stringify({ steps: next }, null, 2));
  }

  /** How many nodes — here and in every other flow — point at one reusable request. */
  const usageOf = (templateId: string) =>
    templateUsage(steps, workflows.data?.workflows ?? [], draft?.id ?? "", templateId);

  /**
   * Give one node its own copy of a shared request, so editing it stops changing its twins.
   *
   * Copy-on-write: the request stays shared while a single node uses it (editing it in place is the
   * point of a reusable request), and forks the moment a second node would be dragged along by the
   * edit. `overrides` carry the edit that triggered the fork — changing the operation is the usual
   * one — so the new copy already has it and the originals keep what they had. Done through the same
   * POST the library uses, then the step is repointed and the stale local edit for the old id is
   * dropped so it never reaches the shared row on save.
   */
  const [forking, setForking] = useState(false);
  const [addingOp, setAddingOp] = useState(false);

  /** Add a node straight from an operation in the catalogue: mint a request for it (named after the
   * operation, with the status its verb usually answers), then drop it into the open flow. One tap,
   * where before it took the form and then a second click on the created row. */
  async function addOperation(operation: OperationSummary) {
    if (!draft) return;
    const expectedStatus = DEFAULT_STATUS[operation.method.toUpperCase()] ?? 200;
    const name = uniqueName(
      operation.summary?.trim() || `${operation.method} ${operation.path}`,
      (workflows.data?.requestTemplates ?? []).map((template) => template.name),
    );
    setAddingOp(true);
    try {
      const { requestTemplateId } = await api<{ requestTemplateId: string }>(`${base}/request-templates`, {
        method: "POST",
        body: { name, operationId: operation.id, expectedStatus, parameters: {}, body: { type: "none" } },
      });
      setSteps(addStep(steps, { id: requestTemplateId, name } as RequestTemplateView));
      await invalidate();
    } finally {
      setAddingOp(false);
    }
  }
  async function makeIndependent(step: WorkflowStepView, overrides?: Partial<RequestTemplateView>) {
    const current = templates.find((template) => template.id === step.requestTemplateId);
    if (!current || !draft) return;
    const merged = { ...current, ...overrides };
    setForking(true);
    try {
      const { requestTemplateId } = await api<{ requestTemplateId: string }>(`${base}/request-templates`, {
        method: "POST",
        body: {
          name: uniqueTemplateName(
            merged.name,
            (workflows.data?.requestTemplates ?? []).map((template) => template.name),
          ),
          operationId: merged.operationId,
          expectedStatus: merged.expectedStatus,
          parameters: merged.parameters,
          disabledParameters: merged.disabledParameters,
          headers: merged.headers,
          disabledHeaders: merged.disabledHeaders,
          body: merged.body,
          auth: merged.auth,
        },
      });
      const oldId = step.requestTemplateId;
      setSteps(replaceStep(steps, { ...step, requestTemplateId }));
      // Drop the pending edit for the shared row unless another node here still rides it — otherwise
      // save would PATCH the original with the edit that was meant only for this node.
      setTemplateEdits((edits) => {
        if (steps.some((other) => other.id !== step.id && other.requestTemplateId === oldId)) return edits;
        const next = { ...edits };
        delete next[oldId];
        return next;
      });
      await invalidate();
    } finally {
      setForking(false);
    }
  }

  /** The two views hold the same document, so switching carries the edits either way. */
  function switchView() {
    if (!asJson) {
      setJson(JSON.stringify({ steps }, null, 2));
      setJsonError(null);
      setAsJson(true);
      return;
    }
    try {
      const parsed = JSON.parse(json) as { steps?: WorkflowStepView[] };
      if (!Array.isArray(parsed.steps)) throw new Error("El documento es { steps: [...] }");
      setSteps(parsed.steps);
      setJsonError(null);
      setAsJson(false);
    } catch (caught) {
      setJsonError(caught instanceof Error ? caught.message : "JSON inválido");
    }
  }

  if (workflows.isLoading || operations.isLoading) return <p className="text-sm text-slate-500">Cargando flujos…</p>;

  const dirty = Boolean(draft && saved && (!unchanged(saved, draft) || Object.keys(templateEdits).length > 0));

  return (
    <div className="-mx-6 -my-6 flex h-[calc(100dvh-49px)] flex-col bg-slate-50">
      {/* La barra superior es lo único fijo: las dos pestañas a la izquierda, y a la derecha lo que
          se aplica a todo el flujo (entorno, JSON, guardar). Todo lo demás flota sobre el lienzo. */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-1">
          <TopTab active={tab === "editor"} onClick={() => setTab("editor")}>
            Lienzo
          </TopTab>
          <TopTab active={tab === "run"} disabled={!activeRunId} onClick={() => setTab("run")}>
            <span className="flex items-center gap-1.5">
              Ejecución
              {activeRunId && runProgress.running && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              )}
            </span>
          </TopTab>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {saved && <span className="hidden truncate text-xs font-medium text-slate-500 sm:block">{saved.name}</span>}
          <select
            className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600"
            value={environmentId}
            title="Entorno"
            onChange={(event) => {
              setEnvironmentId(event.target.value);
              if (event.target.value) setActiveEnvironment(event.target.value);
            }}
          >
            <option value="">Entorno…</option>
            {(environments.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={switchView} disabled={!draft}>
            {asJson ? "Diagrama" : "JSON"}
          </Button>
          {canEdit && (
            <Button
              className="h-8 px-3 text-xs"
              disabled={!dirty || save.isPending || problems.length > 0}
              onClick={() => save.mutate()}
            >
              Guardar
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {tab === "run" ? (
          <div className="h-full overflow-y-auto p-4">
            {activeRunId ? (
              <RunProgress base={base} runId={activeRunId} />
            ) : (
              <Empty title="Sin ejecuciones" hint="Ejecuta un flujo desde el lienzo para analizar aquí su resultado." />
            )}
          </div>
        ) : asJson ? (
          <div className="h-full overflow-y-auto p-4">
            <Card className="p-4">
              <textarea
                className="h-[70vh] w-full rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] text-slate-100"
                value={json}
                spellCheck={false}
                onChange={(event) => setJson(event.target.value)}
              />
              {jsonError && <p className="mt-2 text-xs text-rose-700">{jsonError}</p>}
            </Card>
          </div>
        ) : (
          <>
            {!draft ? (
              <div className="grid h-full place-items-center p-6">
                <Empty title="Crea tu primer flujo" hint="Abre «Flujos» y crea uno; luego añade pruebas desde la biblioteca." />
              </div>
            ) : (
              <WorkflowCanvas
                steps={steps}
                templates={templates}
                operations={operations.data?.operations ?? []}
                onChange={setSteps}
                onSelect={(stepId) => {
                  setSelectedStep(stepId);
                  setInspectorOpen(true);
                }}
                runStatus={stepStatus}
              />
            )}

            {/* Muelle flotante arriba a la izquierda: cada botón abre su drawer. */}
            <div className="pointer-events-none absolute top-3 left-3 z-30 flex flex-col gap-2">
              <div className="pointer-events-auto flex flex-col gap-1 rounded-2xl border border-slate-200 bg-white/95 p-1 shadow-lg backdrop-blur">
                <DockButton glyph="≣" label="Flujos" onClick={() => setDrawer(drawer === "flows" ? null : "flows")} />
                <DockButton
                  glyph="◈"
                  label="Biblioteca"
                  disabled={!draft}
                  onClick={() => setDrawer(drawer === "library" ? null : "library")}
                />
                <DockButton
                  glyph="▤"
                  label="Datos"
                  disabled={!draft}
                  onClick={() => setDrawer(drawer === "data" ? null : "data")}
                />
                <DockButton
                  glyph="⚙"
                  label="Ajustes"
                  disabled={!draft}
                  onClick={() => setInspectorOpen((open) => !open)}
                />
              </div>
            </div>

            {/* Play: la acción principal, separada y grande, abajo a la derecha. */}
            {draft && (
              <button
                onClick={() => run.mutate()}
                disabled={!environmentId || !steps.length || run.isPending}
                title={!environmentId ? "Elige un entorno arriba" : "Ejecutar flujo"}
                className={cn(
                  "absolute right-5 bottom-5 z-30 flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white shadow-xl transition",
                  !environmentId || !steps.length || run.isPending
                    ? "cursor-not-allowed bg-slate-300"
                    : "bg-emerald-600 hover:bg-emerald-500",
                )}
              >
                <span aria-hidden className="text-base">
                  ▶
                </span>
                {run.isPending ? "Lanzando…" : "Ejecutar"}
              </button>
            )}

            {/* Problemas del flujo: banner flotante compacto, no una columna. */}
            {problems.length > 0 && (
              <div className="absolute top-3 left-1/2 z-30 w-[min(560px,80vw)] -translate-x-1/2 rounded-xl border border-rose-200 bg-rose-50/95 px-3 py-2 shadow-lg backdrop-blur">
                <ul className="space-y-1 text-xs text-rose-700">
                  {problems.map((problem, index) => (
                    <li key={`${problem.message}-${index}`} className="flex items-center gap-2">
                      <span className="flex-1">{problem.message}</span>
                      {problem.stepId && (
                        <button
                          className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-200"
                          onClick={() => {
                            setSelectedStep(problem.stepId!);
                            setInspectorOpen(true);
                          }}
                        >
                          Ir al nodo
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(message(save.error) ??
              message(run.error) ??
              message(createTemplate.error) ??
              message(deleteTemplate.error)) && (
              <div className="absolute bottom-5 left-1/2 z-30 w-[min(560px,80vw)] -translate-x-1/2 rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs text-rose-700 shadow-lg">
                {message(save.error) ??
                  message(run.error) ??
                  message(createTemplate.error) ??
                  message(deleteTemplate.error)}
              </div>
            )}

            {activeRunId && (
              <RunStrip
                run={runProgress.run.data}
                onOpen={() => setTab("run")}
                onClose={() => setActiveRunId(null)}
              />
            )}

            {/* Drawer: Flujos (lista, estado, suites). */}
            {drawer === "flows" && (
              <Drawer title="Flujos" side="left" onClose={() => setDrawer(null)}>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Flujos</p>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={createWorkflow.isPending}
                      onClick={() => setNaming(true)}
                    >
                      + Nuevo
                    </Button>
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  {allWorkflows.length === 0 && <p className="text-[11px] text-slate-400">Ninguno todavía.</p>}
                  {visibleWorkflows.map((item) => {
                    const meta = WORKFLOW_STATUS_META[item.status];
                    const active = item.id === selectedId;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        className={cn(
                          "w-full rounded-lg px-2 py-2 text-left text-xs",
                          active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50",
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} title={meta.label} />
                          <span className="flex-1 truncate font-medium">{item.name}</span>
                        </span>
                        <span className={cn("mt-0.5 block text-[10px]", active ? "text-slate-300" : "text-slate-400")}>
                          {item.steps.length} pasos · {meta.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {archivedCount > 0 && (
                  <button
                    className="mt-2 text-[10px] text-slate-400 hover:text-slate-600"
                    onClick={() => setShowArchived((value) => !value)}
                  >
                    {showArchived ? "Ocultar archivados" : `Ver archivados (${archivedCount})`}
                  </button>
                )}
                {canEdit && saved && (
                  <div className="mt-3 flex flex-wrap gap-1 border-t border-slate-100 pt-3">
                    <Button variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => setRenaming(true)}>
                      Renombrar
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-6 px-1.5 text-[11px]"
                      disabled={duplicateWorkflow.isPending}
                      onClick={() => duplicateWorkflow.mutate(saved.id)}
                    >
                      Duplicar
                    </Button>
                    <select
                      value={saved.status}
                      disabled={patchWorkflow.isPending}
                      onChange={(event) =>
                        patchWorkflow.mutate({ id: saved.id, status: event.target.value as WorkflowStatusView })
                      }
                      className="h-6 rounded-md border border-slate-200 bg-white px-1 text-[11px] text-slate-600"
                      title="Estado del flujo"
                    >
                      <option value="draft">Borrador</option>
                      <option value="ready">Listo</option>
                      <option value="archived">Archivado</option>
                    </select>
                  </div>
                )}
                {message(duplicateWorkflow.error) && (
                  <p className="mt-2 text-[11px] text-rose-700">{message(duplicateWorkflow.error)}</p>
                )}
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <SuitesPanel
                    suites={workflows.data?.suites ?? []}
                    workflows={workflows.data?.workflows ?? []}
                    canEdit={canEdit}
                    running={runSuite.isPending || !environmentId}
                    onCreate={(name) => createSuite.mutate(name)}
                    onChange={(suite) => saveSuite.mutate(suite)}
                    onDelete={(suiteId) => deleteSuite.mutate(suiteId)}
                    onRun={(suiteId) => runSuite.mutate(suiteId)}
                  />
                </div>
              </Drawer>
            )}

            {/* Drawer: Biblioteca de peticiones reutilizables + importación. */}
            {drawer === "library" && draft && (
              <Drawer title="Biblioteca" side="left" onClose={() => setDrawer(null)}>
                <TemplateLibrary
                  templates={templates}
                  operations={operations.data?.operations ?? []}
                  canEdit={canEdit}
                  addDisabled={!draft}
                  error={message(createTemplate.error) ?? message(deleteTemplate.error)}
                  adding={addingOp}
                  onCreate={(template) => createTemplate.mutate(template)}
                  onDelete={(template) => deleteTemplate.mutate(template.id)}
                  onAdd={(template) => setSteps(addStep(steps, template))}
                  onAddOperation={addOperation}
                />
                {canEdit && (
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <ImportRequests base={base} onImported={() => void invalidate()} />
                  </div>
                )}
              </Drawer>
            )}

            {/* Drawer: Datos (datasets del flujo abierto). */}
            {drawer === "data" && draft && (
              <Drawer title="Datos" side="right" onClose={() => setDrawer(null)}>
                <DatasetsPanel
                  datasets={(workflows.data?.datasets ?? []).filter((dataset) => dataset.workflowId === draft.id)}
                  selectedId={datasetId}
                  canEdit={canEdit}
                  onSelect={setDatasetId}
                  onCreate={(name) => createDataset.mutate(name)}
                  onSave={(id, rows) => saveDataset.mutate({ id, rows })}
                  onDelete={(id) => deleteDataset.mutate(id)}
                  loadRows={async (id) => (await api<DatasetRowsView>(`${base}/datasets/${id}`)).rows}
                />
              </Drawer>
            )}

            {/* Drawer: Ajustes del nodo / del flujo y controles de ejecución. */}
            {inspectorOpen && draft && (
              <Drawer title={selectedStep ? "Nodo" : "Ajustes"} side="right" onClose={() => setInspectorOpen(false)}>
                <WorkflowInspector
                  base={base}
                  workflow={draft}
                  steps={steps}
                  selectedStep={selectedStep}
                  templates={templates}
                  operations={operations.data?.operations ?? []}
                  environments={environments.data ?? []}
                  environmentId={environmentId}
                  canEdit={canEdit}
                  onEnvironment={(next) => {
                    setEnvironmentId(next);
                    if (next) setActiveEnvironment(next);
                  }}
                  onWorkflow={(change) => setDraft((current) => (current ? { ...current, ...change } : current))}
                  onSteps={setSteps}
                  onTemplate={(template) => setTemplateEdits((current) => ({ ...current, [template.id]: template }))}
                  templateUsage={usageOf}
                  onFork={makeIndependent}
                  forking={forking}
                  concurrency={concurrency}
                  onConcurrency={setConcurrency}
                  delayMs={delayMs}
                  onDelay={setDelayMs}
                  onRun={() => run.mutate()}
                  onDelete={() => deleteWorkflow.mutate(draft.id)}
                  running={run.isPending}
                />
              </Drawer>
            )}
          </>
        )}
      </div>

      {/* Los diálogos de nombrar/renombrar viven fuera del lienzo: valen en cualquier pestaña. */}
      {naming && (
        <PromptDialog
          title="Nuevo flujo"
          label="Nombre del flujo"
          hint="Lo que recorre, en pocas palabras: «alta y baja de pedido»."
          placeholder="Alta de pedido"
          onClose={() => setNaming(false)}
          onSubmit={(name) => {
            setNaming(false);
            createWorkflow.mutate(name);
          }}
        />
      )}
      {renaming && saved && (
        <PromptDialog
          title="Renombrar flujo"
          label="Nombre del flujo"
          hint="Lo que recorre, en pocas palabras."
          initialValue={saved.name}
          onClose={() => setRenaming(false)}
          onSubmit={(name) => {
            setRenaming(false);
            if (name.trim() && name !== saved.name) patchWorkflow.mutate({ id: saved.id, name });
          }}
        />
      )}
    </div>
  );
}

/** A tab in the top bar: the whole content area swaps under it. */
function TopTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-medium transition",
        active ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

/** A button in the floating dock over the canvas: a glyph over a small label. */
function DockButton({
  glyph,
  label,
  disabled,
  onClick,
}: {
  glyph: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        "flex w-16 flex-col items-center gap-0.5 rounded-xl px-1 py-2 text-[10px] font-medium text-slate-600 transition hover:bg-slate-100",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      <span aria-hidden className="text-base leading-none">
        {glyph}
      </span>
      {label}
    </button>
  );
}


/**
 * A slim bar that floats over the canvas while a run is watched: the verdict so far and the bar,
 * without taking the flow off screen — the point is to watch the nodes, not a modal.
 */
function RunStrip({ run, onOpen, onClose }: { run: RunView | undefined; onOpen: () => void; onClose: () => void }) {
  const totals = run?.totals;
  const running = run?.status === "queued" || run?.status === "running";
  const progress = totals && totals.cases ? Math.round((totals.completed / totals.cases) * 100) : 0;
  return (
    <div className="fixed inset-x-0 bottom-4 z-40 mx-auto w-[min(680px,92vw)] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-2.5 w-2.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-sky-500" : run?.status === "failed" ? "bg-rose-500" : "bg-emerald-500",
          )}
        />
        <span className="shrink-0 text-xs font-semibold text-slate-800">
          {running ? "Ejecutando el flujo…" : run?.status === "failed" ? "Terminó con fallos" : "Terminó"}
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              run?.status === "failed" ? "bg-rose-400" : "bg-emerald-400",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-slate-500">
          {totals ? `${totals.completed}/${totals.cases}` : "0/0"}
        </span>
        {totals && (
          <span className="hidden shrink-0 gap-2 text-[11px] sm:flex">
            <span className="text-emerald-600">{totals.passed}✓</span>
            <span className="text-rose-600">{totals.failed}✗</span>
            {totals.skipped > 0 && <span className="text-amber-600">{totals.skipped}⃠</span>}
          </span>
        )}
        <Button variant="ghost" className="h-7 shrink-0 px-2 text-[11px]" onClick={onOpen}>
          Ver detalle
        </Button>
        <button className="shrink-0 text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="Cerrar">
          ×
        </button>
      </div>
    </div>
  );
}
