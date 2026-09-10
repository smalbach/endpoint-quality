import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { SECTION_EDITORS } from "@/components/config-editors";
import { unchanged } from "@/lib/config-draft";
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
 * Six of the eight have a visual editor; the other two keep a JSON textarea, and which two is a
 * judgement rather than a leftover. `scenarios` and `bodies` hold whole scenario templates and
 * whole request payloads — arbitrary JSON by definition — and a form over those is a worse JSON
 * editor than a JSON editor.
 *
 * The textarea stays reachable everywhere else too. Somebody who knows the shape should not have
 * to click through a form to paste a section, and it is the escape hatch for anything an editor
 * does not model yet.
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

  /** The contract's operation ids, so `implemented` can be a checklist instead of a list somebody
   * types from memory. */
  const operationIds = useQuery({
    queryKey: ["operation-ids", projectId, project.data?.contract?.versionId],
    enabled: Boolean(organization && projectId && project.data?.contract),
    queryFn: async () => (await api<{ operations: { id: string }[] }>(`${base}/operations`)).operations.map((operation) => operation.id),
  });

  return (
    <div className="space-y-4">
      <ImportContract base={base} contract={project.data?.contract ?? null} source={project.data?.source ?? null} disabled={!canEdit} onImported={() => queryClient.invalidateQueries()} />

      {config.data &&
        Object.entries(config.data.sections).map(([section, value]) => (
          <SectionEditor
            key={section}
            base={base}
            section={section}
            data={value}
            disabled={!canEdit}
            operationIds={operationIds.data ?? []}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ["config", projectId] })}
          />
        ))}
    </div>
  );
}

function ImportContract({
  base,
  contract,
  source,
  disabled,
  onImported,
}: {
  base: string;
  contract: ProjectSummary["contract"];
  source: ProjectSummary["source"];
  disabled: boolean;
  onImported: () => void;
}) {
  const [url, setUrl] = useState("");
  const [raw, setRaw] = useState("");
  const [header, setHeader] = useState("");

  const importSpec = useMutation({
    // `source` sin definir relee donde se leyó la última vez, con la credencial que se guardó
    // entonces. Es lo que hace que volver a leer no exija reescribir el token.
    mutationFn: (next: unknown) => api<{ operationCount: number; unchanged: boolean }>(`${base}/spec-versions`, { method: "POST", body: next ? { source: next } : {} }),
    onSuccess: () => {
      setRaw("");
      setHeader("");
      onImported();
    },
  });

  const remembered = source?.kind === "url" ? source : null;

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

      {remembered && (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <p className="truncate">
            Última lectura desde <span className="font-mono">{remembered.location}</span>
            {remembered.headersStored ? " · con una credencial guardada" : ""}
          </p>
          <Button className="mt-2" disabled={disabled || importSpec.isPending} onClick={() => importSpec.mutate(undefined)}>
            Volver a leerlo de ahí
          </Button>
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <Field label="Desde una URL" hint="Se comprueba la dirección resuelta antes de pedirla, y se vuelve a comprobar en cada redirección.">
            <input className={inputClass} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://api.example.com/openapi.json" disabled={disabled} />
          </Field>
          <Field
            label="Authorization (si el contrato está detrás de login)"
            hint="Se guarda cifrada contra esa dirección y no vuelve a salir. Basta con escribirla una vez: las siguientes lecturas la reutilizan."
          >
            <input className={inputClass} value={header} onChange={(event) => setHeader(event.target.value)} placeholder="Bearer …" disabled={disabled} />
          </Field>
          <Button
            className="mt-2"
            disabled={disabled || !url || importSpec.isPending}
            onClick={() => importSpec.mutate({ kind: "url", url, ...(header.trim() ? { headers: { Authorization: header.trim() } } : {}) })}
          >
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
  operationIds,
  onSaved,
}: {
  base: string;
  section: string;
  data: { data: unknown; configured: boolean; updatedAt: string | null };
  disabled: boolean;
  operationIds: string[];
  onSaved: () => void;
}) {
  const Editor = SECTION_EDITORS[section];
  const [open, setOpen] = useState(false);
  const [asJson, setAsJson] = useState(!Editor);
  const [draft, setDraft] = useState<Record<string, unknown>>(() => (data.data ?? {}) as Record<string, unknown>);
  const [text, setText] = useState(() => JSON.stringify(data.data, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  // A section saved elsewhere — or reset — must not leave a stale draft in the box.
  useEffect(() => {
    setDraft((data.data ?? {}) as Record<string, unknown>);
    setText(JSON.stringify(data.data, null, 2));
    setParseError(null);
  }, [data.data]);

  const save = useMutation({
    mutationFn: (body: unknown) => api<void>(`${base}/config/${section}`, { method: "PUT", body }),
    onSuccess: onSaved,
  });
  const reset = useMutation({
    mutationFn: () => api<void>(`${base}/config/${section}`, { method: "DELETE" }),
    onSuccess: onSaved,
  });

  /** Switching to JSON shows what the form built, so the two views are never out of step. */
  function toJson() {
    setText(JSON.stringify(draft, null, 2));
    setAsJson(true);
  }

  /** And switching back only works from a document that parses — a half-typed one has no form
   * to show. */
  function toForm() {
    try {
      setDraft(JSON.parse(text) as Record<string, unknown>);
      setParseError(null);
      setAsJson(false);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "JSON inválido");
    }
  }

  function submit() {
    if (!asJson) return save.mutate(draft);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setParseError(null);
      setDraft(parsed);
      save.mutate(parsed);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "JSON inválido");
    }
  }

  const dirty = asJson ? text !== JSON.stringify(data.data, null, 2) : !unchanged(draft, data.data);

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
          <div className="flex items-start gap-3">
            <p className="flex-1 text-[11px] leading-5 text-slate-500">{SECTION_HELP[section]}</p>
            {Editor && (
              <Button variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => (asJson ? toForm() : toJson())}>
                {asJson ? "Ver como formulario" : "Ver como JSON"}
              </Button>
            )}
          </div>

          <div className="mt-3">
            {Editor && !asJson ? (
              <Editor value={draft} onChange={setDraft} disabled={disabled} operationIds={operationIds} />
            ) : (
              <textarea
                className="h-64 w-full rounded-lg border border-slate-200 p-3 font-mono text-[11px] outline-none focus:border-slate-900 disabled:bg-slate-50"
                value={text}
                onChange={(event) => setText(event.target.value)}
                disabled={disabled}
                spellCheck={false}
              />
            )}
          </div>

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
            <Button disabled={disabled || save.isPending || !dirty} onClick={submit}>
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
