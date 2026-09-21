/**
 * La documentación publicada de este proyecto: la URL que la enseña a quien no tiene cuenta aquí.
 *
 * Lo primero que se ve es **si esa página va a documentar algo**: «12 rutas, 3 con descripción». Una
 * documentación de rutas sin descripción es una lista de paths, y descubrirlo después de mandar el
 * enlace a otro equipo es peor que no mandarlo.
 *
 * Al crear hay **dos** decisiones y ninguna viene marcada de la manera cómoda. Quién puede leerla
 * —sin valor por defecto— y si salen los cuerpos de ejemplo, que empieza apagado: publicar la forma
 * de una API es una cosa y publicar sus datos es otra.
 *
 * La URL base se escribe aquí y no se coge del entorno activo. Hay un botón para copiar la del
 * proyecto, y hace falta pulsarlo: así el valor que va a salir publicado se ve antes de salir.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { DeleteDialog, LifecycleRowActions, LifecycleTabs, stateQuery } from "@/components/lifecycle";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/format";
import type { DocSiteListView, DocSiteView, IssuedDocSiteView, LifecycleState, ProjectSummary } from "@/lib/types";

const MAX_BASE_URL = 300;

/**
 * La URL de la página publicada.
 *
 * Es del **navegador** y no de la API: lo que se le manda a una persona es la página, que vive en
 * este mismo origen. La dirección que consume una máquina es la de `/api/shared/docs/...`, y la
 * enseña la propia página. El prefijo lo dice el servidor.
 */
const docUrl = (prefix: string, publicId: string) =>
  new URL(`${prefix}/${publicId}`, window.location.origin).toString();

