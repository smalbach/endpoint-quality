/**
 * Una petición de la corrida, abierta: qué se mandó, qué contestó y por qué está en rojo.
 *
 * El informe enseñaba el verbo, el nombre, el estado y los tests, que alcanza para saber **que**
 * algo falló y no para saber **qué** pasó: la URL era la escrita —`{{baseUrl}}/v1/products`—, del
 * cuerpo que se mandó no quedaba nada, y de la respuesta solo su número. Con una colección de
 * ochenta peticiones eso obliga a abrir cada una en el editor y volver a enviarla a mano, contra un
 * estado que ya no es el de la corrida.
 *
 * Aquí está el intercambio entero, en las mismas pestañas que el editor de peticiones usa para lo
 * mismo, más lo que solo una corrida puede contar: con qué credencial salió, qué cookies se
 * presentaron y qué variables dejó escritas para las que venían detrás.
 */
import { useState } from "react";

import { Badge } from "@/components/ui";
import { cn, formatBytes, formatDuration } from "@/lib/format";
import { failureReason, statusClass } from "@/lib/collections";
import type { CollectionRunResultView } from "@/lib/types";

const TABS = ["summary", "request", "response", "tests", "console"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  summary: "Resumen",
  request: "Petición",
  response: "Respuesta",
  tests: "Tests",
  console: "Consola",
};

const headerLines = (headers: Record<string, string>): string =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

