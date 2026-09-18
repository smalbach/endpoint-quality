/**
 * Importing chosen pieces of another project: pick a source, then tick the endpoints, flows and
 * environments to bring. Starting from a whole project is forking it, from that project's menu;
 * this is for when only a few pieces are wanted.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { cn } from "@/lib/format";
import type { ImportElementsResultView, ImportPreviewView, ProjectSummary } from "@/lib/types";

const message = (error: unknown) => (error as Error | null)?.message ?? null;

export function ImportElements({
  base,
  projectId,
  organizationId,
  disabled,
  onImported,
}: {
  base: string;
  projectId: string;
  organizationId: string;
  disabled: boolean;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sourceProjectId, setSource] = useState("");
  const [endpoints, setEndpoints] = useState<Set<string>>(new Set());
  const [workflows, setWorkflows] = useState<Set<string>>(new Set());
  const [environments, setEnvironments] = useState<Set<string>>(new Set());

  const projects = useQuery({
    queryKey: ["projects", organizationId],
    enabled: open,
    queryFn: () => api<ProjectSummary[]>(`/orgs/${organizationId}/projects`),
  });
  const preview = useQuery({
    queryKey: ["import-preview", projectId, sourceProjectId],
    enabled: open && Boolean(sourceProjectId),
    queryFn: () => api<ImportPreviewView>(`${base}/import-preview?sourceProjectId=${sourceProjectId}`),
  });

  const importer = useMutation({
    mutationFn: () =>
      api<ImportElementsResultView>(`${base}/import-elements`, {
        method: "POST",
        body: {
          sourceProjectId,
          endpointIds: [...endpoints],
          workflowIds: [...workflows],
          environmentIds: [...environments],
        },
      }),
    onSuccess: () => {
      setEndpoints(new Set());
      setWorkflows(new Set());
      setEnvironments(new Set());
      onImported();
    },
  });

  const candidates = (projects.data ?? []).filter((project) => project.id !== projectId);
  const total = endpoints.size + workflows.size + environments.size;

  if (!open) {
    return (
      <Button variant="ghost" className="h-8 text-xs" disabled={disabled} onClick={() => setOpen(true)}>
        Importar por elementos
      </Button>
    );
  }

  return (
    <Card className="mt-2 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-700">Importar de otro proyecto</p>
        <button className="text-[11px] text-slate-400 hover:text-slate-700" onClick={() => setOpen(false)}>
          Cerrar
        </button>
      </div>
      <select
        className="mt-2 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs"
        value={sourceProjectId}
        onChange={(event) => setSource(event.target.value)}
      >
        <option value="">Elige el proyecto de origen…</option>
        {candidates.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {projects.data && candidates.length === 0 && (
        <p className="mt-2 text-[11px] text-slate-400">No hay otro proyecto del que importar.</p>
      )}

      {sourceProjectId && preview.data && (
        <div className="mt-3 space-y-3">
          <Picker
            title="Endpoints"
            items={preview.data.endpoints.map((e) => ({ id: e.id, label: `${e.method} ${e.path}` }))}
            selected={endpoints}
            onChange={setEndpoints}
          />
          <Picker
            title="Flujos"
            items={preview.data.workflows.map((w) => ({ id: w.id, label: `${w.name} · ${w.steps} pasos` }))}
            selected={workflows}
            onChange={setWorkflows}
          />
          <Picker
            title="Entornos"
            items={preview.data.environments.map((e) => ({ id: e.id, label: e.name }))}
            selected={environments}
            onChange={setEnvironments}
          />
          <Button className="w-full" disabled={total === 0 || importer.isPending} onClick={() => importer.mutate()}>
            Importar {total > 0 ? `(${total})` : ""}
          </Button>
        </div>
      )}
      {message(importer.error) && <p className="mt-2 text-[11px] text-rose-700">{message(importer.error)}</p>}
      {importer.data && (
        <p className="mt-2 text-[11px] text-emerald-700">
          Importado: {importer.data.endpoints} endpoints, {importer.data.workflows} flujos, {importer.data.environments}{" "}
          entornos.
          {importer.data.skipped.length > 0 && ` ${importer.data.skipped.length} avisos.`}
        </p>
      )}
    </Card>
  );
}

function Picker({
  title,
  items,
  selected,
  onChange,
}: {
  title: string;
  items: { id: string; label: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  if (items.length === 0) return null;
  const allSelected = items.every((item) => selected.has(item.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
          {title} ({items.length})
        </p>
        <button
          className="text-[10px] text-slate-500 hover:text-slate-800"
          onClick={() => onChange(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
        >
          {allSelected ? "Ninguno" : "Todos"}
        </button>
      </div>
      <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
        {items.map((item) => (
          <label
            key={item.id}
            className={cn("flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-slate-50")}
          >
            <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
            <span className="truncate font-mono text-slate-600">{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
