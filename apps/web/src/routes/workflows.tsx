/**
 * Reusable requests and the flows built from them.
 *
 * Two views of one document: the canvas and the JSON. Neither is the source of truth — the flow's
 * `definition` is, and both edit it. The graph is written whole on save, which is what makes «node
 * deleted, edge still pointing at it» a state that cannot be stored.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PromptDialog } from "@/components/overlay";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Empty } from "@/components/ui";
import { cn } from "@/lib/format";
import { unchanged } from "@/lib/config-draft";
import { addStep, flowProblems, WORKFLOW_STATUS_META, type OperationSummary } from "@/lib/workflow-draft";
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
  SuiteView,
  WorkflowStatusView,
  WorkflowStepView,
  WorkflowView,
  WorkflowsView,
} from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;

export function WorkflowsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const navigate = useNavigate();
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
  const [concurrency, setConcurrency] = useState(1);

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

  const run = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`${base}/runs`, {
        method: "POST",
        body: { environmentId, workflowId: draft?.id, concurrency, ...(datasetId ? { datasetId } : {}) },
      }),
    onSuccess: ({ runId }) => void navigate(`/p/${projectId}/runs/${runId}`),
  });

  const runSuite = useMutation({
    mutationFn: (suiteId: string) =>
      api<{ runId: string }>(`${base}/runs`, { method: "POST", body: { environmentId, suiteId, concurrency } }),
    onSuccess: ({ runId }) => void navigate(`/p/${projectId}/runs/${runId}`),
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

  function setSteps(next: WorkflowStepView[]) {
    setDraft((current) => (current ? { ...current, steps: next } : current));
    setJson(JSON.stringify({ steps: next }, null, 2));
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
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">Flujos de ejecución</h1>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
              Compón pruebas reutilizables, conecta sus dependencias y captura valores de una respuesta para usarlos
              como <span className="font-mono">{"{{variable}}"}</span> en los pasos siguientes. Un paso cuyo antecesor
              falla no se ejecuta.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={switchView} disabled={!draft}>
              {asJson ? "Volver al diagrama" : "Editar JSON"}
            </Button>
            {canEdit && (
              <Button disabled={!dirty || save.isPending || problems.length > 0} onClick={() => save.mutate()}>
                Guardar
              </Button>
            )}
          </div>
        </div>
        {problems.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-rose-700">
            {problems.map((problem, index) => (
              <li key={`${problem.message}-${index}`} className="flex items-center gap-2">
                <span>{problem.message}</span>
                {problem.stepId && (
                  <button
                    className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 hover:bg-rose-100"
                    onClick={() => {
                      // The problem is a path into a node; the fix is at the node, so the panel jumps
                      // to it — leaving the JSON view if that is where it was clicked.
                      setAsJson(false);
                      setSelectedStep(problem.stepId!);
                    }}
                  >
                    Ir al nodo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(message(save.error) ??
          message(run.error) ??
          message(createTemplate.error) ??
          message(deleteTemplate.error)) && (
          <p className="mt-3 text-xs text-rose-700">
            {message(save.error) ??
              message(run.error) ??
              message(createTemplate.error) ??
              message(deleteTemplate.error)}
          </p>
        )}
      </Card>

      {asJson ? (
        <Card className="p-4">
          <textarea
            className="h-[60vh] w-full rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] text-slate-100"
            value={json}
            spellCheck={false}
            onChange={(event) => setJson(event.target.value)}
          />
          {jsonError && <p className="mt-2 text-xs text-rose-700">{jsonError}</p>}
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
          <Card className="p-3">
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
            </div>
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

            <div className="mt-4 border-t border-slate-100 pt-3">
              <TemplateLibrary
                templates={templates}
                operations={operations.data?.operations ?? []}
                canEdit={canEdit}
                addDisabled={!draft}
                error={message(createTemplate.error) ?? message(deleteTemplate.error)}
                onCreate={(template) => createTemplate.mutate(template)}
                onDelete={(template) => deleteTemplate.mutate(template.id)}
                onAdd={(template) => setSteps(addStep(steps, template))}
              />
              {canEdit && <ImportRequests base={base} onImported={() => void invalidate()} />}
            </div>
          </Card>

          <Card className="h-[65vh] min-h-[520px] overflow-hidden">
            {!draft ? (
              <Empty title="Crea tu primer flujo" hint="Después añade pruebas reutilizables desde la biblioteca." />
            ) : (
              <WorkflowCanvas
                steps={steps}
                templates={templates}
                operations={operations.data?.operations ?? []}
                onChange={setSteps}
                onSelect={setSelectedStep}
              />
            )}
          </Card>

          <Card className="p-3">
            {draft && (
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
                concurrency={concurrency}
                onConcurrency={setConcurrency}
                onRun={() => run.mutate()}
                onDelete={() => deleteWorkflow.mutate(draft.id)}
                running={run.isPending}
              />
            )}
            {draft && (
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
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