export function CollectionResultDetail({ result }: { result: CollectionRunResultView }) {
  const [tab, setTab] = useState<Tab>("summary");
  const reason = failureReason(result);
  const failedTests = result.tests.filter((test) => !test.passed).length;

  return (
    <div className="mt-2 rounded border border-slate-200 bg-slate-50">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 px-2 py-1">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            className={cn(
              "rounded px-2 py-0.5 text-xs",
              tab === id ? "bg-slate-200 font-medium text-slate-800" : "text-slate-500 hover:text-slate-700",
            )}
            onClick={() => setTab(id)}
          >
            {TAB_LABEL[id]}
            {id === "tests" && result.tests.length ? ` (${result.tests.length})` : ""}
            {id === "console" && result.logs.length ? ` (${result.logs.length})` : ""}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 text-xs text-slate-500 hover:text-slate-700"
          onClick={() => void navigator.clipboard?.writeText(result.sent?.url || result.url)}
        >
          Copiar la URL
        </button>
      </div>

      <div className="space-y-2 p-2 text-xs">
        {reason && <p className="rounded bg-rose-50 px-2 py-1 text-rose-700">{reason}</p>}

        {tab === "summary" && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <Fact label="Estado">
              <span className={statusClass(result.status)}>{result.status ?? "sin respuesta"}</span>
            </Fact>
            <Fact label="Tardó">{formatDuration(result.durationMs)}</Fact>
            <Fact label="Tamaño">{formatBytes(result.sizeBytes)}</Fact>
            <Fact label="Credencial">{result.auth || "—"}</Fact>
            <Fact label="Tests">
              {result.tests.length ? `${result.tests.length - failedTests}/${result.tests.length}` : "sin tests"}
            </Fact>
            <Fact label="Vuelta">{result.iteration}</Fact>
            {result.received && (
              <Fact label="En qué se fue el tiempo">
                {`nombre ${result.received.timing.dnsMs} ms · espera ${result.received.timing.ttfbMs} ms · descarga ${result.received.timing.downloadMs} ms`}
              </Fact>
            )}
            {result.scripts.pre && (
              <Fact label="Script previo">
                {result.scripts.pre.error
                  ? `falló: ${result.scripts.pre.error}`
                  : `corrió en ${result.scripts.pre.durationMs} ms`}
              </Fact>
            )}
            {result.scripts.post && (
              <Fact label="Script de tests">
                {result.scripts.post.error
                  ? `falló: ${result.scripts.post.error}`
                  : `corrió en ${result.scripts.post.durationMs} ms`}
              </Fact>
            )}
            {Boolean(result.cookies.sent.length) && (
              <Fact label="Cookies presentadas">{result.cookies.sent.join(", ")}</Fact>
            )}
            {Boolean(result.cookies.stored.length) && (
              <Fact label="Cookies guardadas">{result.cookies.stored.join(", ")}</Fact>
            )}
            {result.cookies.rejected.map((rejected) => (
              <Fact key={rejected.line} label="Cookie rechazada">
                {`${rejected.line} — ${rejected.why}`}
              </Fact>
            ))}
            <Fact label="Dejó escrito">
              {result.writes.length
                ? result.writes.map((write) => `${write.key} = ${write.value}`).join(" · ")
                : "nada"}
            </Fact>
          </dl>
        )}

        {tab === "request" && (
          <div className="space-y-2">
            {result.sent ? (
              <>
                <p className="break-all font-mono text-[11px] text-slate-700">
                  {result.sent.method} {result.sent.url}
                </p>
                <Block title="Cabeceras" text={headerLines(result.sent.headers)} />
                <Block
                  title="Cuerpo"
                  text={result.sent.body}
                  truncated={result.sent.bodyTruncated}
                  empty="Esta petición no lleva cuerpo."
                />
              </>
            ) : (
              <p className="text-slate-500">
                No salió ninguna petición: {result.error ?? "el envío se rechazó antes de mandarla"}.
              </p>
            )}
            {result.sent && result.sent.url !== result.url && (
              <p className="text-[11px] text-slate-500">Escrita en la colección: {result.url}</p>
            )}
          </div>
        )}

        {tab === "response" && (
          <div className="space-y-2">
            {result.received ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={cn("font-bold", statusClass(result.received.status))}>{result.received.status}</span>
                  <span className="text-slate-500">{formatDuration(result.received.durationMs)}</span>
                  <span className="text-slate-500">{formatBytes(result.received.sizeBytes)}</span>
                </p>
                <Block title="Cabeceras" text={headerLines(result.received.headers)} />
                <Block
                  title="Cuerpo"
                  text={result.received.body}
                  truncated={result.received.bodyTruncated}
                  empty="La respuesta llegó sin cuerpo."
                />
              </>
            ) : (
              <p className="text-slate-500">No hubo respuesta: {result.error ?? "el destino no contestó"}.</p>
            )}
          </div>
        )}

        {tab === "tests" && (
          <ul className="space-y-1">
            {result.tests.map((test, index) => (
              <li key={`${test.name}-${index}`} className={test.passed ? "text-emerald-700" : "text-rose-700"}>
                {test.passed ? "✓" : "✕"} {test.name}
                {test.message ? ` — ${test.message}` : ""}
              </li>
            ))}
            {!result.tests.length && <li className="text-slate-500">Esta petición no trae tests.</li>}
          </ul>
        )}

        {tab === "console" && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-600">
            {result.logs.map((log) => `[${log.level}] ${log.text}`).join("\n") || "La consola quedó vacía."}
          </pre>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="break-words text-slate-800">{children}</dd>
    </div>
  );
}

/**
 * Un bloque de texto del intercambio, con el aviso de que lo guardado es un recorte.
 *
 * El aviso importa tanto como el texto: un cuerpo cortado a los dieciséis mil caracteres leído como
 * si fuera entero hace pensar en un JSON mal cerrado que el servidor nunca mandó.
 */
function Block({
  title,
  text,
  truncated = false,
  empty = "—",
}: {
  title: string;
  text: string | null;
  truncated?: boolean;
  empty?: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
        {title}
        {text ? (
          <button
            type="button"
            className="normal-case text-slate-500 underline hover:text-slate-700"
            onClick={() => void navigator.clipboard?.writeText(text)}
          >
            Copiar
          </button>
        ) : null}
        {truncated && (
          <Badge className="border-amber-200 bg-amber-50 text-amber-700">
            {text ? "recortado" : "no se guardó: la corrida pasó del tope"}
          </Badge>
        )}
      </p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-slate-700">
        {text || empty}
      </pre>
    </div>
  );
}
