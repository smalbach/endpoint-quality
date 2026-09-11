import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { Button, Field, inputClass } from "@/components/ui";
import type { ProjectSummary } from "@/lib/types";

/**
 * Empezar este proyecto desde otro que ya funciona.
 *
 * The second project of a team is never a blank one: same envelope, same budgets, same words for
 * the same cases, usually the same shape of flow. Retyping all of it is an afternoon, and it is
 * also where the differences come from that make two projects disagree about what «pasó» means.
 *
 * **The panel says what will not come across before anything is pressed**, not afterwards. A
 * credential and the value of a secret variable are exactly what must not be duplicated, and
 * finding that out from a result line — after the environments are already there, looking
 * configured — is finding it out at the wrong moment.
 */
const SECTIONS = [
  { id: "envelope", label: "Envelope" },
  { id: "budgets", label: "Presupuestos" },
  { id: "parameters", label: "Parámetros" },
  { id: "bodies", label: "Payloads" },
  { id: "scenarios", label: "Escenarios" },
  { id: "authorization", label: "Autorización" },
  { id: "access", label: "Permisos" },
  { id: "labels", label: "Etiquetas" },
  { id: "text", label: "Textos" },
  // `implemented` is deliberately absent: it is a fact about *this* project's code — which
  // operations it routes today — and copying it would assert something about a codebase the
  // source project has never seen.
] as const;

type Outcome = {
  sections: string[];
  requestTemplates: number;
  workflows: number;
  suites: number;
  environments: number;
  skipped: { what: string; detail: string }[];
};

export function CopyFromProject({
  base,
  projectId,
  organizationId,
  disabled,
  onCopied,
}: {
  base: string;
  projectId: string;
  organizationId: string;
  disabled: boolean;
  onCopied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sourceProjectId, setSource] = useState("");
  const [sections, setSections] = useState<string[]>(["envelope", "budgets"]);
  const [flows, setFlows] = useState(true);
  const [environments, setEnvironments] = useState(false);

  const projects = useQuery({
    queryKey: ["projects", organizationId],
    enabled: open,
    queryFn: () => api<ProjectSummary[]>(`/orgs/${organizationId}/projects`),
  });
  const copy = useMutation({
    mutationFn: () =>
      api<Outcome>(`${base}/copy-from-project`, {
        method: "POST",
        body: { sourceProjectId, sections, flows, environments },
      }),
    onSuccess: onCopied,
  });

  if (!open) {
    return (
      <Button variant="ghost" className="mt-3 h-8 text-xs" disabled={disabled} onClick={() => setOpen(true)}>
        Copiar de otro proyecto
      </Button>
    );
  }

  // The project itself is never an option: copying from yourself is a 422, and an option that can
  // only produce an error is an option that should not be drawn.
  const candidates = (projects.data ?? []).filter((project) => project.id !== projectId);
  const outcome = copy.data;

  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-3">
      <div className="flex items-baseline gap-2">
        <p className="text-xs font-semibold text-slate-800">Copiar de otro proyecto</p>
        <button type="button" className="ml-auto text-[10px] text-slate-500" onClick={() => setOpen(false)}>
          cerrar
        </button>
      </div>

      <Field label="Proyecto de origen">
        <select
          className={inputClass}
          value={sourceProjectId}
          disabled={disabled}
          onChange={(event) => setSource(event.target.value)}
        >
          <option value="">Selecciona…</option>
          {candidates.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </Field>
      {projects.data && candidates.length === 0 && (
        <p className="mt-1 text-[11px] text-slate-500">No hay otro proyecto en esta organización.</p>
      )}

      <p className="mt-3 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Secciones</p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {SECTIONS.map((section) => (
          <label key={section.id} className="flex items-center gap-1 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={sections.includes(section.id)}
              disabled={disabled}
              onChange={(event) =>
                setSections((current) =>
                  event.target.checked ? [...current, section.id] : current.filter((entry) => entry !== section.id),
                )
              }
            />
            {section.label}
          </label>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-4 text-slate-400">
        Se reemplazan enteras, que es como se escriben en todas partes. «Implementadas» no está: es un hecho sobre el
        código de este proyecto, y el otro no lo ha visto nunca.
      </p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        <label className="flex items-center gap-1 text-[11px] text-slate-600">
          <input type="checkbox" checked={flows} disabled={disabled} onChange={(e) => setFlows(e.target.checked)} />
          Pruebas, flujos y suites
        </label>
        <label className="flex items-center gap-1 text-[11px] text-slate-600">
          <input
            type="checkbox"
            checked={environments}
            disabled={disabled}
            onChange={(event) => setEnvironments(event.target.checked)}
          />
          Entornos
        </label>
      </div>
      {environments && (
        // Said before anything is pressed and not afterwards: finding out that the credentials did
        // not come, from a line under a result, is finding out once the environments are already
        // there looking configured.
        <p className="mt-1 text-[11px] leading-4 text-amber-700">
          Sin credenciales y con las variables secretas vacías: un secreto no se duplica. Llegan con su nombre, y al
          acabar se dice cuáles hay que volver a escribir.
        </p>
      )}

      <Button
        className="mt-3 h-8 w-full text-xs"
        disabled={disabled || !sourceProjectId || copy.isPending}
        onClick={() => copy.mutate()}
      >
        {copy.isPending ? "Copiando…" : "Copiar"}
      </Button>

      {copy.error && (
        <p className="mt-2 text-[11px] text-rose-600">
          {copy.error instanceof ApiError ? copy.error.message : "No se pudo copiar"}
        </p>
      )}

      {outcome && (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] text-slate-600">
            {[
              outcome.sections.length && `${outcome.sections.length} secciones`,
              outcome.requestTemplates && `${outcome.requestTemplates} pruebas`,
              outcome.workflows && `${outcome.workflows} flujos`,
              outcome.suites && `${outcome.suites} suites`,
              outcome.environments && `${outcome.environments} entornos`,
            ]
              .filter(Boolean)
              .join(" · ") || "No se copió nada"}
          </p>
          {outcome.skipped.length > 0 && (
            <ul className="space-y-0.5 rounded-md bg-amber-50 p-1.5">
              {outcome.skipped.map((entry, index) => (
                <li key={index} className="text-[10px] leading-4 text-amber-800">
                  <span className="font-medium">{entry.what}</span> — {entry.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
