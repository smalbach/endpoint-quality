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
 * Y una más que Postman tiene fuera del import y aquí vive dentro: capturar el tráfico que pasa por
 * un proxy (`capture-traffic.tsx`), que acaba en el mismo resumen porque entra como un HAR.
 *
 * La vía de la URL lleva además **una credencial opcional**, porque un contrato interno vive detrás
 * de un gateway y sin ella «desde una URL» sólo servía para lo que ya era público; no se guarda en
 * ningún sitio, ni aquí ni en el servidor. Y lo que se importa **se puede abrir desde el resumen**:
 * antes contaba «12 nuevos» y dejaba a la persona buscándolos en la lista.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  detectImport,
  looksZipped,
  readZip,
  targetsOf,
  type Detected,
  type ImportKind,
  type ImportTarget,
} from "@eq/import-detect";

import { api, ApiError } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Modal } from "@/components/overlay";
import { CaptureTraffic } from "@/components/capture-traffic";
import { Button, Field, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import type { ImportAnythingResult, ImportedItemResult, ProjectSummary } from "@/lib/types";

/** Un fichero ya leído: es lo que cruza desde el arrastre global hasta aquí. */
export type DroppedFile = {
  name: string;
  text: string;
  /** Por qué no se pudo leer, cuando no se pudo. Un `.zip` roto es lo único que llega así. */
  reason?: string;
};

/**
 * Los ficheros elegidos o soltados, leídos — y **los `.zip` abiertos**.
 *
 * Un zip **subido** se abre aquí y no en el servidor porque lo que cruza la red en `sources` es
 * texto, y un zip metido en un JSON como si fuera texto llega con los bytes ya estropeados. Por
 * una URL sí lo abre el servidor, que es quien tiene los bytes, y con este mismo lector: `readZip`
 * de `@eq/import-detect` corre en los dos lados, así que por las dos puertas entra lo mismo.
 * Abrirlo antes deja además el resto igual: el detector, el plan y el import siguen viendo
 * ficheros sueltos.
 *
 * Vive fuera del diálogo porque el arrastre global lo necesita igual: soltar el zip en cualquier
 * parte de la ventana tiene que hacer lo mismo que elegirlo aquí dentro.
 */
export async function readDropped(files: File[]): Promise<DroppedFile[]> {
  const read = await Promise.all(
    files.map(async (file): Promise<DroppedFile[]> => {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (!looksZipped(file.name, head)) return [{ name: file.name, text: await file.text() }];
      try {
        const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
        if (entries.length) return entries;
        return [{ name: file.name, text: "", reason: "es un .zip y no trae ningún fichero de texto dentro" }];
      } catch (error) {
        return [
          {
            name: file.name,
            text: "",
            reason: `no se pudo abrir el .zip: ${error instanceof Error ? error.message : "sin detalle"}`,
          },
        ];
      }
    }),
  );
  return read.flat();
}

/**
 * «Capturar tráfico» es una pestaña más y no una puerta aparte: es un HAR grabado de otra manera, y
 * lo elegido entra por la misma puerta y acaba en el mismo resumen.
 */
type Tab = "files" | "text" | "url" | "capture";

/**
 * La credencial con la que leer la URL, tal como se pide en pantalla.
 *
 * `none` es una opción de verdad y no un hueco vacío: la mayoría de los enlaces que se pegan aquí
 * son públicos, y enseñar dos campos de secreto a quien no los necesita es enseñar dos campos que
 * hay que entender antes de importar.
 */
type UrlAuth = { kind: "none" | "bearer" | "header"; token: string; name: string; value: string };
const NO_AUTH: UrlAuth = { kind: "none", token: "", name: "", value: "" };

/**
 * Cuántos endpoints recién creados se enlazan de uno en uno.
 *
 * Una colección de verdad trae cuarenta o cien, y cien enlaces no son una lista: son una pared que
 * hay que leer para no encontrar nada. Los primeros cinco cubren el caso por el que existe esto
 * —«acabo de importar, llévame a uno y lo miro»— y el resto va donde están todos, que es la lista
 * de endpoints del proyecto con su buscador.
 */
const LINKED_ENDPOINTS = 5;

/** Cómo se llama cada formato en pantalla. Las mismas palabras que usa el servidor. */
const KIND_LABEL: Record<ImportKind, string> = {
  "postman-collection": "Colección de Postman",
  "postman-environment": "Entorno de Postman",
  "postman-dump": "Volcado de Postman",
  openapi: "OpenAPI",
  insomnia: "Insomnia",
  curl: "Comandos cURL",
  har: "Grabación del navegador (HAR)",
  "eq-bundle": "Proyecto exportado de aquí",
  unknown: "No reconocido",
};
const TARGET_LABEL: Record<string, string> = {
  contract: "el contrato",
  endpoints: "endpoints",
  collections: "una colección",
  flows: "flujos",
  environment: "un entorno",
  project: "todo el proyecto",
};

/**
 * Un import acotado a un solo destino: cómo se llama en pantalla y qué se dice de lo que no cabe.
 *
 * Existe porque la puerta única no puede ser una puerta ciega. Abrirla desde los entornos y que
 * acepte un OpenAPI —que escribe el contrato y cuarenta endpoints— es una sorpresa cara de
 * deshacer. Acotada, lee lo mismo y **escribe sólo el destino que se pidió**: de un volcado de
 * Postman entran sus entornos y nada más, y lo que no cabe se dice antes de importar, no después.
 */
const SCOPES: Record<ImportTarget, { title: string; description: string; noun: string; plural: string }> = {
  environment: {
    title: "Importar entornos",
    description:
      "Un entorno de Postman, o el volcado donde están todos. Sólo entran entornos: lo demás que traiga el fichero se queda fuera.",
    noun: "un entorno",
    plural: "entornos",
  },
  contract: { title: "Importar el contrato", description: "", noun: "un contrato", plural: "contratos" },
  endpoints: { title: "Importar endpoints", description: "", noun: "un endpoint", plural: "endpoints" },
  collections: { title: "Importar colecciones", description: "", noun: "una colección", plural: "colecciones" },
  flows: { title: "Importar flujos", description: "", noun: "un flujo", plural: "flujos" },
  project: { title: "Importar un proyecto", description: "", noun: "un proyecto", plural: "proyectos" },
};

export function ImportDialog({
  projectId,
  initial,
  only,
  onClose,
  onImported,
}: {
  /** El proyecto en el que se está. Sin él, se pregunta a cuál va. */
  projectId?: string;
  initial: DroppedFile[];
  /**
   * El único destino que este import puede escribir, cuando se abre desde una pantalla que manda
   * uno solo. Sin él es la puerta general, que escribe lo que traiga cada fichero.
   */
  only?: ImportTarget;
  onClose: () => void;
  onImported: () => void;
}) {
  const organization = useOrganization();
  const [tab, setTab] = useState<Tab>("files");
  const [files, setFiles] = useState<DroppedFile[]>(initial);
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<UrlAuth>(NO_AUTH);
  const [baseUrl, setBaseUrl] = useState("");
  const [target, setTarget] = useState(projectId ?? "");
  const [dragging, setDragging] = useState(false);
  const [captured, setCaptured] = useState<ImportAnythingResult | null>(null);
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
    if (tab === "files")
      return files.map((file) =>
        file.reason
          ? { kind: "unknown" as const, name: file.name, pieces: [], reason: file.reason }
          : detectImport(file.name, file.text),
      );
    if (tab === "text" && pasted.trim()) return [detectImport("", pasted)];
    return [];
  }, [tab, files, pasted]);

  /**
   * Lo reconocido que este import puede escribir. Acotado, un volcado se queda con sus entornos y
   * un OpenAPI se queda sin nada — y lo dice con las palabras del destino, no con un «no vale».
   */
  const usable = useMemo<Detected[]>(() => {
    if (!only) return found;
    const scope = SCOPES[only];
    return found.map((entry) => {
      const pieces = entry.pieces.filter((piece) => targetsOf(piece.kind).includes(only));
      if (pieces.length === entry.pieces.length) return entry;
      return {
        ...entry,
        pieces,
        reason: pieces.length ? entry.reason : `no trae ${scope.noun}: aquí sólo entran ${scope.plural}`,
      };
    });
  }, [found, only]);

  const readable = usable.some((entry) => entry.pieces.length);
  const environments = usable.some((entry) => entry.pieces.some((piece) => piece.kind === "postman-environment"));
  /** Acotado, lo que cruza la red son las piezas que caben, no el fichero entero que las traía. */
  const pieces = usable.flatMap((entry) => entry.pieces.map((piece) => ({ name: piece.name, text: piece.text })));

  const run = useMutation({
    mutationFn: () =>
      api<ImportAnythingResult>(`/orgs/${organization?.id}/projects/${target}/import`, {
        method: "POST",
        body: {
          ...(only ? { sources: pieces } : {}),
          ...(!only && tab === "url" ? { url: url.trim(), ...urlAuthBody(auth) } : {}),
          ...(!only && tab === "text" && pasted.trim() ? { sources: [{ name: "", text: pasted }] } : {}),
          ...(!only && tab === "files" && files.length
            ? { sources: files.filter((file) => !file.reason).map((file) => ({ name: file.name, text: file.text })) }
            : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        },
      }),
    onSuccess: () => onImported(),
  });

  const ready =
    Boolean(target) &&
    (only
      ? readable
      : tab === "url"
        ? Boolean(url.trim()) && authReady(auth)
        : tab === "text"
          ? Boolean(pasted.trim())
          : readable);

  /**
   * Las vías de entrada. Acotado quedan las dos cuyo contenido se lee **aquí**, antes de mandar
   * nada: por una URL lo lee el servidor, y prometer «sólo entornos» sobre algo que este lado no
   * ha visto es una promesa que no se puede cumplir. La captura tampoco: un HAR son endpoints.
   */
  const tabs: readonly (readonly [Tab, string])[] = only
    ? ([
        ["files", "Ficheros"],
        ["text", "Texto sin formato"],
      ] as const)
    : ([
        ["files", "Ficheros"],
        ["text", "Texto sin formato"],
        ["url", "Desde una URL"],
        ["capture", "Capturar tráfico"],
      ] as const);

  const take = async (picked: FileList | File[]) => {
    const read = await readDropped([...picked]);
    // Se acumulan: soltar tres y luego dos más es traerlos todos, no quedarse con los últimos.
    setFiles((current) => [...current, ...read.filter((entry) => !current.some((had) => had.name === entry.name))]);
    run.reset();
  };

  return (
    <Modal
      title={only ? SCOPES[only].title : "Importar"}
      description={
        only
          ? SCOPES[only].description
          : "Ficheros, una carpeta, un texto pegado, un enlace o el tráfico que pase por un proxy. Se reconoce qué es cada cosa antes de escribir nada."
      }
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
          {tabs.map(([value, label]) => (
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
              {only === "environment"
                ? "Arrastra aquí el entorno de Postman, o el volcado donde están todos."
                : "Arrastra aquí la colección, sus entornos o el volcado completo de Postman."}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {only === "environment"
                ? "El `.zip` de «Export data» se abre aquí mismo y se queda con sus entornos: sus colecciones no entran por esta puerta."
                : "El `.zip` de «Export data» se abre aquí mismo. También un OpenAPI (JSON o YAML), una exportación de Insomnia, un fichero con comandos cURL o un proyecto exportado de aquí."}
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
              hint={
                only === "environment"
                  ? "El JSON del entorno, tal como lo exporta Postman."
                  : "El JSON de una colección o de un entorno, un OpenAPI en YAML, o un puñado de comandos curl."
              }
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
          <div className="mt-3 space-y-3">
            <Field
              label="URL"
              hint="Se comprueba la dirección resuelta antes de pedirla, y se vuelve a comprobar en cada redirección. Lo que conteste se reconoce igual que un fichero, y un .zip se abre solo."
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

            {/* Un contrato interno o una colección de un repositorio privado están detrás de un
                gateway, así que sin esto «desde una URL» sólo servía para lo que ya era público.
                Se dice en el sitio donde se escribe lo que pasa con el secreto: se usa para esta
                petición y no se guarda en ninguna parte. */}
            <Field
              label="Autenticación (opcional)"
              hint="Para una URL que no es pública. No se guarda: se usa para esta petición y se olvida, así que un import de la misma URL mañana la pedirá otra vez."
            >
              <select
                className={inputClass}
                aria-label="Autenticación de la URL"
                value={auth.kind}
                onChange={(event) => {
                  setAuth({ ...NO_AUTH, kind: event.target.value as UrlAuth["kind"] });
                  run.reset();
                }}
              >
                <option value="none">Ninguna</option>
                <option value="bearer">Token bearer</option>
                <option value="header">Una cabecera</option>
              </select>
            </Field>

            {auth.kind === "bearer" && (
              <Field label="Token">
                <input
                  className={inputClass}
                  type="password"
                  aria-label="Token bearer"
                  value={auth.token}
                  placeholder="el token, sin «Bearer» delante"
                  onChange={(event) => setAuth({ ...auth, token: event.target.value })}
                />
              </Field>
            )}

            {auth.kind === "header" && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Cabecera">
                  <input
                    className={inputClass}
                    aria-label="Nombre de la cabecera"
                    value={auth.name}
                    placeholder="X-API-Key"
                    onChange={(event) => setAuth({ ...auth, name: event.target.value })}
                  />
                </Field>
                <Field label="Valor">
                  <input
                    className={inputClass}
                    type="password"
                    aria-label="Valor de la cabecera"
                    value={auth.value}
                    onChange={(event) => setAuth({ ...auth, value: event.target.value })}
                  />
                </Field>
              </div>
            )}
          </div>
        )}

        {tab === "capture" && !captured && target && (
          <CaptureTraffic
            projectId={target}
            onResult={(result) => {
              setCaptured(result);
              onImported();
            }}
          />
        )}

        {/* Lo reconocido, mientras sueltas y sin preguntar a nadie. */}
        {!run.data && usable.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {usable.map((entry, index) => (
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
        {run.data && <Done result={run.data} projectId={target} onClose={onClose} />}
        {tab === "capture" && captured && <Done result={captured} projectId={target} onClose={onClose} />}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" className="h-8 text-xs" onClick={onClose}>
            {run.data || captured ? "Cerrar" : "Cancelar"}
          </Button>
          {/* La captura tiene su propio botón, junto a la lista de lo que se elige. */}
          {!run.data && tab !== "capture" && (
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

/** Con qué se puede importar ya: un bearer necesita su token, y una cabecera sus dos partes. */
function authReady(auth: UrlAuth): boolean {
  if (auth.kind === "bearer") return Boolean(auth.token.trim());
  if (auth.kind === "header") return Boolean(auth.name.trim() && auth.value);
  return true;
}

/**
 * La credencial, en el cuerpo de la petición y en ningún otro sitio.
 *
 * No se guarda en el navegador —ni en `localStorage`, ni en la caché de la consulta— por el mismo
 * motivo por el que el servidor no la guarda en una tabla: es el secreto de un tercero y sólo hace
 * falta para esta petición. El estado vive en el diálogo y se va con él.
 */
function urlAuthBody(auth: UrlAuth): { urlAuth?: { kind: string; token?: string; name?: string; value?: string } } {
  if (auth.kind === "bearer") return { urlAuth: { kind: "bearer", token: auth.token.trim() } };
  if (auth.kind === "header") return { urlAuth: { kind: "header", name: auth.name.trim(), value: auth.value } };
  return {};
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
function Done({
  result,
  projectId,
  onClose,
}: {
  result: ImportAnythingResult;
  projectId: string;
  onClose: () => void;
}) {
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[11px] font-medium text-slate-600">Esto es lo que se hizo:</p>
      {result.items.map((item, index) => (
        <Item key={index} item={item} projectId={projectId} onClose={onClose} />
      ))}
    </div>
  );
}

function Item({ item, projectId, onClose }: { item: ImportedItemResult; projectId: string; onClose: () => void }) {
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
          {entry.endpoints && entry.endpoints.length > 0 && (
            <Created endpoints={entry.endpoints} projectId={projectId} onClose={onClose} />
          )}
          {entry.collectionId && (
            <Link
              to={`/p/${projectId}/collections/${entry.collectionId}`}
              className="mt-0.5 inline-block text-[11px] text-sky-700 underline"
              onClick={onClose}
            >
              Abrir la colección
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Los endpoints que acaba de crear este import, para ir a uno.
 *
 * Es el final del camino que faltaba: el resumen decía «12 nuevos» y ahí se acababa, así que para
 * ver uno había que cerrar el diálogo, ir a la lista y buscarlo entre los que ya estaban — el paso
 * que el import venía a quitar.
 *
 * El diálogo se cierra al pulsar porque navegar debajo de un modal abierto deja a alguien mirando
 * la pantalla que acaba de tapar.
 */
function Created({
  endpoints,
  projectId,
  onClose,
}: {
  endpoints: NonNullable<ImportedItemResult["results"][number]["endpoints"]>;
  projectId: string;
  onClose: () => void;
}) {
  const rest = endpoints.length - LINKED_ENDPOINTS;
  return (
    <ul className="mt-1 space-y-0.5">
      {endpoints.slice(0, LINKED_ENDPOINTS).map((endpoint) => (
        <li key={endpoint.id}>
          <Link
            to={`/p/${projectId}/endpoints/${endpoint.id}`}
            onClick={onClose}
            className="font-mono text-[11px] text-slate-600 underline decoration-slate-300 hover:text-slate-900"
          >
            {endpoint.method} {endpoint.path}
          </Link>
        </li>
      ))}
      {rest > 0 && (
        <li>
          {/* La lista del proyecto es su pantalla de inicio, y es donde está su buscador: con
              cuarenta endpoints nuevos, encontrar uno se hace ahí y no en esta lista. */}
          <Link to={`/p/${projectId}`} onClick={onClose} className="text-[11px] text-slate-500 hover:text-slate-900">
            y {rest} más, en la lista de endpoints →
          </Link>
        </li>
      )}
    </ul>
  );
}
