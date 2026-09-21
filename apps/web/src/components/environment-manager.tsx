/**
 * The environment manager, opened from the bar without leaving the screen.
 *
 * The analyzer's two views: a list to activate, create and delete, and one environment to edit —
 * its name, URL and variables with their initial and current values. Credentials and the run
 * switches (writes, authorization cases) stay in Settings: they are decided once, by an admin, and
 * a modal opened in the middle of debugging a request is not where that decision belongs.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { useActiveEnvironment } from "@/lib/active-environment";
import { mapsFrom, problemsWith, rowsFrom } from "@/lib/env-variables";
import { cn } from "@/lib/format";
import { Badge, Button, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { DeleteDialog } from "@/components/lifecycle";
import { useToast } from "@/components/toast";
import { VariablesEditor } from "@/components/variables-editor";
import type { Environment, ProjectSummary } from "@/lib/types";

export function EnvironmentManager({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const canAdmin = useCan("admin");
  const toast = useToast();
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const [, activate] = useActiveEnvironment(projectId);

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization),
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization),
    queryFn: () => api<ProjectSummary>(base),
  });
  const list = environments.data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["environments", projectId] });

  const remove = useMutation({
    mutationFn: (environment: Environment) => api<void>(`${base}/environments/${environment.id}`, { method: "DELETE" }),
    onSuccess: async (_, environment) => {
      setDeleting(null);
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success(`Entorno «${environment.name}» eliminado`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /**
   * Archivar desde aquí, que es lo que de verdad se quiere casi siempre: sacarlo del selector sin
   * perderlo. Restaurar y borrar del todo se hacen en Settings → Entornos, donde está la papelera:
   * este panel se abre en mitad de una petición y no es sitio para una decisión definitiva.
   */
  const archive = useMutation({
    mutationFn: (environment: Environment) =>
      api<void>(`${base}/environments/${environment.id}/archived`, { method: "PATCH", body: { archived: true } }),
    onSuccess: async (_, environment) => {
      setDeleting(null);
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success(`Entorno «${environment.name}» archivado`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const current = list.find((environment) => environment.id === editing) ?? null;

  return (
    <Modal
      title="Gestor de entornos"
      description="Cada variable tiene un valor inicial, el que comparte el proyecto, y uno actual, el que usan las peticiones y el que cambian los scripts."
      size="xl"
      onClose={onClose}
    >
      {current ? (
        <EnvironmentEditView
          key={current.id}
          base={base}
          environment={current}
          canEdit={canEdit}
          canReveal={canAdmin}
          onBack={() => setEditing(null)}
          onSaved={async () => {
            await invalidate();
            setEditing(null);
            toast.success("Entorno guardado");
          }}
        />
      ) : (
        <div className="space-y-2">
          {environments.isLoading && <p className="text-xs text-slate-500">Cargando…</p>}
          {!environments.isLoading && list.length === 0 && !creating && (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-500">
              Sin entornos. Un entorno es una URL base y las variables que se sustituyen al llamarla.
            </p>
          )}
          {list.map((environment) => (
            <div
              key={environment.id}
              className={cn(
                "flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5",
                environment.active ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200",
              )}
            >
              <span
                className={cn("size-2 shrink-0 rounded-full", environment.active ? "bg-emerald-500" : "bg-slate-300")}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">{environment.name}</span>
                <span className="block truncate font-mono text-[11px] text-slate-400">
                  {environment.baseUrl} · {Object.keys(environment.variables).length} variables
                </span>
              </span>
              {environment.active ? (
                <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">Activo</Badge>
              ) : (
                canEdit && (
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      activate(environment.id);
                      toast.success(`Entorno «${environment.name}» activo`);
                    }}
                  >
                    Activar
                  </Button>
                )
              )}
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(environment.id)}>
                {canEdit ? "Editar" : "Ver"}
              </Button>
              {canAdmin && (
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs text-rose-600 hover:text-rose-700"
                  onClick={() => setDeleting(environment)}
                >
                  Eliminar
                </Button>
              )}
            </div>
          ))}

          {creating ? (
            <NewEnvironmentRow
              base={base}
              defaultBaseUrl={project.data?.baseUrl ?? ""}
              onDone={async (created) => {
                setCreating(false);
                if (created) {
                  await invalidate();
                  await queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                  toast.success("Entorno creado");
                }
              }}
            />
          ) : (
            canEdit && (
              <button
                className="w-full rounded-xl border border-dashed border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900"
                onClick={() => setCreating(true)}
              >
                + Nuevo entorno
              </button>
            )
          )}

          <p className="pt-2 text-[11px] text-slate-500">
            Credenciales, escrituras permitidas y casos de autorización:{" "}
            <Link
              to={`/p/${projectId}/settings/environments`}
              onClick={onClose}
              className="underline underline-offset-2"
            >
              Settings → Entornos
            </Link>
            .
          </p>
        </div>
      )}

      {deleting && (
        <DeleteDialog
          title="Eliminar entorno"
          message={`«${deleting.name}» sale del selector y deja de poder ejecutarse. Sus variables y sus credenciales se guardan.${
            deleting.active ? " Era el activo: pasará a serlo el más antiguo que quede." : ""
          }`}
          restoreHint="Se puede restaurar desde el filtro «Eliminados» de Settings → Entornos."
          pending={remove.isPending || archive.isPending}
          onArchive={() => archive.mutate(deleting)}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </Modal>
  );
}

function NewEnvironmentRow({
  base,
  defaultBaseUrl,
  onDone,
}: {
  base: string;
  defaultBaseUrl: string;
  onDone: (created: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const create = useMutation({
    mutationFn: () =>
      api(`${base}/environments`, { method: "POST", body: { name: name.trim(), baseUrl: baseUrl.trim() } }),
    onSuccess: () => onDone(true),
  });
  const error = create.error instanceof ApiError ? (create.error.fields[0]?.detail ?? create.error.message) : null;

  return (
    <form
      className="rounded-xl border border-slate-200 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && baseUrl.trim()) create.mutate();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDone(false);
        }
      }}
    >
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Nombre del entorno"
          className={`${inputClass} h-8 w-40 text-xs`}
          placeholder="staging"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <input
          aria-label="URL base del entorno"
          className={`${inputClass} h-8 min-w-56 flex-1 font-mono text-xs`}
          placeholder="https://api.ejemplo.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <Button type="submit" className="h-8 text-xs" disabled={!name.trim() || !baseUrl.trim() || create.isPending}>
          Crear
        </Button>
        <Button type="button" variant="ghost" className="h-8 text-xs" onClick={() => onDone(false)}>
          Cancelar
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </form>
  );
}

function EnvironmentEditView({
  base,
  environment,
  canEdit,
  canReveal,
  onBack,
  onSaved,
}: {
  base: string;
  environment: Environment;
  canEdit: boolean;
  canReveal: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const saved = useMemo(
    () => ({
      name: environment.name,
      baseUrl: environment.baseUrl,
      rows: rowsFrom(environment.variables, environment.disabledVariables),
    }),
    [environment],
  );
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const problems = problemsWith(draft.rows);
  const named = (rows: typeof draft.rows) => rows.filter((row) => row.name.trim());
  const dirty =
    draft.name !== saved.name ||
    draft.baseUrl !== saved.baseUrl ||
    JSON.stringify(named(draft.rows)) !== JSON.stringify(named(saved.rows));

  const save = useMutation({
    mutationFn: () =>
      api<void>(`${base}/environments/${environment.id}`, {
        method: "PATCH",
        body: { name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), ...mapsFrom(draft.rows) },
      }),
    onSuccess: onSaved,
  });
  const error = save.error instanceof ApiError ? (save.error.fields[0]?.detail ?? save.error.message) : null;

  return (
    <div>
      <button className="mb-3 text-xs text-slate-500 hover:text-slate-900" onClick={onBack}>
        ← Entornos
      </button>
      <div className="flex flex-wrap gap-2">
        <label className="text-[11px] text-slate-600">
          Nombre
          <input
            className={`${inputClass} mt-1 h-8 w-44 text-xs`}
            value={draft.name}
            disabled={!canEdit}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
          />
        </label>
        <label className="min-w-64 flex-1 text-[11px] text-slate-600">
          URL base
          <input
            className={`${inputClass} mt-1 h-8 font-mono text-xs`}
            value={draft.baseUrl}
            disabled={!canEdit}
            onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))}
          />
        </label>
      </div>
      <div className="mt-4">
        <VariablesEditor
          rows={draft.rows}
          problems={problems}
          disabled={!canEdit}
          onChange={(rows) => setDraft((value) => ({ ...value, rows }))}
          onReveal={
            canReveal
              ? () => api<Record<string, string>>(`${base}/environments/${environment.id}/variables/reveal`)
              : undefined
          }
        />
      </div>
      {canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <Button disabled={!dirty || problems.length > 0 || save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
          <Button variant="ghost" onClick={dirty ? () => setDraft(saved) : onBack}>
            {dirty ? "Descartar" : "Cancelar"}
          </Button>
          <span className="text-xs text-slate-500">
            {problems.length > 0 ? "Hay variables con problemas" : dirty ? "Cambios sin guardar" : ""}
          </span>
          {error && <p className="w-full text-xs text-rose-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
