/**
 * Importar: una sola puerta, y lo que has soltado nombrado al instante.
 *
 * Dos cosas separaban esto del import de Postman, y las dos están aquí.
 *
 * **La primera: reconocer lo soltado sin preguntar al servidor.** El plan lo pedía en seco al
 * servidor, así que había que pulsar «Continuar», esperar y luego «Importar» — dos botones y un
 * viaje de red para saber lo que el fichero ya dice en su primera línea. La detección vive ahora
 * en `@eq/import-detect`, que importan el navegador y el servidor, así que la lista aparece
 * mientras sueltas y el import es **un botón**. Y como es la misma función en los dos lados, el
 * plan no puede prometer una cosa y el import hacer otra.
 *
 * **La segunda: dónde está.** Estaba en un botón fantasma dentro de la barra de un proyecto, que
 * es invisible y además no existe en la lista de proyectos. Ahora está arriba en la cabecera, en
 * todas las pantallas, con Cmd+O y aceptando ficheros soltados en cualquier parte de la ventana
 * (eso vive en `import-provider.tsx`). Fuera de un proyecto pregunta a cuál, que es lo que hace
 * Postman con el workspace.
 *
 * Cuatro vías de entrada, las mismas que importan aquí: ficheros, una carpeta entera, texto pegado
 * y una URL. La quinta de Postman —un repositorio— ya es otra cosa en este producto: el Escáner.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { detectImport, targetsOf, type Detected, type ImportKind } from "@eq/import-detect";

import { api, ApiError } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Modal } from "@/components/overlay";
import { Button, Field, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import type { ImportAnythingResult, ImportedItemResult, ProjectSummary } from "@/lib/types";

/** Un fichero ya leído: es lo que cruza desde el arrastre global hasta aquí. */
export type DroppedFile = { name: string; text: string };

type Tab = "files" | "text" | "url";

/** Cómo se llama cada formato en pantalla. Las mismas palabras que usa el servidor. */
const KIND_LABEL: Record<ImportKind, string> = {
  "postman-collection": "Colección de Postman",
  "postman-environment": "Entorno de Postman",
  "postman-dump": "Volcado de Postman",
  openapi: "OpenAPI",
  insomnia: "Insomnia",
  curl: "Comandos cURL",
  "eq-bundle": "Proyecto exportado de aquí",
  unknown: "No reconocido",
};
const TARGET_LABEL: Record<string, string> = {
  contract: "el contrato",
  endpoints: "endpoints",
  flows: "flujos",
  environment: "un entorno",
  project: "todo el proyecto",
};

