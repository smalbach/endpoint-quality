/**
 * Los ejemplos guardados de un endpoint: la lista, y el botón que guarda la respuesta que acabas de
 * recibir.
 *
 * **El camino normal es guardar lo que ya tienes en pantalla**, no teclear un ejemplo. Un formulario
 * en blanco con quince campos se rellena una vez y no se vuelve a tocar, y entonces la lista se
 * queda vacía y no documenta nada. Por eso el botón vive pegado a la respuesta y no en un menú.
 *
 * Al guardar sale **lo que se le quitó**. Es lo contrario de un aviso de cortesía: un ejemplo que
 * perdió la cabecera de autenticación en silencio se lee como «esto funcionaba sin credencial», y
 * alguien lo va a creer. Y cuando el cuerpo no es JSON se dice que ahí no se ha mirado dentro, en
 * vez de dar a entender que está revisado.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Button } from "@/components/ui";
import { useToast } from "@/components/toast";
import { prettyBody } from "@/lib/endpoint-draft";
import type { ExampleView, SavedExampleView, SentRequestView } from "@/lib/types";

/** El par que se guarda, sacado de lo que «Enviar» acaba de devolver. */
function pairFrom(sent: SentRequestView): SavedExampleView["example"] | null {
  if (!sent.response) return null;
  const rows = (headers: Record<string, string>) =>
    Object.entries(headers).map(([name, value]) => ({ name, value, enabled: true }));
  const typeOf = (headers: Record<string, string>) =>
    Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "text/plain";
  return {
    request: {
      method: sent.request.method,
      url: sent.request.url,
      headers: rows(sent.request.headers),
      body: { text: sent.request.body ?? "", contentType: typeOf(sent.request.headers) },
    },
    response: {
      status: sent.response.status,
      headers: rows(sent.response.headers),
      body: sent.response.body,
      contentType: typeOf(sent.response.headers),
      durationMs: sent.response.durationMs,
    },
  } as SavedExampleView["example"];
}

const STATUS_TONE = (status: number) =>
  status < 300
    ? "bg-emerald-50 text-emerald-700"
    : status < 400
      ? "bg-sky-50 text-sky-700"
      : status < 500
        ? "bg-amber-50 text-amber-800"
        : "bg-rose-50 text-rose-700";

export function ExamplePanel({
  projectId,
  endpointId,
  sent,
  canEdit,
}: {
  projectId: string;
  /** Nulo mientras el endpoint no está guardado: no hay a qué colgar un ejemplo. */
  endpointId: string | null;
  /** La última respuesta, para poder guardarla. Nula cuando no se ha enviado nada todavía. */
  sent: SentRequestView | null;
  canEdit: boolean;
}) {
  const organization = useOrganization();
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [redaction, setRedaction] = useState<SavedExampleView["redaction"] | null>(null);
  const base = `/orgs/${organization?.id}/projects/${projectId}/endpoints/${endpointId}/examples`;

  const examples = useQuery({
    queryKey: ["examples", projectId, endpointId],
    queryFn: () => api<{ examples: ExampleView[] }>(base),
    enabled: Boolean(endpointId),
  });

  const refresh = () => void client.invalidateQueries({ queryKey: ["examples", projectId, endpointId] });

  const save = useMutation({
    mutationFn: () => api<SavedExampleView>(base, { method: "POST", body: pairFrom(sent!) }),
    onSuccess: (result) => {
      refresh();
      setRedaction(result.redaction);
      setOpen(result.example.id);
      toast.success(`Guardado «${result.example.name}»`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (example: ExampleView) => api<void>(`${base}/${example.id}`, { method: "DELETE" }),
    onSuccess: (_result, example) => {
      refresh();
      toast.success(`Borrado «${example.name}»`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!endpointId) {
    return (
      <p className="mt-2 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
        Guarda el endpoint para poder guardarle ejemplos.
      </p>
    );
  }

  const rows = examples.data?.examples ?? [];
  const pair = sent ? pairFrom(sent) : null;

  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] text-slate-500">
          Lo que este endpoint contestó, con la petición que lo provocó. Sin credenciales: se quitan al guardar.
        </p>
        {canEdit && (
          <Button
            variant="ghost"
            className="ml-auto h-7 px-2 text-[11px]"
            disabled={!pair || save.isPending}
            title={pair ? undefined : "Envía la petición para tener una respuesta que guardar"}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Guardando…" : "Guardar la respuesta"}
          </Button>
        )}
      </div>

      {redaction &&
        (redaction.droppedHeaders.length > 0 || redaction.maskedFields.length > 0 || !redaction.bodyScanned) && (
          <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {redaction.droppedHeaders.length > 0 && (
              <li>No se guardaron estas cabeceras, por ser credenciales: {redaction.droppedHeaders.join(", ")}</li>
            )}
            {redaction.maskedFields.length > 0 && (
              <li>Se taparon estos valores: {redaction.maskedFields.join(", ")}</li>
            )}
            {!redaction.bodyScanned && (
              <li>El cuerpo no es JSON, así que no se ha mirado dentro: revísalo antes de compartirlo.</li>
            )}
          </ul>
        )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
          {examples.isPending ? "…" : "Sin ejemplos. Envía la petición y guarda la respuesta."}
        </p>
      ) : (
        <div className="space-y-1">
          {rows.map((example) => (
            <div key={example.id} className="overflow-hidden rounded-lg border border-slate-200">
              <div className="flex items-center gap-2 bg-slate-50 px-2 py-1.5">
                <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${STATUS_TONE(example.response.status)}`}>
                  {example.response.status}
                </span>
                <button
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-slate-800 hover:underline"
                  onClick={() => setOpen(open === example.id ? null : example.id)}
                >
                  {example.name}
                </button>
                <span className="text-[10px] text-slate-400">
                  {example.origin === "import" ? "importado" : ""} {Math.round(example.sizeBytes / 10.24) / 100} KB
                </span>
                {canEdit && (
                  <button
                    className="text-[10px] text-slate-400 hover:text-rose-600"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(example)}
                  >
                    borrar
                  </button>
                )}
              </div>
              {open === example.id && (
                <div className="space-y-2 px-2 py-2">
                  <p className="font-mono text-[10px] text-slate-500">
                    {example.request.method} {example.request.url}
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-md bg-slate-950 p-2 font-mono text-[10px] leading-4 text-slate-100">
                    {prettyBody(example.response.body).text}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
