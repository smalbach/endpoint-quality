/**
 * Una colección de Postman, en el proyecto: las URL como endpoints y los tests como flujos.
 *
 * Un fichero, dos destinos, y están juntos porque es un solo gesto: lo que la gente tiene es *una*
 * exportación de Postman, y hasta ahora traerla al proyecto eran dos pantallas distintas —el
 * importador de ficheros del panel de endpoints para las URL, y nada para los tests—. Los tests son
 * justo la mitad que nadie puede volver a teclear: el orden de la carpeta, el `{{id}}` que pasa de
 * un paso al siguiente y lo que cada respuesta tiene que cumplir.
 *
 * **Las dos casillas se pueden apagar por separado**, y ninguna de las dos es una copia de la otra:
 * un endpoint es una ruta del proyecto que alguien edita y lanza a mano; un flujo es un escenario
 * que se corre. Lo normal es querer las dos, y lo segundo normal es querer solo los flujos porque
 * los endpoints ya vinieron del contrato.
 *
 * El resultado se cuenta como una lista y no como un número: «3 importadas, 2 no» no es algo sobre
 * lo que nadie pueda actuar, y «"Crear pedido": el test se mantiene como nodo script» sí.
 */
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import type { EndpointImportResult, PostmanFlowsImportResult } from "@/lib/types";

type Outcome = { endpoints: EndpointImportResult | null; flows: PostmanFlowsImportResult | null };

export function ImportPostman({
  base,
  disabled,
  onImported,
}: {
  base: string;
  disabled: boolean;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [asEndpoints, setAsEndpoints] = useState(true);
  const [asFlows, setAsFlows] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const send = useMutation({
    mutationFn: async (): Promise<Outcome> => {
      const text = await file!.text();
      // Los endpoints primero, porque son las rutas que el proyecto va a tener; los flujos después,
      // que es el orden en el que alguien lo leería si lo hiciera a mano.
      const endpoints = asEndpoints ? await importEndpoints(base, file!) : null;
      const flows = asFlows
        ? await api<PostmanFlowsImportResult>(`${base}/workflows/import/postman`, {
            method: "POST",
            body: { text },
          })
        : null;
      return { endpoints, flows };
    },
    onSuccess: () => {
      setFile(null);
      if (input.current) input.current.value = "";
      onImported();
    },
  });

  const outcome = send.data;
  const nothingChosen = !asEndpoints && !asFlows;

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-900">Desde Postman</p>
      <p className="mt-1 text-xs text-slate-500">
        La colección exportada como v2.1. Sus URL entran como endpoints y sus tests como flujos. No se envía ninguna
        petición al importar.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          aria-label="Colección de Postman"
          accept=".json,application/json"
          disabled={disabled}
          className="min-w-0 flex-1 text-xs file:mr-2 file:rounded file:border file:border-slate-200 file:bg-white file:px-2 file:py-1 file:text-xs"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            send.reset();
          }}
        />
        <Button disabled={disabled || !file || nothingChosen || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? "Leyendo…" : "Importar"}
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-4">
        <Toggle
          label="Las URL, como endpoints"
          hint="Una ruta que el proyecto ya tiene no se dobla."
          checked={asEndpoints}
          disabled={disabled}
          onChange={setAsEndpoints}
        />
        <Toggle
          label="Los tests, como flujos"
          hint="Una carpeta es un flujo; volver a importarla lo actualiza."
          checked={asFlows}
          disabled={disabled}
          onChange={setAsFlows}
        />
      </div>

      {send.error && (
        <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <p>{send.error instanceof ApiError ? send.error.message : "No se pudo importar"}</p>
          {send.error instanceof ApiError &&
            send.error.fields.map((field, index) => (
              <p key={index} className="mt-0.5 text-[11px]">
                {field.detail}
              </p>
            ))}
        </div>
      )}

      {outcome && <Result outcome={outcome} />}
    </Card>
  );
}

/** El importador de endpoints es multipart y lleva el nombre del fichero: es lo que usa para
 * reconocer el formato antes de leerlo. */
async function importEndpoints(base: string, file: File): Promise<EndpointImportResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return api<EndpointImportResult>(`${base}/endpoints/import/file`, { method: "POST", body: form });
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-slate-700">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-[11px] text-slate-400">{hint}</span>
      </span>
    </label>
  );
}

function Result({ outcome }: { outcome: Outcome }) {
  const { endpoints, flows } = outcome;
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
      {endpoints && (
        <div>
          <p className="font-medium text-slate-800">
            {endpoints.imported.length} {endpoints.imported.length === 1 ? "endpoint" : "endpoints"} ·{" "}
            {endpoints.skipped.length} sin importar
          </p>
          {endpoints.imported.length > 0 && (
            <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">
              {endpoints.imported.map((entry) => (
                <li key={entry.id} className="truncate font-mono text-[11px] text-slate-500">
                  <span className="text-emerald-600">+</span> {entry.method} {entry.path}
                </li>
              ))}
            </ul>
          )}
          {endpoints.skipped.length > 0 && (
            <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">
              {endpoints.skipped.map((entry, index) => (
                <li key={index} className="text-[11px] text-slate-500">
                  <span className="font-mono">
                    {entry.method} {entry.path || entry.name}
                  </span>{" "}
                  — {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {flows && (
        <div>
          <p className="font-medium text-slate-800">
            {flows.flows.length} {flows.flows.length === 1 ? "flujo" : "flujos"} de «
            {flows.collection || "la colección"}» · {flows.templates.created} peticiones nuevas,{" "}
            {flows.templates.updated} reescritas
          </p>
          <ul className="mt-1 space-y-0.5">
            {flows.flows.map((flow) => (
              <li key={flow.id} className="text-[11px] text-slate-600">
                <span className="font-medium">{flow.name}</span>{" "}
                <span className={flow.action === "created" ? "text-emerald-600" : "text-amber-600"}>
                  {flow.action === "created" ? "nuevo" : "actualizado"}
                </span>{" "}
                · {flow.steps} nodos ({flow.requests} peticiones, {flow.calls} llamadas, {flow.scripts} scripts)
              </li>
            ))}
          </ul>
          {flows.skipped.length > 0 && (
            <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto rounded bg-white p-1.5">
              {flows.skipped.map((entry, index) => (
                <li key={index} className="text-[11px] text-slate-500">
                  <span className="font-medium">{entry.name || "Sin nombre"}</span> — {entry.reason}
                </li>
              ))}
            </ul>
          )}
          {flows.notes.length > 0 && (
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto rounded bg-amber-50 p-1.5">
              {flows.notes.map((note, index) => (
                <li key={index} className="text-[11px] leading-4 text-amber-800">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
