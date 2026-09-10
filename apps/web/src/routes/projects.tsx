import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { ProjectSummary } from "@/lib/types";

/**
 * The list of projects, which is where the decoupling becomes visible to a person.
 *
 * The coupled dashboard had no such screen: there was one API, compiled in, and the concept of a
 * second one did not exist. Here a project is a contract plus everything a team decided about how
 * to exercise it, and there can be as many as you like.
 */
export function ProjectsPage() {
  const organization = useOrganization();
  const canCreate = useCan("editor");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);

  const projects = useQuery({
    queryKey: ["projects", organization?.id],
    enabled: Boolean(organization),
    queryFn: () => api<ProjectSummary[]>(`/orgs/${organization!.id}/projects`),
  });

  const create = useMutation({
    mutationFn: (projectName: string) =>
      api<{ projectId: string }>(`/orgs/${organization!.id}/projects`, { method: "POST", body: { name: projectName } }),
    onSuccess: async () => {
      setName("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (caught: Error) => setError(caught),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Proyectos</h1>
          <p className="mt-1 text-xs text-slate-500">
            Un proyecto es un contrato y todo lo que un equipo decidió sobre cómo ejercitarlo.
          </p>
        </div>
        {canCreate && (
          <form className="flex items-end gap-2" onSubmit={submit}>
            <Field label="Nuevo proyecto" error={error instanceof ApiError ? error.fields[0]?.detail : undefined}>
              <input
                className={`${inputClass} w-64`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Digital Catalog"
              />
            </Field>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              Crear
            </Button>
          </form>
        )}
      </div>

      {projects.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
      {projects.error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(projects.error as Error).message}</p>
      )}

      {projects.data?.length === 0 && (
        <Empty
          title="Todavía no hay proyectos"
          hint="Crea uno, importa su contrato OpenAPI y la matriz de casos aparece sola: lo que el contrato declara no hay que escribirlo a mano."
        />
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.data?.map((project) => (
          <Link key={project.id} to={`/p/${project.id}`}>
            <Card className="h-full p-4 transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{project.name}</p>
                  <p className="truncate font-mono text-[11px] text-slate-400">{project.slug}</p>
                </div>
                {project.archivedAt && (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">archivado</span>
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
        ))}
      </div>
    </div>
  );
}