export function ImportDialog({
  projectId,
  initial,
  onClose,
  onImported,
}: {
  /** El proyecto en el que se está. Sin él, se pregunta a cuál va. */
  projectId?: string;
  initial: DroppedFile[];
  onClose: () => void;
  onImported: () => void;
}) {
  const organization = useOrganization();
  const [tab, setTab] = useState<Tab>("files");
  const [files, setFiles] = useState<DroppedFile[]>(initial);
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [target, setTarget] = useState(projectId ?? "");
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  // Fuera de un proyecto hay que elegir uno, así que la lista hace falta; dentro, no se pide.
  const projects = useQuery({
    queryKey: ["projects", organization?.id],
    enabled: !projectId && Boolean(organization),
    queryFn: () => api<ProjectSummary[]>(`/orgs/${organization!.id}/projects`),
  });
  useEffect(() => {
    if (!projectId && !target && projects.data?.length) setTarget(projects.data[0].id);
  }, [projectId, target, projects.data]);

  /** Lo soltado, reconocido aquí mismo. Vacío en la pestaña de URL: eso lo lee el servidor. */
  const found = useMemo<Detected[]>(() => {
    if (tab === "files") return files.map((file) => detectImport(file.name, file.text));
    if (tab === "text" && pasted.trim()) return [detectImport("", pasted)];
    return [];
  }, [tab, files, pasted]);

  const readable = found.some((entry) => entry.pieces.length);
  const environments = found.some((entry) => entry.pieces.some((piece) => piece.kind === "postman-environment"));

  const run = useMutation({
    mutationFn: () =>
      api<ImportAnythingResult>(`/orgs/${organization?.id}/projects/${target}/import`, {
        method: "POST",
        body: {
          ...(tab === "url" ? { url: url.trim() } : {}),
          ...(tab === "text" && pasted.trim() ? { sources: [{ name: "", text: pasted }] } : {}),
          ...(tab === "files" && files.length ? { sources: files } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        },
      }),
    onSuccess: () => onImported(),
  });

  const ready =
    Boolean(target) && (tab === "url" ? Boolean(url.trim()) : tab === "text" ? Boolean(pasted.trim()) : readable);

  const take = async (picked: FileList | File[]) => {
    const read = await Promise.all([...picked].map(async (file) => ({ name: file.name, text: await file.text() })));
    // Se acumulan: soltar tres y luego dos más es traerlos todos, no quedarse con los últimos.
    setFiles((current) => [...current, ...read.filter((entry) => !current.some((had) => had.name === entry.name))]);
    run.reset();
  };

  return (
    <Modal
      title="Importar"
      description="Ficheros, una carpeta, un texto pegado o un enlace. Se reconoce qué es cada cosa antes de escribir nada."
      onClose={onClose}
      size="lg"
    >
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          setTab("files");
          if (event.dataTransfer.files.length) void take(event.dataTransfer.files);
        }}
      >
        {!projectId && (
          <div className="mb-3">
            <Field label="Proyecto" hint="Todo lo que se importe cae aquí: su contrato, sus endpoints y sus flujos.">
              <select className={inputClass} value={target} onChange={(event) => setTarget(event.target.value)}>
                {!projects.data?.length && <option value="">{projects.isPending ? "…" : "No hay proyectos"}</option>}
                {projects.data?.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="flex gap-1 border-b border-slate-200">
          {(
            [
              ["files", "Ficheros"],
              ["text", "Texto sin formato"],
              ["url", "Desde una URL"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setTab(value);
                run.reset();
              }}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === value
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "files" && (
          <div
            className={cn(
              "mt-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragging ? "border-slate-900 bg-slate-50" : "border-slate-200",
            )}
          >
            <p className="text-xs text-slate-600">
              Arrastra aquí la colección, sus entornos o el volcado completo de Postman.
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              También un OpenAPI (JSON o YAML), una exportación de Insomnia, un fichero con comandos cURL o un proyecto
              exportado de aquí.
            </p>
            <input
              ref={filePicker}
              type="file"
              multiple
              aria-label="Ficheros a importar"
              className="hidden"
              onChange={(event) => event.target.files && void take(event.target.files)}
            />
            {/* Una carpeta entera, como Postman: lo que se guarda en un repositorio de colecciones
                es un directorio, y elegir sus ficheros de uno en uno no es tarea para nadie. */}
            <input
              ref={folderPicker}
              type="file"
              aria-label="Carpeta a importar"
              className="hidden"
              // @ts-expect-error -- no está en los tipos de React y lo implementan todos los navegadores.
              webkitdirectory="true"
              onChange={(event) => event.target.files && void take(event.target.files)}
            />
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button variant="ghost" className="h-8 text-xs" onClick={() => filePicker.current?.click()}>
                Elegir ficheros
              </Button>
              <Button variant="ghost" className="h-8 text-xs" onClick={() => folderPicker.current?.click()}>
                Elegir una carpeta
              </Button>
            </div>
          </div>
        )}

        {tab === "text" && (
          <div className="mt-3">
            <Field
              label="Pega lo que tengas"
              hint="El JSON de una colección o de un entorno, un OpenAPI en YAML, o un puñado de comandos curl."
            >
              <textarea
                className={`${inputClass} h-40 font-mono text-[11px]`}
                value={pasted}
                spellCheck={false}
                onChange={(event) => {
                  setPasted(event.target.value);
                  run.reset();
                }}
              />
            </Field>
          </div>
        )}

        {tab === "url" && (
          <div className="mt-3">
            <Field
              label="URL"
              hint="Se comprueba la dirección resuelta antes de pedirla, y se vuelve a comprobar en cada redirección. Lo que conteste se reconoce igual que un fichero."
            >
              <input
                className={inputClass}
                value={url}
                placeholder="https://api.ejemplo.com/openapi.json"
                onChange={(event) => {
                  setUrl(event.target.value);
                  run.reset();
                }}
              />
            </Field>
          </div>
        )}

        {/* Lo reconocido, mientras sueltas y sin preguntar a nadie. */}
        {!run.data && found.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {found.map((entry, index) => (
              <Recognised
                key={`${entry.name}-${index}`}
                entry={entry}
                filename={tab === "files" ? files[index]?.name : undefined}
                onRemove={tab === "files" ? () => setFiles(files.filter((_, at) => at !== index)) : undefined}
              />
            ))}
          </ul>
        )}

        {environments && !run.data && (
          <div className="mt-3">
            <Field
              label="URL base de los entornos (opcional)"
              hint="Vacío usa la del fichero. Un entorno de Postman apunta casi siempre a localhost, que no siempre es donde esta API puede llegar."
            >
              <input
                className={inputClass}
                value={baseUrl}
                placeholder="http://host.docker.internal:8000"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
          </div>
        )}

        {run.error && <Problem error={run.error} />}
        {run.data && <Done result={run.data} />}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" className="h-8 text-xs" onClick={onClose}>
            {run.data ? "Cerrar" : "Cancelar"}
          </Button>
          {!run.data && (
            <Button className="h-8 text-xs" disabled={!ready || run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? "Importando…" : "Importar"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Una cosa soltada: qué es, qué trae dentro y a dónde va. Todo dicho aquí, sin viaje de red. */
function Recognised({ entry, filename, onRemove }: { entry: Detected; filename?: string; onRemove?: () => void }) {
  const unreadable = !entry.pieces.length;
  const targets = [...new Set(entry.pieces.flatMap((piece) => targetsOf(piece.kind)))];
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-lg border bg-white p-2",
        unreadable ? "border-amber-200 bg-amber-50/40" : "border-slate-200",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs">
          <span className="font-medium text-slate-800">{entry.name}</span>{" "}
          <span className={cn("text-[11px]", unreadable ? "text-amber-700" : "text-slate-500")}>
            {KIND_LABEL[entry.kind]}
          </span>
        </p>
        {filename && filename !== entry.name && (
          <p className="truncate font-mono text-[10px] text-slate-400">{filename}</p>
        )}
        {entry.reason && <p className="mt-0.5 text-[11px] leading-4 text-amber-800">{entry.reason}</p>}

        {/* Un volcado trae varias cosas dentro, y cada una va a su sitio. Una colección suelta
            también se enseña con lo suyo: «una colección» no dice si trae tres peticiones o
            sesenta, y esa es justo la pregunta de quien está mirando. */}
        {entry.pieces.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {entry.pieces.map((piece, index) => (
              <li key={index} className="truncate text-[11px] text-slate-500">
                · {piece.name}{" "}
                {entry.kind === "postman-dump" && <span className="text-slate-400">{KIND_LABEL[piece.kind]}</span>}{" "}
                {piece.detail && <span className="text-slate-400">{piece.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {targets.length > 0 && (
          <p className="mt-1 text-[11px] text-slate-500">
            Va a {targets.map((target) => TARGET_LABEL[target]).join(", ")}.
          </p>
        )}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Quitar ${entry.name}`}
          className="shrink-0 rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          ×
        </button>
      )}
    </li>
  );
}

function Problem({ error }: { error: unknown }) {
  const problem = error instanceof ApiError ? error : null;
  return (
    <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
      <p>{problem ? problem.message : "No se pudo importar"}</p>
      {problem?.fields.map((field, index) => (
        <p key={index} className="mt-0.5 text-[11px]">
          {field.detail}
        </p>
      ))}
    </div>
  );
}

/** Lo que se hizo, por destino. La misma lista de antes, con lo que escribió cada uno. */
function Done({ result }: { result: ImportAnythingResult }) {
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[11px] font-medium text-slate-600">Esto es lo que se hizo:</p>
      {result.items.map((item, index) => (
        <Item key={index} item={item} />
      ))}
    </div>
  );
}

function Item({ item }: { item: ImportedItemResult }) {
  const unreadable = item.kind === "unknown" || (!item.pieces.length && !item.results.length);
  return (
    <div className={cn("rounded-md border bg-white p-2", unreadable ? "border-amber-200" : "border-slate-200")}>
      <p className="text-xs">
        <span className="font-medium text-slate-800">{item.name}</span>{" "}
        <span className={cn("text-[11px]", unreadable ? "text-amber-700" : "text-slate-500")}>
          {KIND_LABEL[item.kind]}
        </span>
      </p>
      {item.reason && <p className="mt-0.5 text-[11px] leading-4 text-amber-800">{item.reason}</p>}

      {item.results.map((entry, index) => (
        <div key={index} className="mt-1 text-[11px]">
          <span className={entry.error ? "text-rose-700" : "text-slate-600"}>
            <span className="font-medium">{TARGET_LABEL[entry.target]}</span> — {entry.error ?? entry.summary}
          </span>
          {entry.notes && entry.notes.length > 0 && (
            <ul className="mt-0.5 space-y-0.5 rounded bg-amber-50 p-1">
              {entry.notes.map((note, position) => (
                <li key={position} className="text-[11px] leading-4 text-amber-800">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
