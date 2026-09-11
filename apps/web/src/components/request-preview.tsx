/**
 * «Enviar», y lo que contestó.
 *
 * The gap this closes: until now the only way to make the product touch an API was to start a
 * run — a matrix, a history row and a verdict — and somebody writing one step wants to know
 * whether *this* request works. The loop «guardar, lanzar, esperar, abrir el caso» is long enough
 * that people go and use another tool for it, and come back with a request that works there and
 * not here.
 *
 * It sends what is on the form, saved or not, and it goes through the same executor a run uses:
 * the same credentials, the same `writesAllowed`, the same assertions. That is what makes it
 * worth trusting — a preview with its own HTTP client would be a second engine, and the first
 * time the two disagreed nobody could tell which was lying.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { AssertionRow, Badge, Button, Json } from "@/components/ui";
import { cn, formatBytes, formatDuration, httpStatusStyle } from "@/lib/format";
import { previewBodyFor } from "@/lib/request-preview";
import type { RequestPreviewView, RequestTemplateView } from "@/lib/types";

/**
 * Tres, y las comprobaciones fuera de ellas.
 *
 * They were a fourth tab and it was wrong twice over. The strip did not fit the inspector — the
 * label wrapped and the tab could not be clicked — and hiding the verdict behind a tab buries the
 * answer: what somebody pressing «Enviar» wants to know is whether it held, and the body is how
 * they find out why. So the assertions are always on screen and the payloads are the ones that
 * take turns.
 */
const TABS = [
  { id: "body", label: "Cuerpo" },
  { id: "headers", label: "Cabeceras" },
  { id: "request", label: "Petición" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function RequestPreviewPanel({
  base,
  template,
  environmentId,
  canSend,
}: {
  base: string;
  template: RequestTemplateView;
  environmentId: string;
  canSend: boolean;
}) {
  const [tab, setTab] = useState<Tab>("body");
  const send = useMutation({
    mutationFn: () =>
      api<RequestPreviewView>(`${base}/request-preview`, {
        method: "POST",
        body: previewBodyFor(template, environmentId),
      }),
  });

  const preview = send.data;
  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-2">
      <div className="flex items-center gap-2">
        <Button
          className="h-8 flex-1 text-xs"
          disabled={!canSend || !environmentId || send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Enviando…" : "Enviar"}
        </Button>
        {preview && (
          <>
            {/* El veredicto, aparte del código. Son dos preguntas distintas y la de arriba no es
                la del código: un caso que esperaba un 404 y recibió un 200 enseña un 200 en verde
                —es lo que contestó— y el aspa dice que no cumple. Sin la marca, ese verde de al
                lado se lee como «pasó». */}
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white",
                preview.ok ? "bg-emerald-500" : "bg-rose-500",
              )}
              title={preview.ok ? "Cumple lo que se esperaba" : "No cumple lo que se esperaba"}
            >
              {preview.ok ? "✓" : "✗"}
            </span>
            {preview.response ? (
              <Badge className={cn("border", httpStatusStyle(preview.response.status))}>
                {preview.response.status}
              </Badge>
            ) : (
              <Badge className="border border-rose-200 bg-rose-50 text-rose-700">sin respuesta</Badge>
            )}
            <span className="text-[11px] text-slate-500">{formatDuration(preview.durationMs)}</span>
            {preview.response && (
              <span className="text-[11px] text-slate-500">{formatBytes(preview.response.sizeBytes)}</span>
            )}
          </>
        )}
      </div>

      {/* The environment is chosen further down this same panel, so saying which one is missing
          is more useful than disabling the button and leaving the reason to be guessed. */}
      {!environmentId && <p className="mt-2 text-[11px] text-slate-500">Elige un entorno para poder enviarla.</p>}

      {send.error && (
        <p className="mt-2 text-[11px] text-rose-600">
          {send.error instanceof ApiError ? send.error.message : "No se pudo enviar la petición"}
        </p>
      )}

      {preview && (
        <div className="mt-2">
          {preview.assertions.length ? (
            <div className="mb-2">
              {preview.assertions.map((assertion, index) => (
                <AssertionRow key={index} {...assertion} />
              ))}
            </div>
          ) : (
            <p className="mb-2 text-[11px] text-slate-500">Ninguna comprobación llegó a evaluarse.</p>
          )}

          <div className="flex gap-1 border-b border-slate-200">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                className={cn(
                  "px-2 py-1 text-[11px]",
                  tab === entry.id ? "border-b-2 border-slate-800 font-semibold text-slate-800" : "text-slate-500",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="mt-2">
            {tab === "body" && <Json value={preview.response?.body} empty="La petición no obtuvo respuesta" />}
            {tab === "headers" && <Json value={preview.response?.headers} empty="No hubo cabeceras" />}
            {/* What was sent, with the credential masked — the same masking the stored step gets,
                because this is the panel somebody copies a request out of. */}
            {tab === "request" && <Json value={preview.request} />}
          </div>
        </div>
      )}
    </div>
  );
}
