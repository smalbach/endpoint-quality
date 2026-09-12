import { useEffect, useMemo, useState, type FormEvent } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Card, Field, inputClass } from "@/components/ui";
import { ConfirmDialog, Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { ProjectAuthFields } from "@/components/project-auth-fields";
import { authDraft, authPayload, authProblems, parseTags } from "@/lib/project-auth";
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

/**
 * What the project is and what API it points at: name, description, base URL, tags and how to log
 * in — the analyzer's settings tab — plus archiving and deleting it.
 *
 * One form and one «Guardar», as in the analyzer. The authentication is sent whole every time: its
 * secrets come back from the API as the mask, and the mask going back means «unchanged», so
 * saving the name does not need the token to be retyped.
 */
export function ProjectGeneralPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const isAdmin = useCan("admin");
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ProjectSummary>(base),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [tags, setTags] = useState("");
  const [auth, setAuth] = useState(authDraft(undefined));
  useEffect(() => {
    if (!project.data) return;
    setName(project.data.name);
    setDescription(project.data.description);
    setBaseUrl(project.data.baseUrl);
    setTags(project.data.tags.join(", "));
    setAuth(authDraft(project.data.auth));
  }, [project.data]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
    ]);

  const body = useMemo(
    () => ({ name: name.trim(), description, baseUrl: baseUrl.trim(), tags: parseTags(tags), auth: authPayload(auth) }),
    [name, description, baseUrl, tags, auth],
  );
  const saved = useMemo(
    () =>
      project.data && {
        name: project.data.name,
        description: project.data.description,
        baseUrl: project.data.baseUrl,
        tags: project.data.tags,
        auth: authPayload(authDraft(project.data.auth)),
      },
    [project.data],
  );

  const save = useMutation({
    mutationFn: () => api<void>(base, { method: "PATCH", body }),
    onSuccess: async () => {
      await refresh();
      toast.success("Settings guardados");
    },
  });

  const archived = Boolean(project.data?.archivedAt);
  const archive = useMutation({
    mutationFn: () => api<void>(`${base}/archived`, { method: "PATCH", body: { archived: !archived } }),
    onSuccess: async () => {
      setConfirmingArchive(false);
      await refresh();
      toast.success(archived ? "Proyecto restaurado" : "Proyecto archivado");
    },
    onError: (error: Error) => {
      setConfirmingArchive(false);
      toast.error(error.message);
    },
  });

  if (!project.data) return <p className="text-sm text-slate-500">Cargando…</p>;

  const clientProblems = authProblems(auth);
  const dirty = JSON.stringify(body) !== JSON.stringify(saved);
  const serverFields = save.error instanceof ApiError ? save.error.fields : [];
  const fieldError = (field: string) =>
    serverFields.find((entry) => entry.field === field)?.detail ?? clientProblems[field];
  const editable = canEdit && !archived;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && Object.keys(clientProblems).length === 0) save.mutate();
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card className="p-4">
        <form className="space-y-3" onSubmit={submit}>
          {archived && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              El proyecto está archivado. Restáuralo para cambiar sus ajustes.
            </p>
          )}
          <Field label="Nombre *" error={fieldError("name")}>
            <input
              className={inputClass}
              value={name}
              required
              maxLength={200}
              disabled={!editable}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Descripción" error={fieldError("description")} hint="Para qué es, y de quién es la API.">
            <textarea
              className={`${inputClass} h-20`}
              value={description}
              maxLength={2000}
              disabled={!editable}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field
            label="URL base"
            error={fieldError("baseUrl")}
            hint="La raíz de la API, por ejemplo https://api.miapp.com. Cada entorno puede tener la suya."
          >
            <input
              className={`${inputClass} font-mono text-xs`}
              value={baseUrl}
              placeholder="https://api.example.com"
              disabled={!editable}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field label="Etiquetas" hint="Separadas por comas." error={fieldError("tags")}>
            <input
              className={inputClass}
              value={tags}
              placeholder="produccion, v2, interno"
              disabled={!editable}
              onChange={(event) => setTags(event.target.value)}
            />
          </Field>

          <div className="border-t border-slate-100 pt-3">
            <ProjectAuthFields
              value={auth}
              onChange={setAuth}
              errors={{ ...clientProblems, ...fieldsByName(serverFields) }}
              disabled={!editable}
            />
          </div>

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
          {save.error && serverFields.length === 0 && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{save.error.message}</p>
          )}
          {editable && (
            <Button
              type="submit"
              disabled={!dirty || !name.trim() || Object.keys(clientProblems).length > 0 || save.isPending}
            >
              {save.isPending ? "Guardando…" : "Guardar settings"}
            </Button>
          )}
        </form>
      </Card>

      {isAdmin && (
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
          <Button variant="ghost" onClick={() => (archived ? archive.mutate() : setConfirmingArchive(true))}>
            {archived ? "Restaurar" : "Archivar"}
          </Button>
        </Card>
      )}

      {isAdmin && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-rose-200 p-4">
          <div>
            <p className="text-sm font-semibold text-rose-700">Eliminar proyecto</p>
            <p className="mt-1 text-xs text-slate-500">
              Desaparece para todo el mundo y no se puede deshacer desde la interfaz.
            </p>
          </div>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            Eliminar
          </Button>
        </Card>
      )}

      {confirmingArchive && (
        <ConfirmDialog
          title="Archivar proyecto"
          message={`«${project.data.name}» dejará de aparecer entre los proyectos activos. No se borra nada.`}
          confirmLabel="Archivar"
          danger={false}
          pending={archive.isPending}
          onConfirm={() => archive.mutate()}
          onClose={() => setConfirmingArchive(false)}
        />
      )}

      {deleting && (
        <DeleteProjectModal
          name={project.data.name}
          base={base}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            setDeleting(false);
            await queryClient.invalidateQueries({ queryKey: ["projects"] });
            queryClient.removeQueries({ queryKey: ["project", projectId] });
            toast.success(`«${project.data.name}» eliminado`);
            void navigate("/projects", { replace: true });
          }}
        />
      )}
    </div>
  );
}

const fieldsByName = (fields: { field: string; detail: string }[]) =>
  Object.fromEntries(fields.map((entry) => [entry.field, entry.detail]));

/** Typing the name is the confirmation: a deletion one misclick away is a deletion that happens. */
function DeleteProjectModal({
  name,
  base,
  onClose,
  onDeleted,
}: {
  name: string;
  base: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: () => api<void>(base, { method: "DELETE" }),
    onSuccess: onDeleted,
  });

  return (
    <Modal
      title="Eliminar proyecto"
      description="Sus entornos, flujos y configuración dejan de estar accesibles para todo el mundo."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" disabled={typed !== name || remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Eliminando…" : "Eliminar para siempre"}
          </Button>
        </>
      }
    >
      <Field label={`Escribe «${name}» para confirmar`} error={remove.error?.message}>
        <input autoFocus className={inputClass} value={typed} onChange={(event) => setTyped(event.target.value)} />
      </Field>
    </Modal>
  );
}
