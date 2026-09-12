import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Field, inputClass } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { cn, formatDate } from "@/lib/format";
import type { ProjectSummary } from "@/lib/types";

/** The three pages of a project's settings, as absolute paths. */
export function settingsTabs(projectId: string | undefined) {
  if (!projectId) return [];
  const base = `/p/${projectId}/settings`;
  return [
    { to: base, label: "General", end: true },
    { to: `${base}/contract`, label: "Contrato y configuración", end: false },
    { to: `${base}/environments`, label: "Entornos", end: false },
  ];
}

export function ProjectSettingsLayout() {
  const { projectId } = useParams();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold text-slate-900">Settings</h1>
        <nav className="mt-3 flex gap-1 border-b border-slate-200">
          {settingsTabs(projectId).map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                  isActive
                    ? "border-slate-900 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}

/** Name, description and the project's life: what it is called, what it is for, and archiving it. */
export function ProjectGeneralPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const canArchive = useCan("admin");
  const toast = useToast();
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const [confirming, setConfirming] = useState(false);

  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ProjectSummary>(base),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (!project.data) return;
    setName(project.data.name);
    setDescription(project.data.description);
  }, [project.data]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
    ]);

  const save = useMutation({
    mutationFn: () => api<void>(base, { method: "PATCH", body: { name: name.trim(), description } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Proyecto guardado");
    },
  });

  const archived = Boolean(project.data?.archivedAt);
  const archive = useMutation({
    mutationFn: () => api<void>(`${base}/archived`, { method: "PATCH", body: { archived: !archived } }),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
      toast.success(archived ? "Proyecto restaurado" : "Proyecto archivado");
    },
    onError: (error: Error) => {
      setConfirming(false);
      toast.error(error.message);
    },
  });

  if (!project.data) return <p className="text-sm text-slate-500">Cargando…</p>;

  const dirty = name.trim() !== project.data.name || description !== project.data.description;
  const fieldError = (field: string) =>
    save.error instanceof ApiError ? save.error.fields.find((entry) => entry.field === field)?.detail : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) save.mutate();
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card className="p-4">
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Nombre *" error={fieldError("name")}>
            <input
              className={inputClass}
              value={name}
              required
              maxLength={200}
              disabled={!canEdit}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Descripción" error={fieldError("description")} hint="Para qué es, y de quién es la API.">
            <textarea
              className={`${inputClass} h-20`}
              value={description}
              maxLength={2000}
              disabled={!canEdit}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-[11px]">
            <dt className="text-slate-500">Identificador</dt>
            <dd className="font-mono text-slate-700">{project.data.slug}</dd>
            <dt className="text-slate-500">Contrato</dt>
            <dd className="text-slate-700">
              {project.data.contract
                ? `${project.data.contract.title} v${project.data.contract.version} · importado ${formatDate(project.data.contract.importedAt)}`
                : "sin importar"}
            </dd>
          </dl>
          {save.error && !(save.error instanceof ApiError && save.error.fields.length > 0) && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{save.error.message}</p>
          )}
          {canEdit && (
            <Button type="submit" disabled={!dirty || !name.trim() || save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar"}
            </Button>
          )}
        </form>
      </Card>

      {canArchive && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              {archived ? "Proyecto archivado" : "Archivar proyecto"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {archived
                ? `Archivado el ${formatDate(project.data.archivedAt!)}. Restaurarlo lo devuelve a la lista de proyectos activos.`
                : "Sale de la lista de proyectos activos. Sus corridas, flujos y entornos se conservan y se puede restaurar."}
            </p>
          </div>
          <Button variant="ghost" onClick={() => (archived ? archive.mutate() : setConfirming(true))}>
            {archived ? "Restaurar" : "Archivar"}
          </Button>
        </Card>
      )}

      {confirming && (
        <ConfirmDialog
          title="Archivar proyecto"
          message={`«${project.data.name}» dejará de aparecer entre los proyectos activos. No se borra nada.`}
          confirmLabel="Archivar"
          pending={archive.isPending}
          onConfirm={() => archive.mutate()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
