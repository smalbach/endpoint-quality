/**
 * La petición como código, en el lenguaje que elija quien la va a pegar.
 *
 * **Sustituye al botón «cURL», no se añade al lado.** Es la misma decisión que en Postman y por el
 * mismo motivo: cURL no es una función aparte, es *un lenguaje de la lista*. Dejar los dos botones
 * habría dado dos puertas a lo mismo, y la vieja —que solo sabe hacer una de las dieciséis cosas—
 * seguiría siendo la que se ve primero.
 *
 * El lenguaje elegido se recuerda. Quien trabaja en Go lo va a pedir dieciséis veces al día, y
 * hacerle bajar por el selector cada vez es cobrarle el mismo peaje dieciséis veces.
 *
 * Lo que el fragmento no puede llevar sale **encima** del código, no debajo: un aviso debajo de
 * treinta líneas de Rust es un aviso que nadie lee, y el caso que importa —la firma de AWS que no
 * se puede escribir— es justo el que da un 403 inexplicable si no se leyó.
 */
import { useState } from "react";

import { Button } from "@/components/ui";
import { Modal } from "@/components/overlay";
import {
  DEFAULT_SNIPPET,
  SNIPPET_LANGUAGES,
  authPlan,
  renderSnippet,
  snippetNotes,
  type SnippetRequest,
} from "@/lib/snippets";

const REMEMBERED = "eq.snippet-language";

/** El lenguaje recordado, o cURL. Un valor guardado que ya no existe no puede dejar la pantalla en
 * blanco: se cae al de siempre. */
function remembered(): string {
  try {
    const saved = window.localStorage.getItem(REMEMBERED);
    return saved && SNIPPET_LANGUAGES.some((language) => language.id === saved) ? saved : DEFAULT_SNIPPET;
  } catch {
    // Sin almacenamiento —ventana privada, permisos— se usa el de siempre y no se avisa de nada:
    // no recordar la elección no es un error que le interese a nadie.
    return DEFAULT_SNIPPET;
  }
}

export function CodeModal({ request, onClose }: { request: SnippetRequest; onClose: () => void }) {
  const [id, setId] = useState(remembered);
  const [copied, setCopied] = useState(false);

  // `id` sale de `remembered`, que ya descarta lo que no existe, o de una opción del selector.
  const language = SNIPPET_LANGUAGES.find((entry) => entry.id === id)!;
  const code = renderSnippet(language.id, request);
  const notes = snippetNotes(request, authPlan(request.auth, request.headers));

  // Los grupos en el orden de la lista, que es el orden en el que se pensó: lo que más se usa
  // primero. Un `Object.groupBy` los reordenaría por nombre.
  const groups: { group: string; languages: typeof SNIPPET_LANGUAGES }[] = [];
  for (const entry of SNIPPET_LANGUAGES) {
    const last = groups.at(-1);
    if (last && last.group === entry.group) last.languages.push(entry);
    else groups.push({ group: entry.group, languages: [entry] });
  }

  const choose = (next: string) => {
    setId(next);
    try {
      window.localStorage.setItem(REMEMBERED, next);
    } catch {
      // Ver `remembered`.
    }
  };

  return (
    <Modal
      title="Código"
      description="Las variables no secretas van sustituidas; las secretas se quedan como {{variable}}."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copiado" : "Copiar"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[11px] text-slate-500">
            Lenguaje
            <select
              aria-label="Lenguaje"
              className="h-8 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-900"
              value={language.id}
              onChange={(event) => choose(event.target.value)}
            >
              {groups.map((entry) => (
                <optgroup key={entry.group} label={entry.group}>
                  {entry.languages.map((item) => (
                    <option key={item.id} value={item.id}>
                      {entry.group} · {item.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {language.hint && <span className="font-mono text-[10px] text-slate-400">{language.hint}</span>}
        </div>

        {notes.length > 0 && (
          <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100 select-all">
          {code}
        </pre>
      </div>
    </Modal>
  );
}
