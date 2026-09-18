import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Button, Field, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import type { ForkCreatedView, ProjectSummary } from "@/lib/types";

/**
 * De qué proyecto salió este, bajo su nombre. Un enlace al original, o dicho que ya no está: una
 * bifurcación cuyo original se borró sigue funcionando, lo que no puede es sincronizarse.
 */
export function ForkBadge({ project }: { project: ProjectSummary }) {
  if (!project.fork) return null;
  const { parentName, parentProjectId } = project.fork;
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500" title="Bifurcación">
      <span aria-hidden>⑂</span>
      {parentName ? (
        <>
          bifurcado de{" "}
          <Link to={`/p/${parentProjectId}`} className="truncate font-medium text-slate-700 hover:underline">
            {parentName}
          </Link>
        </>
      ) : (
        <span>el original ya no existe</span>
      )}
    </p>
  );
}

/**
 * El menú del proyecto: bifurcarlo y, si es una bifurcación, traer cambios o fusionar.
 *
 * Donde Postman los pone —en el menú «…» de la colección— y no en una pestaña de ajustes: son
 * cosas que se hacen *con* el proyecto, no ajustes de él. Sustituye a «Copiar de otro proyecto»,
 * que estaba escondido debajo de la importación del contrato y copiaba sin recordar de dónde.
 */
export function ProjectMenu({ project }: { project: ProjectSummary }) {
  const canEdit = useCan("editor");
  const [open, setOpen] = useState(false);
  const [forking, setForking] = useState(false);
  if (!canEdit) return null;
  const item = "block w-full rounded-md px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50";
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Acciones del proyecto"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="grid size-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-50 hover:text-slate-900"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-8 right-0 z-20 w-56 rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              setForking(true);
            }}
          >
            Bifurcar…
          </button>
          {project.fork?.parentName && (
            <>
              <Link role="menuitem" className={item} to={`/p/${project.id}/fork/pull`} onClick={() => setOpen(false)}>
                Traer cambios del original
              </Link>
              <Link role="menuitem" className={item} to={`/p/${project.id}/fork/merge`} onClick={() => setOpen(false)}>
                Fusionar en el original
              </Link>
            </>
          )}
        </div>
      )}
      {forking && <ForkModal project={project} onClose={() => setForking(false)} />}
    </div>
  );
}

/**
 * Bifurcar: el nombre, y lo que no va a cruzar dicho antes de pulsar. Un secreto no se duplica, y
 * enterarse de eso por una línea bajo el resultado es enterarse tarde.
 */
export function ForkModal({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const organization = useOrganization();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(`${project.name} (bifurcación)`);

  const fork = useMutation({
    mutationFn: () =>
      api<ForkCreatedView>(`/orgs/${organization!.id}/projects/${project.id}/fork`, {
        method: "POST",
        body: { name: name.trim() },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      const pending = created.skipped.length;
      toast.success(pending ? `Bifurcado. ${pending} cosas por rellenar: están en su lista.` : "Bifurcado");
      onClose();
      void navigate(`/p/${created.projectId}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) fork.mutate();
  }

  return (
    <Modal
      title={`Bifurcar «${project.name}»`}
      description="Un proyecto nuevo con todo lo de este, que recuerda de dónde salió: después se pueden traer los cambios del original y fusionar los propios en él."
      onClose={onClose}
    >
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Nombre de la bifurcación">
          <input
            autoFocus
            className={inputClass}
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <p className="text-[11px] leading-4 text-amber-700">
          Los entornos llegan sin credenciales y con las variables secretas vacías, y la autenticación del proyecto sin
          su secreto: un secreto no se duplica. Corridas, mocks, documentación publicada y monitores se quedan en el
          original.
        </p>
        {fork.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{fork.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!name.trim() || fork.isPending}>
            {fork.isPending ? "Bifurcando…" : "Bifurcar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
