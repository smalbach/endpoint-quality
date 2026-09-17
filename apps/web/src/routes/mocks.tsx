/**
 * Los servidores de mocks del proyecto: la URL que contesta con los ejemplos guardados.
 *
 * Lo primero que se ve es **si esto puede servir para algo**: «4 de 12 rutas tienen ejemplo». Un
 * mock de un proyecto sin ejemplos es una URL que contesta 501 a todo, y descubrirlo cuando el front
 * ya está apuntado es media tarde. Esa cifra lo dice antes de crear nada.
 *
 * Al crear hay que **elegir** público o privado, sin opción marcada de antemano. Un mock sirve datos
 * reales —redactados, pero reales— y una casilla ya marcada se acepta sin leerla.
 *
 * La clave de un mock privado se enseña **una vez**. De ella solo queda el hash, así que no hay
 * ningún sitio donde volver a mirarla: si se pierde, se rota. Por eso sale en un aviso que hay que
 * cerrar a mano y no en un toast que se va solo.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { absoluteApiUrl, api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { ConfirmDialog, Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/format";
import type { IssuedMockView, MockListView, MockServerView } from "@/lib/types";

const MAX_DELAY_MS = 5_000;

/**
 * La URL completa que se pega en un front.
 *
 * El prefijo lo dice el servidor, y el origen sale de dónde vive la API: en el despliegue normal es
 * el mismo host con `/api` delante, que nginx reescribe. Componerla con el origen de la pestaña a
 * secas daría una URL que no contesta.
 */
const mockUrl = (prefix: string, publicId: string) => absoluteApiUrl(`${prefix}/${publicId}`);

function delayLabel(delay: MockServerView["delay"]): string {
  if (delay.kind === "fixed") return `${delay.ms} ms`;
  if (delay.kind === "random") return `${delay.minMs}–${delay.maxMs} ms`;
  return "sin retardo";
}