export function DocSitesPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const client = useQueryClient();
  const toast = useToast();
  const base = `/orgs/${organization?.id}/projects/${projectId}/doc-sites`;

  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ name: string; apiKey: string } | null>(null);
  const [deleting, setDeleting] = useState<{ site: DocSiteView; purge: boolean } | null>(null);
  /** Qué lista se está mirando: las publicadas, las archivadas o la papelera. */
  const [state, setState] = useState<LifecycleState>("active");

  const list = useQuery({
    queryKey: ["doc-sites", projectId, state],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<DocSiteListView>(`${base}${stateQuery(state)}`),
  });

  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ProjectSummary>(`/orgs/${organization?.id}/projects/${projectId}`),
  });

  const refresh = () => client.invalidateQueries({ queryKey: ["doc-sites", projectId] });

  const rotate = useMutation({
    mutationFn: (site: DocSiteView) => api<IssuedDocSiteView>(`${base}/${site.id}/key`, { method: "POST", body: {} }),
    onSuccess: async (result) => {
      await refresh();
      if (result.apiKey) setIssued({ name: result.site.name, apiKey: result.apiKey });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (site: DocSiteView) =>
      api<DocSiteView>(`${base}/${site.id}`, { method: "PATCH", body: { enabled: !site.enabled } }),
    onSuccess: async (_result, site) => {
      await refresh();
      toast.success(site.enabled ? `«${site.name}» despublicada` : `«${site.name}» publicada`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleExamples = useMutation({
    mutationFn: (site: DocSiteView) =>
      api<DocSiteView>(`${base}/${site.id}`, { method: "PATCH", body: { includeExamples: !site.includeExamples } }),
    onSuccess: async (_result, site) => {
      await refresh();
      toast.success(site.includeExamples ? "Los ejemplos ya no salen" : "Los ejemplos salen en la página");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const archive = useMutation({
    mutationFn: ({ site, archived }: { site: DocSiteView; archived: boolean }) =>
      api<DocSiteView>(`${base}/${site.id}/archived`, { method: "PATCH", body: { archived } }),
    onSuccess: async (_result, { site, archived }) => {
      setDeleting(null);
      await refresh();
      toast.success(archived ? `«${site.name}» archivada` : `«${site.name}» desarchivada`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const restore = useMutation({
    mutationFn: (site: DocSiteView) => api<DocSiteView>(`${base}/${site.id}/restore`, { method: "POST" }),
    onSuccess: async (_result, site) => {
      await refresh();
      toast.success(`«${site.name}» restaurada`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: ({ site, purge }: { site: DocSiteView; purge: boolean }) =>
      api<void>(`${base}/${site.id}${purge ? "?purge=true" : ""}`, { method: "DELETE" }),
    onSuccess: async (_result, { site, purge }) => {
      setDeleting(null);
      await refresh();
      toast.success(purge ? `«${site.name}» eliminada para siempre` : `«${site.name}» eliminada`);
    },
    onError: (error: Error) => {
      setDeleting(null);
      toast.error(error.message);
    },
  });

  const coverage = list.data?.coverage;
  const prefix = list.data?.prefix ?? "/docs";
  const sites = list.data?.sites ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Documentación</h1>
          <p className="mt-1 max-w-xl text-xs text-slate-500">
            Una página con los endpoints de este proyecto, para alguien que no tiene cuenta aquí. Lleva los parámetros,
            las cabeceras y el código para llamarla en dieciséis lenguajes.
          </p>
        </div>
        {canEdit && <Button onClick={() => setCreating(true)}>Publicar</Button>}
      </div>

      <LifecycleTabs state={state} onState={setState} gender="f" />

      {coverage && (
        <Card className="p-4">
          <p className="text-sm text-slate-800">
            <span className="font-semibold">{coverage.described}</span> de {coverage.endpoints} rutas activas tienen
            descripción, y {coverage.withExamples} tienen algún ejemplo guardado.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {coverage.described === 0
              ? "Sin descripciones, la página es una lista de paths: quien la lea sabrá qué rutas hay y no qué hacen. Se escriben en el editor de cada endpoint."
              : "Lo que no tenga descripción saldrá con su ruta, su método y sus parámetros, y nada más."}
          </p>
        </Card>
      )}

      {sites.length === 0 ? (
        <Empty
          title={list.isPending ? "…" : "Sin publicar"}
          hint="Nada de este proyecto se publica hasta que se crea una página a mano, y hay que elegir quién puede leerla."
        />
      ) : (
        <div className="space-y-2">
          {sites.map((site) => (
            <Card key={site.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">{site.name}</p>
                <Badge
                  className={
                    site.visibility === "public"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-slate-200 bg-slate-50 text-slate-600"
                  }
                >
                  {site.visibility === "public" ? "pública" : "privada"}
                </Badge>
                {site.includeExamples && (
                  <Badge className="border-slate-200 bg-slate-50 text-slate-600">con ejemplos</Badge>
                )}
                {!site.enabled && <Badge className="border-slate-200 bg-slate-100 text-slate-500">despublicada</Badge>}
                {site.archivedAt && (
                  <Badge className="border-amber-200 bg-amber-50 text-amber-700">archivada</Badge>
                )}
                {site.deletedAt && (
                  <Badge className="border-rose-200 bg-rose-50 text-rose-700">
                    eliminada {formatDate(site.deletedAt)}
                  </Badge>
                )}
                <span className="ml-auto text-[11px] text-slate-400">creada {formatDate(site.createdAt)}</span>
              </div>

              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100">
                  {docUrl(prefix, site.publicId)}
                </code>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    void navigator.clipboard?.writeText(docUrl(prefix, site.publicId));
                    toast.success("URL copiada");
                  }}
                >
                  Copiar
                </Button>
                <a
                  href={docUrl(prefix, site.publicId)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-md px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                >
                  Abrir
                </a>
              </div>

              <p className="text-[11px] text-slate-500">
                {site.visibility === "public"
                  ? "Cualquiera con esta URL puede leer la forma de esta API. Lo único que la protege es que no se adivina, y la página lleva «noindex» para que no acabe en un buscador."
                  : `Pide la cabecera x-api-key. La de ahora acaba en ${site.apiKeyPreview || "…"}.`}
              </p>
              {!site.baseUrl && (
                <p className="text-[11px] text-amber-700">
                  Sin URL base, la página enseña las rutas sin host y el código de ejemplo no se puede pegar tal cual.
                </p>
              )}

              {canEdit && (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  {/* Publicar y despublicar solo valen sobre una viva: lo archivado y lo eliminado
                      ya no sirve la página, y ofrecer «Publicar» ahí sería mentir. */}
                  {state === "active" && (
                    <>
                      <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => toggle.mutate(site)}>
                        {site.enabled ? "Despublicar" : "Publicar"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => toggleExamples.mutate(site)}
                      >
                        {site.includeExamples ? "Quitar los ejemplos" : "Incluir los ejemplos"}
                      </Button>
                      {site.visibility === "private" && (
                        <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => rotate.mutate(site)}>
                          Nueva clave
                        </Button>
                      )}
                    </>
                  )}
                  <LifecycleRowActions
                    className="ml-auto"
                    state={state}
                    pending={archive.isPending || restore.isPending || remove.isPending}
                    onArchive={(archived) => archive.mutate({ site, archived })}
                    onRestore={() => restore.mutate(site)}
                    onDelete={() => setDeleting({ site, purge: false })}
                    onPurge={() => setDeleting({ site, purge: true })}
                  />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Card className="space-y-2 p-4 text-[11px] text-slate-500">
        <p className="text-xs font-semibold text-slate-800">Qué no sale nunca en la página</p>
        <p>
          El token de la autenticación de un endpoint, sus scripts, y el valor de cualquier cabecera que sea una
          credencial —de esas sale el nombre, que es lo que documenta—. Las variables se quedan escritas como{" "}
          <code className="font-mono text-slate-700">{"{{variable}}"}</code>: esta página no tiene entorno, y
          resolverlas contra el del proyecto publicaría sus valores.
        </p>
      </Card>

      {creating && (
        <CreateDocSiteModal
          base={base}
          projectBaseUrl={project.data?.baseUrl ?? ""}
          onClose={() => setCreating(false)}
          onCreated={async (result) => {
            setCreating(false);
            await refresh();
            if (result.apiKey) setIssued({ name: result.site.name, apiKey: result.apiKey });
            else toast.success(`«${result.site.name}» publicada`);
          }}
        />
      )}

      {issued && <IssuedKeyModal name={issued.name} apiKey={issued.apiKey} onClose={() => setIssued(null)} />}

      {deleting && (
        <DeleteDialog
          title="Eliminar la documentación"
          purge={deleting.purge}
          name={deleting.purge ? deleting.site.name : undefined}
          message={
            deleting.purge
              ? `Se va «${deleting.site.name}» con su introducción escrita a mano y su clave. Su URL no se podrá recuperar.`
              : `La URL de «${deleting.site.name}» deja de contestar en el mismo momento, para todo el que la tenga. Lo que ya se leyó sigue leído: una dirección que circula no se puede retirar de donde esté pegada.`
          }
          pending={remove.isPending || archive.isPending}
          onArchive={deleting.purge ? undefined : () => archive.mutate({ site: deleting.site, archived: true })}
          onConfirm={() => remove.mutate({ site: deleting.site, purge: deleting.purge })}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/**
 * El formulario de publicación.
 *
 * `visibility` empieza **sin elegir** y el botón está apagado hasta que se elige. Los ejemplos
 * empiezan apagados. Y la URL base se escribe: el botón que copia la del proyecto existe para que
 * el valor que va a salir publicado se vea antes de salir, en vez de aparecer ya puesto.
 */
function CreateDocSiteModal({
  base,
  projectBaseUrl,
  onClose,
  onCreated,
}: {
  base: string;
  projectBaseUrl: string;
  onClose: () => void;
  onCreated: (result: IssuedDocSiteView) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private" | "">("");
  const [baseUrl, setBaseUrl] = useState("");
  const [intro, setIntro] = useState("");
  const [includeExamples, setIncludeExamples] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api<IssuedDocSiteView>(base, {
        method: "POST",
        body: {
          name: name.trim(),
          visibility,
          baseUrl: baseUrl.trim(),
          intro: intro.trim(),
          includeExamples,
        },
      }),
    onSuccess: onCreated,
  });

  const badBaseUrl = baseUrl.trim() !== "" && !/^https?:\/\/[^\s]+$/i.test(baseUrl.trim());

  return (
    <Modal
      title="Publicar la documentación"
      description="Una página con los endpoints de este proyecto, en una URL que se puede mandar."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!name.trim() || !visibility || badBaseUrl || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Publicando…" : "Publicar"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Nombre *" error={create.error?.message}>
          <input
            autoFocus
            className={inputClass}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Quién puede leerla *" hint="No hay opción por defecto: es una página con la API de alguien.">
          <div className="space-y-2">
            <label className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:bg-slate-50">
              <input
                type="radio"
                aria-label="Privada"
                className="mt-0.5"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span>
                <span className="font-medium text-slate-800">Privada</span>
                <span className="block text-[11px] text-slate-500">
                  Pide una clave para abrirla. Se enseña una vez, al publicarla.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:bg-slate-50">
              <input
                type="radio"
                aria-label="Pública"
                className="mt-0.5"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span>
                <span className="font-medium text-slate-800">Pública</span>
                <span className="block text-[11px] text-slate-500">
                  Cualquiera con la URL la abre. Lo único que la protege es que no se adivina.
                </span>
              </span>
            </label>
          </div>
        </Field>

        <Field
          label="URL base"
          hint="Contra qué se pega el código de la página. Se escribe entera, sin variables."
          error={badBaseUrl ? "Una URL que empiece por http:// o https://" : undefined}
        >
          <input
            className={inputClass}
            value={baseUrl}
            maxLength={MAX_BASE_URL}
            placeholder="https://api.example.com"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          {projectBaseUrl && (
            <button
              type="button"
              className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-700"
              onClick={() => setBaseUrl(projectBaseUrl)}
            >
              Usar la del proyecto: {projectBaseUrl}
            </button>
          )}
        </Field>

        <Field label="Introducción" hint="Sale arriba de la página: para qué es esta API y qué hay que saber antes.">
          <textarea
            className={`${inputClass} min-h-20`}
            value={intro}
            maxLength={8000}
            onChange={(event) => setIntro(event.target.value)}
          />
        </Field>

        <label className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:bg-slate-50">
          <input
            type="checkbox"
            aria-label="Incluir los cuerpos de ejemplo"
            className="mt-0.5"
            checked={includeExamples}
            onChange={(event) => setIncludeExamples(event.target.checked)}
          />
          <span>
            <span className="font-medium text-slate-800">Incluir los cuerpos de ejemplo</span>
            <span className="block text-[11px] text-slate-500">
              Las respuestas guardadas del proyecto. Van sin credenciales dentro, pero son datos reales: nombres,
              correos e identificadores de alguien.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

/** La clave, la única vez que se puede ver. Se cierra a mano: un toast se iría antes de copiarla. */
function IssuedKeyModal({ name, apiKey, onClose }: { name: string; apiKey: string; onClose: () => void }) {
  return (
    <Modal
      title={`La clave de «${name}»`}
      description="Esta es la única vez que se enseña: de ella solo se guarda el hash. Si se pierde, se genera otra."
      size="sm"
      onClose={onClose}
      footer={<Button onClick={onClose}>Ya la he guardado</Button>}
    >
      <div className="space-y-2">
        <code className="block break-all rounded-md bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-100">
          {apiKey}
        </code>
        <Button
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          onClick={() => void navigator.clipboard?.writeText(apiKey)}
        >
          Copiar
        </Button>
        <p className="text-[11px] text-slate-500">
          Quien abra la página la pedirá al entrar. Se guarda en su navegador y no vuelve a salir de ahí.
        </p>
      </div>
    </Modal>
  );
}
