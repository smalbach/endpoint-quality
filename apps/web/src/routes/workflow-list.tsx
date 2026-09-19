/**
 * The door into flows: every flow of the project, what it runs and who runs it.
 *
 * The canvas used to open straight onto the first flow, with the others behind a drawer — which hid
 * the one thing a list of flows is good for: seeing how they hang together. Here each flow shows the
 * subflows it runs (and theirs, as a tree), the flows that run it and the suites that hold it; a click
 * opens its canvas at `workflows/:workflowId`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { useImport } from "@/components/import-provider";
import { PromptDialog } from "@/components/overlay";
import { Button, Card, Empty, inputClass } from "@/components/ui";
import { SuitesPanel } from "@/components/suites-panel";
import { bundleFileName, downloadJson } from "@/lib/project-bundle";
import { cn } from "@/lib/format";
import { WORKFLOW_STATUS_META } from "@/lib/workflow-draft";
import { flowConnections, subflowTree, type SubflowTreeNode } from "@/lib/workflow-subflow";
import type { Environment, SuiteView, WorkflowStatusView, WorkflowView, WorkflowsView } from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;

type StatusFilter = "all" | "ready" | "draft" | "archived";

export function WorkflowListPage({ projectId }: { projectId: string }) {
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const { open: openImport } = useImport();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const flowPath = (id: string) => `/p/${projectId}/workflows/${id}`;

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [naming, setNaming] = useState(false);
  const [renaming, setRenaming] = useState<WorkflowView | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [activeEnvironment, setActiveEnvironment] = useActiveEnvironment(projectId);
  const preselected = useRef(false);

  const enabled = Boolean(organization && projectId);
  const workflows = useQuery({
    queryKey: ["workflows", projectId],
    enabled,
    queryFn: () => api<WorkflowsView>(`${base}/workflows`),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled,
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  // Suites run from here need an environment: start from the project's active one, once.
  useEffect(() => {
    if (preselected.current || !environments.data) return;
    preselected.current = true;
    const active = resolveActive(activeEnvironment, environments.data);
    if (active) setEnvironmentId(active.id);
  }, [environments.data, activeEnvironment]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });

  const createWorkflow = useMutation({
    mutationFn: (name: string) => api<{ workflowId: string }>(`${base}/workflows`, { method: "POST", body: { name } }),
    onSuccess: async ({ workflowId }) => {
      await invalidate();
      void navigate(flowPath(workflowId));
    },
  });
  const duplicateWorkflow = useMutation({
    mutationFn: (workflowId: string) =>
      api<{ workflowId: string }>(`${base}/workflows/${workflowId}/duplicate`, { method: "POST" }),
    onSuccess: invalidate,
  });
  /** One flow as a file: with the requests, datasets and sub-flows it needs to run elsewhere. */
  const exportWorkflow = useMutation({
    mutationFn: async (flow: { id: string; name: string }) => ({
      bundle: await api<unknown>(`${base}/export?parts=flows,contract&workflowIds=${flow.id}`),
      name: flow.name,
    }),
    onSuccess: ({ bundle, name }) => downloadJson(bundleFileName(name), bundle),
  });
  // Rename and status are partial writes of the row, not the graph.
  const patchWorkflow = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; status?: WorkflowStatusView }) =>
      api<void>(`${base}/workflows/${id}`, { method: "PUT", body }),
    onSuccess: invalidate,
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
  // A suite walks several flows, so its run is read where every run is: the run's own page.
  const runSuite = useMutation({
    mutationFn: (suiteId: string) =>
      api<{ runId: string }>(`${base}/runs`, { method: "POST", body: { environmentId, suiteId } }),
    onSuccess: ({ runId }) => void navigate(`/p/${projectId}/runs/${runId}`),
  });

  const allFlows = useMemo(() => workflows.data?.workflows ?? [], [workflows.data]);
  const suites = useMemo(() => workflows.data?.suites ?? [], [workflows.data]);
  const connections = useMemo(() => flowConnections(allFlows, suites), [allFlows, suites]);
  // `connections` only names flows and suites it was built from, so both lookups always find one.
  const nameOf = (id: string) => allFlows.find((flow) => flow.id === id)!.name;
  const suiteName = (id: string) => suites.find((suite) => suite.id === id)!.name;

  const needle = query.trim().toLowerCase();
  const visible = allFlows.filter((flow) => {
    if (status === "all" ? flow.status === "archived" : flow.status !== status) return false;
    return (
      !needle || flow.name.toLowerCase().includes(needle) || (flow.description ?? "").toLowerCase().includes(needle)
    );
  });
  const count = (filter: StatusFilter) =>
    allFlows.filter((flow) => (filter === "all" ? flow.status !== "archived" : flow.status === filter)).length;

  if (workflows.isLoading) return <p className="text-sm text-slate-500">Cargando flujos…</p>;

  const error =
    message(createWorkflow.error) ??
    message(duplicateWorkflow.error) ??
    message(exportWorkflow.error) ??
    message(patchWorkflow.error) ??
    message(runSuite.error);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Flujos</h1>
          <p className="mt-1 max-w-xl text-xs text-slate-500">
            Cada flujo con los sub-flujos que ejecuta, quién lo ejecuta a él y las suites que lo incluyen. Ábrelo para
            editarlo en el lienzo.
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => openImport()}>
              Importar
            </Button>
            <Button disabled={createWorkflow.isPending} onClick={() => setNaming(true)}>
              + Nuevo flujo
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={cn(inputClass, "h-8 max-w-xs text-xs")}
              placeholder="Buscar flujo…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
              {(
                [
                  ["all", "Activos"],
                  ["ready", "Listos"],
                  ["draft", "Borradores"],
                  ["archived", "Archivados"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setStatus(value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition",
                    status === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
                  )}
                >
                  {label} <span className="text-slate-400">{count(value)}</span>
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-rose-700">{error}</p>}

          {allFlows.length === 0 ? (
            <Empty
              title="Crea tu primer flujo"
              hint="Un flujo encadena peticiones, esperas, validaciones y sub-flujos en un lienzo."
              action={canEdit ? <Button onClick={() => setNaming(true)}>+ Nuevo flujo</Button> : undefined}
            />
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-xs text-slate-400">Ningún flujo coincide.</p>
          ) : (
            <ul className="space-y-2">
              {visible.map((flow) => (
                <FlowRow
                  key={flow.id}
                  flow={flow}
                  href={flowPath(flow.id)}
                  flowPath={flowPath}
                  tree={subflowTree(allFlows, flow.id)}
                  calledBy={connections[flow.id].calledBy}
                  suites={connections[flow.id].suites.map(suiteName)}
                  nameOf={nameOf}
                  canEdit={canEdit}
                  busy={patchWorkflow.isPending || duplicateWorkflow.isPending || exportWorkflow.isPending}
                  onRename={() => setRenaming(flow)}
                  onDuplicate={() => duplicateWorkflow.mutate(flow.id)}
                  onExport={() => exportWorkflow.mutate({ id: flow.id, name: flow.name })}
                  onStatus={(next) => patchWorkflow.mutate({ id: flow.id, status: next })}
                />
              ))}
            </ul>
          )}
        </div>

        <aside className="space-y-3">
          <Card className="p-3">
            <label className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
              Entorno de las suites
            </label>
            <select
              className="mt-1 h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600"
              value={environmentId}
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
            <div className="mt-3 border-t border-slate-100 pt-3">
              <SuitesPanel
                suites={suites}
                workflows={allFlows}
                canEdit={canEdit}
                running={runSuite.isPending || !environmentId}
                onCreate={(name) => createSuite.mutate(name)}
                onChange={(suite) => saveSuite.mutate(suite)}
                onDelete={(suiteId) => deleteSuite.mutate(suiteId)}
                onRun={(suiteId) => runSuite.mutate(suiteId)}
              />
            </div>
          </Card>
        </aside>
      </div>

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
      {renaming && (
        <PromptDialog
          title="Renombrar flujo"
          label="Nombre del flujo"
          hint="Lo que recorre, en pocas palabras."
          initialValue={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={(name) => {
            const flow = renaming;
            setRenaming(null);
            if (name.trim() && name !== flow.name) patchWorkflow.mutate({ id: flow.id, name });
          }}
        />
      )}
    </div>
  );
}

/** What kinds of node a flow is made of, in a few words: «4 peticiones · 1 sub-flujo · 1 if». */
function composition(flow: WorkflowView): string {
  const counts = new Map<string, number>();
  for (const step of flow.steps) {
    const kind = step.kind ?? "request";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const label = (kind: string, n: number) =>
    kind === "request"
      ? `${n} ${n === 1 ? "petición" : "peticiones"}`
      : kind === "subflow"
        ? `${n} sub-flujo${n === 1 ? "" : "s"}`
        : `${n} ${kind}`;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => label(kind, n))
    .join(" · ");
}

function FlowRow({
  flow,
  href,
  flowPath,
  tree,
  calledBy,
  suites,
  nameOf,
  canEdit,
  busy,
  onRename,
  onDuplicate,
  onExport,
  onStatus,
}: {
  flow: WorkflowView;
  href: string;
  flowPath: (id: string) => string;
  tree: SubflowTreeNode[];
  calledBy: string[];
  suites: string[];
  nameOf: (id: string) => string;
  canEdit: boolean;
  busy: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onStatus: (status: WorkflowStatusView) => void;
}) {
  const meta = WORKFLOW_STATUS_META[flow.status];
  const [open, setOpen] = useState(true);
  return (
    <li>
      <Card className="p-0 transition hover:border-slate-300">
        <div className="flex items-start gap-3 p-3">
          <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", meta.dot)} title={meta.label} />
          <Link to={href} className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-900 hover:underline">{flow.name}</span>
            {flow.description && (
              <span className="mt-0.5 block truncate text-xs text-slate-500">{flow.description}</span>
            )}
            <span className="mt-1 block text-[11px] text-slate-400">
              {flow.steps.length ? composition(flow) : "Vacío"} · {meta.label}
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            {canEdit && (
              <>
                <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={onRename}>
                  Renombrar
                </Button>
                <Button variant="ghost" className="h-7 px-2 text-[11px]" disabled={busy} onClick={onDuplicate}>
                  Duplicar
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  disabled={busy}
                  onClick={onExport}
                  title="Descargar este flujo, con sus peticiones, datasets y sub-flujos, como .json"
                >
                  Exportar
                </Button>
                <select
                  value={flow.status}
                  disabled={busy}
                  onChange={(event) => onStatus(event.target.value as WorkflowStatusView)}
                  className="h-7 rounded-md border border-slate-200 bg-white px-1 text-[11px] text-slate-600"
                  title="Estado del flujo"
                >
                  <option value="draft">Borrador</option>
                  <option value="ready">Listo</option>
                  <option value="archived">Archivado</option>
                </select>
              </>
            )}
            <Link
              to={href}
              className="ml-1 rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-slate-700"
            >
              Abrir lienzo
            </Link>
          </div>
        </div>

        {(tree.length > 0 || calledBy.length > 0 || suites.length > 0) && (
          <div className="space-y-2 border-t border-slate-100 px-3 py-2 pl-8">
            {tree.length > 0 && (
              <div>
                <button
                  onClick={() => setOpen((value) => !value)}
                  className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase hover:text-slate-600"
                >
                  {open ? "▾" : "▸"} Sub-flujos ({tree.length})
                </button>
                {open && <SubflowBranch nodes={tree} flowPath={flowPath} />}
              </div>
            )}
            {calledBy.length > 0 && (
              <Chips label="Lo ejecutan">
                {calledBy.map((id) => (
                  <Link
                    key={id}
                    to={flowPath(id)}
                    className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700 ring-1 ring-sky-200 hover:bg-sky-100"
                  >
                    ↰ {nameOf(id)}
                  </Link>
                ))}
              </Chips>
            )}
            {suites.length > 0 && (
              <Chips label="En suites">
                {suites.map((name) => (
                  <span
                    key={name}
                    className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700 ring-1 ring-violet-200"
                  >
                    {name}
                  </span>
                ))}
              </Chips>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

function Chips({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{label}</span>
      {children}
    </div>
  );
}

/** One level of the subflow tree, indented under its parent with a guide line. */
function SubflowBranch({ nodes, flowPath }: { nodes: SubflowTreeNode[]; flowPath: (id: string) => string }) {
  return (
    <ul className="mt-1 space-y-1 border-l border-slate-200 pl-3">
      {nodes.map((node, index) => (
        <li key={`${node.id}-${index}`}>
          {node.flow ? (
            <Link to={flowPath(node.id)} className="group inline-flex items-center gap-1.5 text-xs text-slate-700">
              <span className={cn("h-1.5 w-1.5 rounded-full", WORKFLOW_STATUS_META[node.flow.status].dot)} />
              <span className="font-medium group-hover:underline">{node.flow.name}</span>
              <span className="text-[10px] text-slate-400">{node.flow.steps.length} pasos</span>
              {node.cycle && (
                <span
                  className="rounded bg-rose-50 px-1 text-[10px] text-rose-700"
                  title="Este sub-flujo ya está más arriba en la rama"
                >
                  ciclo
                </span>
              )}
              {node.flow.status === "archived" && (
                <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">archivado</span>
              )}
            </Link>
          ) : (
            <span className="text-xs text-rose-600">Sub-flujo borrado ({node.id.slice(0, 8)})</span>
          )}
          {node.children.length > 0 && <SubflowBranch nodes={node.children} flowPath={flowPath} />}
        </li>
      ))}
    </ul>
  );
}
