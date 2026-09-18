import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { openHooks } from "@/lib/workflow-webhook";
import type { RunCase, RunHookWaitView } from "@/lib/types";

/**
 * La URL en la que escucha un nodo webhook que espera, con un botón para copiarla.
 *
 * Una tarjeta por espera abierta. La URL viene de la corrida (`hooks`), que la API calcula en cada
 * lectura mientras el nodo espera; la página la vuelve a pedir cuando el stream avisa de que un nodo
 * se ha puesto a esperar. Cuando su caso termina la tarjeta se va, y lo que llegó se ve en el detalle
 * del caso como su respuesta.
 */
export function RunHookWait({ hooks, cases }: { hooks: RunHookWaitView[] | undefined; cases: RunCase[] }) {
  const byId = new Map(cases.map((runCase) => [runCase.id, runCase] as const));
  const open = openHooks(hooks, (caseId) => byId.get(caseId)?.status);
  if (!open.length) return null;
  return (
    <div className="space-y-2">
      {open.map((hook) => (
        <HookUrlCard key={hook.caseId} hook={hook} runCase={byId.get(hook.caseId)} />
      ))}
    </div>
  );
}

function HookUrlCard({ hook, runCase }: { hook: RunHookWaitView; runCase: RunCase | undefined }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  const copy = async () => {
    // `navigator.clipboard` falla fuera de un contexto seguro o con la ventana sin foco; la URL sigue
    // seleccionable en el campo en cualquier caso.
    try {
      await navigator.clipboard.writeText(hook.url);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Card className="border-amber-300 bg-amber-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-amber-100 text-amber-800" aria-hidden>
          ⚓
        </span>
        <p className="text-sm font-semibold text-amber-900">Esperando webhook · {hook.stepId}</p>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        <span className="text-[11px] text-amber-800">
          {runCase?.path ? `${runCase.path} · ` : ""}hasta {formatDate(hook.expiresAt)}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-amber-900">
        Llama a esta URL con <span className="font-mono font-semibold">{hook.method}</span> (o dásela al sistema
        externo). Lo que llegue será la respuesta de este nodo. Sirve una sola vez y deja de funcionar al terminar la
        espera.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          readOnly
          aria-label="URL del webhook"
          value={hook.url}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-800"
        />
        <Button className="bg-amber-400 text-slate-950 hover:bg-amber-300" onClick={() => void copy()}>
          {copied === "yes" ? "Copiada" : "Copiar URL"}
        </Button>
      </div>
      {copied === "failed" && (
        <p className="mt-1 text-[11px] text-rose-700">No se pudo copiar: selecciona la URL y cópiala a mano.</p>
      )}
    </Card>
  );
}
