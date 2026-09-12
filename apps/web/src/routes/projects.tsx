import { useState, type FormEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { cn, formatDate } from "@/lib/format";
import type { ProjectSummary } from "@/lib/types";

type View = "active" | "archived";

/**
 * The list of projects: active or archived, a card each, and «Nuevo proyecto».
 *
 * Both lists come from one request with the archived ones included, split here. Two requests
 * would be two answers that can disagree for a moment about which list a project is in, and the
 * card that just moved would flash in both.
 */
export function ProjectsPage() {
  const organization = useOrganization();
  const canCreate = useCan("editor");
  const canArchive = useCan("admin");
  const toast = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("active");
  const [creating, setCreating] = useState(false);

  const projects = useQuery({
    queryKey: ["projects", organization?.id, "all"],
    enabled: Boolean(organization),
    queryFn: () => api<ProjectSummary[]>(`/orgs/${organization!.id}/projects?includeArchived=true`),
  });

  const archive = useMutation({
    mutationFn: ({ project, archived }: { project: ProjectSummary; archived: boolean }) =>
      api<void>(`/orgs/${organization!.id}/projects/${project.id}/archived`, { method: "PATCH", body: { archived } }),
    onSuccess: async (_result, { project, archived }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(archived ? `«${project.name}» archivado` : `«${project.name}» restaurado`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const all = projects.data ?? [];
  const visible = all.filter((project) => (view === "archived" ? project.archivedAt : !project.archivedAt));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Proyectos</h1>
          <p className="mt-1 text-xs text-slate-500">
            Un proyecto es una API: su contrato, sus entornos, sus flujos y sus corridas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {(["active", "archived"] as const).map((option) => (
              <button
                key={option}
                onClick={() => setView(option)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium",
                  view === option ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900",
                )}
              >
                {option === "active" ? "Activos" : "Archivados"}
              </button>
            ))}
          </div>
          {canCreate && view === "active" && <Button onClick={() => setCreating(true)}>Nuevo proyecto</Button>}
        </div>
      </div>

      {projects.isLoading && <p className="text-sm text-slate-500">Cargando proyectos…</p>}
      {projects.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(projects.error as Error).message}</p>
      )}

      {projects.data &&
        visible.length === 0 &&
        (view === "archived" ? (
          <Empty
            title="Ningún proyecto archivado"
            hint="Los proyectos archivados aparecen aquí y se pueden restaurar cuando quieras."
          />
        ) : (
          <Empty
            title="Todavía no hay proyectos"
            hint="Crea uno, importa su contrato OpenAPI y la matriz de casos aparece sola: lo que el contrato declara no hay que escribirlo a mano."
            action={canCreate ? <Button onClick={() => setCreating(true)}>Crear el primer proyecto</Button> : undefined}
          />
        ))}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            canArchive={canArchive}
            pending={archive.isPending && archive.variables?.project.id === project.id}
            onArchive={(archived) => archive.mutate({ project, archived })}
          />
        ))}
      </div>

      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function ProjectCard({
  project,
  canArchive,
  pending,
  onArchive,
}: {
  project: ProjectSummary;
  canArchive: boolean;
  pending: boolean;
  onArchive: (archived: boolean) => void;
}) {
  const archived = Boolean(project.archivedAt);

  function toggle(event: MouseEvent) {
    // The card is a link; the button inside it must not also open the project.
    event.preventDefault();
    event.stopPropagation();
    onArchive(!archived);
  }

  return (
    <Link to={`/p/${project.id}`} className="group">
      <Card className="relative h-full p-4 transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-slate-900">{project.name}</p>
              {archived && (
                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">archivado</span>
              )}
            </div>
            <p className="truncate font-mono text-[11px] text-slate-400">{project.slug}</p>
          </div>
          {canArchive && (
            <button
              onClick={toggle}
              disabled={pending}
              title={archived ? "Restaurar proyecto" : "Archivar proyecto"}
              className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-slate-50 focus:opacity-100 disabled:opacity-40"
            >
              {archived ? "Restaurar" : "Archivar"}
            </button>
          )}
        </div>

        {project.description && <p className="mt-2 line-clamp-2 text-xs text-slate-500">{project.description}</p>}

        <div className="mt-4 border-t border-slate-100 pt-3 text-[11px]">
          {project.contract ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-500">
              <span className="font-medium text-slate-700">{project.contract.title}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">v{project.contract.version}</span>
              <span>{project.contract.operationCount} operaciones</span>
              <span className="text-slate-400">importado {formatDate(project.contract.importedAt)}</span>
            </div>
          ) : (
            // A real state, not an error: a project exists before its first import, because
            // importing can fail and losing the project with it would help nobody.
            <p className="text-amber-600">Sin contrato importado todavía</p>
          )}
        </div>
      </Card>
    </Link>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const organization = useOrganization();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api<{ projectId: string }>(`/orgs/${organization!.id}/projects`, {
        method: "POST",
        body: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
      }),
    onSuccess: async ({ projectId }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Proyecto creado");
      onClose();
      // Straight to where a new project starts: without a contract there is nothing else to do.
      void navigate(`/p/${projectId}/settings/contract`);
    },
  });

  const fieldError = (field: string) =>
    create.error instanceof ApiError ? create.error.fields.find((entry) => entry.field === field)?.detail : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Modal
      title="Nuevo proyecto"
      description="Un proyecto agrupa el contrato de una API, sus entornos, sus flujos y sus corridas."
      onClose={onClose}
    >
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Nombre *" error={fieldError("name")}>
          <input
            autoFocus
            className={inputClass}
            value={name}
            maxLength={200}
            placeholder="Digital Catalog"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Descripción" error={fieldError("description")}>
          <textarea
            className={`${inputClass} h-20`}
            value={description}
            maxLength={2000}
            placeholder="Opcional"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {create.error && !(create.error instanceof ApiError && create.error.fields.length > 0) && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{create.error.message}</p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creando…" : "Crear proyecto"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
