import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { Button, Field, inputClass } from "@/components/ui";

/**
 * Pegar lo que ya se tiene, en vez de volver a teclearlo.
 *
 * What people actually have is a `curl` in a ticket, a runbook full of them, or a collection a
 * colleague exported — never an OpenAPI document. Until this existed the first five minutes with
 * the tool were spent retyping requests that already worked somewhere else, and a retyped request
 * reproduces something slightly different from the one that was reported.
 *
 * **The answer is a list and not a number.** «12 importadas, 4 no» is a result nobody can act on;
 * what makes the four useful is their names and the reason, because a collection with four
 * requests the contract does not declare is either stale or a list of undocumented endpoints — and
 * both are worth knowing before anything is run.
 */
const FORMATS = [
  { value: "curl", label: "cURL", hint: "Un comando, o un markdown lleno de ellos." },
  { value: "postman", label: "Postman", hint: "La colección exportada, v2.1." },
  { value: "insomnia", label: "Insomnia", hint: "La exportación del workspace, v4." },
] as const;

type Format = (typeof FORMATS)[number]["value"];

type Outcome = {
  imported: { id: string; name: string; operationId: string }[];
  skipped: { name: string; method: string; url: string; reason: string }[];
};

export function ImportRequests({ base, onImported }: { base: string; onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>("curl");
  const [text, setText] = useState("");

  const send = useMutation({
    mutationFn: () => api<Outcome>(`${base}/request-templates/import`, { method: "POST", body: { format, text } }),
    onSuccess: (outcome) => {
      onImported();
      // Cleared only when something came in. A paste that matched nothing stays in the box, which
      // is what somebody about to fix a base URL and try again needs.
      if (outcome.imported.length) setText("");
    },
  });

  if (!open) {
    return (
      <Button variant="ghost" className="mt-2 h-8 w-full text-xs" onClick={() => setOpen(true)}>
        Importar peticiones
      </Button>
    );
  }

  const outcome = send.data;
  const hint = FORMATS.find((entry) => entry.value === format)?.hint;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-2">
      <div className="flex items-baseline gap-2">
        <p className="text-xs font-semibold text-slate-800">Importar peticiones</p>
        <button type="button" className="ml-auto text-[10px] text-slate-500" onClick={() => setOpen(false)}>
          cerrar
        </button>
      </div>

      <Field label="Formato" hint={hint}>
        <select
          className={inputClass}
          value={format}
          onChange={(event) => {
            setFormat(event.target.value as Format);
            send.reset();
          }}
        >
          {FORMATS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>

      <textarea
        aria-label="Lo que se importa"
        className={`${inputClass} h-28 font-mono text-[10px]`}
        value={text}
        spellCheck={false}
        placeholder={format === "curl" ? "curl https://api.ejemplo.com/pedidos \\\n  -H 'X-Tenant: acme'" : "{ … }"}
        onChange={(event) => setText(event.target.value)}
      />

      <p className="mt-1 text-[10px] leading-4 text-slate-400">
        Salen pruebas reutilizables, nunca operaciones: los endpoints siguen siendo los del contrato, y una petición que
        no cae sobre ninguno se dice por su nombre. No se envía nada al importar.
      </p>

      <Button
        className="mt-2 h-8 w-full text-xs"
        disabled={!text.trim() || send.isPending}
        onClick={() => send.mutate()}
      >
        {send.isPending ? "Leyendo…" : "Importar"}
      </Button>

      {send.error && (
        <p className="mt-2 text-[11px] text-rose-600">
          {send.error instanceof ApiError ? send.error.message : "No se pudo importar"}
        </p>
      )}

      {outcome && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-slate-600">
            {outcome.imported.length} {outcome.imported.length === 1 ? "importada" : "importadas"}
            {outcome.skipped.length > 0 && ` · ${outcome.skipped.length} sin importar`}
          </p>
          {outcome.imported.length > 0 && (
            <ul className="space-y-0.5">
              {outcome.imported.map((entry) => (
                <li key={entry.id} className="truncate text-[10px] text-slate-500">
                  <span className="text-emerald-600">+</span> {entry.name}{" "}
                  <span className="font-mono text-slate-400">{entry.operationId}</span>
                </li>
              ))}
            </ul>
          )}
          {outcome.skipped.length > 0 && (
            <ul className="space-y-0.5 rounded-md bg-amber-50 p-1.5">
              {outcome.skipped.map((entry, index) => (
                <li key={index} className="text-[10px] leading-4 text-amber-800">
                  <span className="font-medium">{entry.name || "Sin nombre"}</span> — {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