export function MocksPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const client = useQueryClient();
  const toast = useToast();
  const base = `/orgs/${organization?.id}/projects/${projectId}/mocks`;

  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ name: string; apiKey: string } | null>(null);
  const [deleting, setDeleting] = useState<MockServerView | null>(null);

  const list = useQuery({
    queryKey: ["mocks", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<MockListView>(base),
  });

  const refresh = () => client.invalidateQueries({ queryKey: ["mocks", projectId] });

  const rotate = useMutation({
    mutationFn: (mock: MockServerView) => api<IssuedMockView>(`${base}/${mock.id}/key`, { method: "POST", body: {} }),
    onSuccess: async (result) => {
      await refresh();
      if (result.apiKey) setIssued({ name: result.mock.name, apiKey: result.apiKey });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (mock: MockServerView) =>
      api<MockServerView>(`${base}/${mock.id}`, { method: "PATCH", body: { enabled: !mock.enabled } }),
    onSuccess: async (_result, mock) => {
      await refresh();
      toast.success(mock.enabled ? `«${mock.name}» apagado` : `«${mock.name}» encendido`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (mock: MockServerView) => api<void>(`${base}/${mock.id}`, { method: "DELETE" }),
    onSuccess: async (_result, mock) => {
      setDeleting(null);
      await refresh();
      toast.success(`«${mock.name}» eliminado`);
    },
    onError: (error: Error) => {
      setDeleting(null);
      toast.error(error.message);
    },
  });

  const coverage = list.data?.coverage;
  const prefix = list.data?.prefix ?? "/mock";
  const mocks = list.data?.mocks ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Mocks</h1>
          <p className="mt-1 max-w-xl text-xs text-slate-500">
            Una URL que contesta con los ejemplos guardados de este proyecto, sin tocar la API de verdad. Es lo que
            permite montar el front antes de que el backend exista.
          </p>
        </div>
        {canEdit && <Button onClick={() => setCreating(true)}>Crear un mock</Button>}
      </div>

      {coverage && (
        <Card className="p-4">
          <p className="text-sm text-slate-800">
            <span className="font-semibold">{coverage.withExamples}</span> de {coverage.endpoints} rutas tienen al menos
            un ejemplo guardado.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {coverage.withExamples === 0
              ? "Un mock sin ejemplos contesta 501 a todo. Envía una petición desde el editor de un endpoint y guarda la respuesta: eso es lo que el mock sirve."
              : "Las demás contestarán 501 diciendo que falta el ejemplo. Un mock solo sabe lo que alguien guardó."}
          </p>
        </Card>
      )}

      {mocks.length === 0 ? (
        <Empty
          title={list.isPending ? "…" : "Sin mocks"}
          hint="Un mock es una URL de este proyecto que contesta con sus ejemplos. No hay ninguno hasta que se crea a mano."
        />
      ) : (
        <div className="space-y-2">
          {mocks.map((mock) => (
            <Card key={mock.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">{mock.name}</p>
                <Badge
                  className={
                    mock.visibility === "public"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-slate-200 bg-slate-50 text-slate-600"
                  }
                >
                  {mock.visibility === "public" ? "público" : "privado"}
                </Badge>
                {!mock.enabled && <Badge className="border-slate-200 bg-slate-100 text-slate-500">apagado</Badge>}
                <span className="ml-auto text-[11px] text-slate-400">
                  {delayLabel(mock.delay)} · creado {formatDate(mock.createdAt)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-100">
                  {mockUrl(prefix, mock.publicId)}
                </code>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    void navigator.clipboard?.writeText(mockUrl(prefix, mock.publicId));
                    toast.success("URL copiada");
                  }}
                >
                  Copiar
                </Button>
              </div>

              <p className="text-[11px] text-slate-500">
                {mock.visibility === "public"
                  ? "Cualquiera con esta URL puede leer los ejemplos de este proyecto. Lo único que la protege es que no se adivina."
                  : `Pide la cabecera x-api-key. La de ahora acaba en ${mock.apiKeyPreview || "…"}.`}
              </p>

              {canEdit && (
                <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => toggle.mutate(mock)}>
                    {mock.enabled ? "Apagar" : "Encender"}
                  </Button>
                  {mock.visibility === "private" && (
                    <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => rotate.mutate(mock)}>
                      Nueva clave
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="ml-auto h-7 px-2 text-[11px] text-rose-600"
                    onClick={() => setDeleting(mock)}
                  >
                    Eliminar
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Card className="space-y-2 p-4 text-[11px] text-slate-500">
        <p className="text-xs font-semibold text-slate-800">Cómo pedirle un ejemplo concreto</p>
        <p>
          Por defecto contesta el 2xx más bajo de la ruta. Para probar el camino de error, la misma petición con una
          cabecera: <code className="font-mono text-slate-700">x-eq-mock-status: 404</code>, o{" "}
          <code className="font-mono text-slate-700">x-eq-mock-example: el nombre del ejemplo</code>. Las de Postman —
          <code className="font-mono text-slate-700">x-mock-response-code</code> y{" "}
          <code className="font-mono text-slate-700">x-mock-response-name</code> — valen igual.
        </p>
        <p>
          Cada respuesta dice qué eligió y por qué en{" "}
          <code className="font-mono text-slate-700">x-eq-mock-endpoint</code>,{" "}
          <code className="font-mono text-slate-700">x-eq-mock-example</code> y{" "}
          <code className="font-mono text-slate-700">x-eq-mock-reason</code>.
        </p>
      </Card>

      {creating && (
        <CreateMockModal
          base={base}
          onClose={() => setCreating(false)}
          onCreated={async (result) => {
            setCreating(false);
            await refresh();
            if (result.apiKey) setIssued({ name: result.mock.name, apiKey: result.apiKey });
            else toast.success(`«${result.mock.name}» creado`);
          }}
        />
      )}

      {issued && <IssuedKeyModal name={issued.name} apiKey={issued.apiKey} onClose={() => setIssued(null)} />}

      {deleting && (
        <ConfirmDialog
          title="Eliminar el mock"
          message={`La URL de «${deleting.name}» deja de contestar en el mismo momento, para todo el que la tenga puesta. Los ejemplos no se tocan.`}
          confirmLabel="Eliminar"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/**
 * El formulario de creación.
 *
 * `visibility` empieza **sin elegir** y el botón está apagado hasta que se elige. Es la única
 * decisión de esta pantalla que no se puede deshacer sin consecuencias: una URL pública que ya
 * circula sigue circulando aunque después se cambie a privada.
 */
function CreateMockModal({
  base,
  onClose,
  onCreated,
}: {
  base: string;
  onClose: () => void;
  onCreated: (result: IssuedMockView) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private" | "">("");
  const [delayMs, setDelayMs] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api<IssuedMockView>(base, {
        method: "POST",
        body: {
          name: name.trim(),
          visibility,
          ...(Number(delayMs) > 0 ? { delay: { kind: "fixed", ms: Number(delayMs) } } : {}),
        },
      }),
    onSuccess: onCreated,
  });

  const badDelay =
    delayMs !== "" && (!Number.isInteger(Number(delayMs)) || Number(delayMs) < 0 || Number(delayMs) > MAX_DELAY_MS);

  return (
    <Modal
      title="Crear un mock"
      description="Una URL de este proyecto que contesta con los ejemplos guardados."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!name.trim() || !visibility || badDelay || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creando…" : "Crear"}
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

        <Field
          label="Quién puede llamarlo *"
          hint="No hay opción por defecto: un mock sirve datos reales del proyecto."
        >
          <div className="space-y-2">
            <label className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:bg-slate-50">
              <input
                type="radio"
                aria-label="Privado"
                className="mt-0.5"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span>
                <span className="font-medium text-slate-800">Privado</span>
                <span className="block text-[11px] text-slate-500">
                  Pide una cabecera <code className="font-mono">x-api-key</code>. La clave se enseña una vez, al
                  crearlo.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:bg-slate-50">
              <input
                type="radio"
                aria-label="Público"
                className="mt-0.5"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span>
                <span className="font-medium text-slate-800">Público</span>
                <span className="block text-[11px] text-slate-500">
                  Cualquiera con la URL lee los ejemplos de este proyecto. Van sin credenciales dentro, pero siguen
                  siendo datos reales.
                </span>
              </span>
            </label>
          </div>
        </Field>

        <Field
          label="Retardo simulado"
          hint={`En milisegundos, hasta ${MAX_DELAY_MS}. Vacío contesta al instante.`}
          error={badDelay ? `Un entero entre 0 y ${MAX_DELAY_MS}` : undefined}
        >
          <input
            className={inputClass}
            value={delayMs}
            inputMode="numeric"
            placeholder="0"
            onChange={(event) => setDelayMs(event.target.value)}
          />
        </Field>
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
          Va en la cabecera <code className="font-mono text-slate-700">x-api-key</code> de cada petición al mock.
        </p>
      </div>
    </Modal>
  );
}
