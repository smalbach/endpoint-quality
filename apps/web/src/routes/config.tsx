import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { ConfigView, ProjectSummary } from "@/lib/types";

const SECTION_HELP: Record<string, string> = {
  parameters: "Los valores con los que se ejercita cada filtro, y qué identificador usa un caso cuando quiere que el recurso exista o que no exista.",
  scenarios: "Los casos que solo aparecen cuando la operación acepta un conjunto de parámetros, y las operaciones que necesitan un tratamiento propio.",
  bodies: "Los payloads por operación. No se pueden derivar del contrato: tienen que respetar las claves ajenas y esquivar las naturales que ya existen.",
  authorization: "Cómo se genera la matriz 401/403 a partir de lo que el contrato declara.",
  budgets: "Los objetivos de latencia, en orden. Gana la primera regla que casa; una operación que no casa con ninguna no recibe ninguna aserción.",
  envelope: "Qué envelope se espera cuando el documento en vivo no declara schema para ese estado.",
  implemented: "Qué operaciones enruta la API hoy. Es un hecho sobre el código, no sobre el contrato: ningún schema puede derivarlo.",
  text: "El texto de los casos generados.",
};

/**
 * Importing a contract and editing the eight configuration sections.
 *
 * The editors are JSON textareas validated by the server, not visual forms. That is a deliberate
 * stopping point rather than an omission: a form per section is a week of work, the shapes are
 * still moving, and the API already answers a bad document with the exact field path that is
 * wrong — which is most of what a form would give you.
 */
export function ConfigPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ProjectSummary>(`${base}`),
  });

  const config = useQuery({
    queryKey: ["config", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ConfigView>(`${base}/config`),
  });

  return (
    <div className="space-y-4">
      <ImportContract base={base} contract={project.data?.contract ?? null} disabled={!canEdit} onImported={() => queryClient.invalidateQueries()} />

      {config.data &&
        Object.entries(config.data.sections).map(([section, value]) => (
          <SectionEditor
            key={section}
            base={base}
            section={section}
            data={value}
            disabled={!canEdit}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ["config", projectId] })}
          />
        ))}
    </div>
  );
}

function ImportContract({
  base,
  contract,
  disabled,
  onImported,
}: {
  base: string;
  contract: ProjectSummary["contract"];
  disabled: boolean;
  onImported: () => void;
}) {
  const [url, setUrl] = useState("");
  const [raw, setRaw] = useState("");

  const importSpec = useMutation({
    mutationFn: (source: unknown) => api<{ operationCount: number; unchanged: boolean }>(`${base}/spec-versions`, { method: "POST", body: { source } }),
    onSuccess: () => {
      setRaw("");
      onImported();
    },
  });

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Contrato</p>
      {contract ? (
        <p className="mt-1 text-xs text-slate-500">
          {contract.title} <span className="font-mono">v{contract.version}</span> · {contract.operationCount} operaciones · importado {formatDate(contract.importedAt)}
        </p>
      ) : (
        <p className="mt-1 text-xs text-amber-600">Todavía no hay contrato. Sin él no hay matriz.</p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <Field label="Desde una URL" hint="Se comprueba la dirección resuelta antes de pedirla, y se vuelve a comprobar en cada redirección.">
            <input className={inputClass} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://api.example.com/openapi.json" disabled={disabled} />
          </Field>
          <Button className="mt-2" disabled={disabled || !url || importSpec.isPending} onClick={() => importSpec.mutate({ kind: "url", url })}>
            Importar desde la URL
          </Button>
        </div>
        <div>
          <Field label="Pegando el documento" hint="YAML o JSON. Se guarda entero: la validación de schema durante una corrida lo lee.">
            <textarea className={`${inputClass} h-24 font-mono text-[11px]`} value={raw} onChange={(event) => setRaw(event.target.value)} disabled={disabled} />
          </Field>
          <Button className="mt-2" disabled={disabled || !raw.trim() || importSpec.isPending} onClick={() => importSpec.mutate({ kind: "inline", raw })}>
            Importar
          </Button>
        </div>
      </div>

      {importSpec.error && (
        <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <p>{(importSpec.error as Error).message}</p>
          {(importSpec.error as ApiError).fields?.map((field) => (
            <p key={field.field} className="mt-1 font-mono text-[11px]">
              {field.field}: {field.detail}
            </p>
          ))}
        </div>
      )}
      {importSpec.data && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {importSpec.data.unchanged ? "El documento no ha cambiado: se reutiliza la versión ya importada." : `Importadas ${importSpec.data.operationCount} operaciones.`}
        </p>
      )}
    </Card>
  );
}

function SectionEditor({
  base,
  section,
  data,
  disabled,
  onSaved,
}: {
  base: string;
  section: string;
  data: { data: unknown; configured: boolean; updatedAt: string | null };
  disabled: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(data.data, null, 2));
  const [open, setOpen] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // A section saved elsewhere — or reset — must not leave a stale draft in the box.
  useEffect(() => setDraft(JSON.stringify(data.data, null, 2)), [data.data]);

  const save = useMutation({
    mutationFn: (body: unknown) => api<void>(`${base}/config/${section}`, { method: "PUT", body }),
    onSuccess: onSaved,
  });
  const reset = useMutation({
    mutationFn: () => api<void>(`${base}/config/${section}`, { method: "DELETE" }),
    onSuccess: onSaved,
  });

  function submit() {
    try {
      const parsed = JSON.parse(draft) as unknown;
      setParseError(null);
      save.mutate(parsed);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "JSON inválido");
    }
  }

  return (
    <Card className="overflow-hidden">
      <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen((current) => !current)}>
        <span className="font-mono text-sm text-slate-900">{section}</span>
        {/* "Configured" and "uses the defaults" are different states: the first is a decision, the
            second is a prompt to make one. */}
        <Badge className={data.configured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}>
          {data.configured ? "configurada" : "por defecto"}
        </Badge>
        {data.updatedAt && <span className="text-[11px] text-slate-400">{formatDate(data.updatedAt)}</span>}
        <span className="ml-auto text-xs text-slate-400">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="text-[11px] leading-5 text-slate-500">{SECTION_HELP[section]}</p>
          <textarea
            className="mt-2 h-64 w-full rounded-lg border border-slate-200 p-3 font-mono text-[11px] outline-none focus:border-slate-900 disabled:bg-slate-50"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled}
            spellCheck={false}
          />
          {parseError && <p className="mt-1 text-xs text-rose-700">{parseError}</p>}
          {save.error && (
            <div className="mt-1 text-xs text-rose-700">
              <p>{(save.error as Error).message}</p>
              {(save.error as ApiError).fields?.map((field) => (
                <p key={field.field} className="font-mono text-[11px]">
                  {field.field}: {field.detail}
                </p>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button disabled={disabled || save.isPending} onClick={submit}>
              Guardar
            </Button>
            {data.configured && (
              <Button variant="ghost" disabled={disabled || reset.isPending} onClick={() => reset.mutate()} title="Borra la sección para que el proyecto vuelva a los valores por defecto del motor">
                Volver a los valores por defecto
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
