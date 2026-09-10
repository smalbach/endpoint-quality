import { useEffect, useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import { bulkFrom, emptyRow, parseBulk, type VariableRow } from "@/lib/env-variables";

/**
 * The variables table, the way Postman draws it.
 *
 * Four things it borrows, each because the old editor was worse for the lack of it:
 *
 * - **a checkbox per row**, so a value can be parked instead of deleted;
 * - **a blank row that is always there**, so adding one is typing rather than finding a button;
 * - **column headers**, because a grid of unlabelled inputs is a puzzle the first time;
 * - **a text view** — `nombre:valor` per line, commented out when off — for the twenty values
 *   somebody is pasting from somewhere else. It is the same rows, so switching loses nothing.
 *
 * The rows are the caller's state: this draws them and reports edits. Everything that can be
 * decided without a DOM lives in `lib/env-variables.ts` and is asserted there.
 */
export function VariablesEditor({
  rows,
  problems,
  disabled,
  onChange,
}: {
  rows: VariableRow[];
  problems: { index: number; detail: string }[];
  disabled: boolean;
  onChange: (rows: VariableRow[]) => void;
}) {
  const [asText, setAsText] = useState(false);
  const [text, setText] = useState(() => bulkFrom(rows));
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Editing in the table while the text view holds a stale copy is how a switch silently reverts
  // what was just typed. It is only carried in the direction that is not being edited.
  useEffect(() => {
    if (!asText) setText(bulkFrom(rows));
  }, [rows, asText]);

  const active = rows.filter((row) => row.name.trim() && row.enabled).length;
  const parked = rows.filter((row) => row.name.trim() && !row.enabled).length;
  const problemAt = (index: number) => problems.find((problem) => problem.index === index)?.detail;

  /** The blank row at the bottom, always. Typing in it is what creates a variable. */
  const withGhost = (next: VariableRow[]) =>
    next.length > 0 && !next[next.length - 1].name.trim() && !next[next.length - 1].value
      ? next
      : [...next, emptyRow()];
  // Rendered rows, ghost included — and **what an edit applies to**. Applying it to the rows the
  // parent holds instead means the ghost has no index there, so the first keystroke in it matches
  // nothing and is dropped: typing a name would silently begin at its second letter.
  const shown = withGhost(rows);
  const edit = (index: number, patch: Partial<VariableRow>) =>
    onChange(withGhost(shown.map((row, position) => (position === index ? { ...row, ...patch } : row))));

  function switchView() {
    if (!asText) {
      setText(bulkFrom(rows));
      setError(null);
      setAsText(true);
      return;
    }
    const parsed = parseBulk(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    onChange(withGhost(parsed.rows));
    setError(null);
    setAsText(false);
  }

  async function copy(name: string) {
    try {
      await navigator.clipboard.writeText(`{{${name}}}`);
      setCopied(name);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard access is denied outside a secure context. Not worth an error message: the
      // token is two characters either side of a name that is already on screen.
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Variables</p>
        <p className="text-[11px] text-slate-400">
          {active} activas{parked > 0 && ` · ${parked} apagadas`}
        </p>
        <Button variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={switchView}>
          {asText ? "Tabla" : "Editar como texto"}
        </Button>
      </div>

      <p className="mt-1 max-w-3xl text-[11px] leading-5 text-slate-500">
        Se sustituyen como <span className="font-mono">{"{{nombre}}"}</span> en rutas, parámetros y cuerpos JSON. Las
        capturas de un flujo solo cambian la copia de estas variables durante esa corrida. Los secretos van en
        credenciales cifradas, nunca aquí.
      </p>

      {asText ? (
        <div className="mt-2">
          <textarea
            className={`${inputClass} h-48 font-mono text-xs`}
            value={text}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            placeholder={"userId:42\ntenant:acme\n//legacyId:7"}
          />
          <p className="mt-1 text-[11px] text-slate-400">
            Un <span className="font-mono">nombre:valor</span> por línea. Una línea que empieza por{" "}
            <span className="font-mono">//</span> es una variable apagada. También se acepta un objeto JSON pegado tal
            cual.
          </p>
          {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
        </div>
      ) : (
        <div className="mt-2 overflow-hidden rounded-xl border border-slate-200">
          <div className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.6fr)_5rem] items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <span className="sr-only">Activa</span>
            <span />
            <span>Variable</span>
            <span>Valor</span>
            <span />
          </div>
          {shown.map((row, index) => {
            const problem = problemAt(index);
            const ghost = index === shown.length - 1 && !row.name.trim() && !row.value;
            return (
              <div key={index} className="border-b border-slate-100 last:border-b-0">
                <div className="group grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.6fr)_5rem] items-center gap-2 px-2 py-1">
                  <input
                    type="checkbox"
                    className="justify-self-center"
                    aria-label={`Aplicar ${row.name || "la variable"}`}
                    checked={row.enabled}
                    disabled={disabled || ghost}
                    onChange={(event) => edit(index, { enabled: event.target.checked })}
                  />
                  <input
                    aria-label="Nombre de variable"
                    className={cn(
                      "h-8 w-full rounded-md border-0 bg-transparent px-2 font-mono text-xs outline-none focus:bg-slate-50",
                      problem && "text-rose-700",
                      !row.enabled && !ghost && "text-slate-400 line-through",
                    )}
                    value={row.name}
                    placeholder={ghost ? "nueva variable" : "userId"}
                    disabled={disabled}
                    onChange={(event) => edit(index, { name: event.target.value })}
                  />
                  <input
                    aria-label="Valor de variable"
                    className={cn(
                      "h-8 w-full rounded-md border-0 bg-transparent px-2 font-mono text-xs outline-none focus:bg-slate-50",
                      !row.enabled && !ghost && "text-slate-400",
                    )}
                    value={row.value}
                    placeholder={ghost ? "" : "123"}
                    disabled={disabled}
                    onChange={(event) => edit(index, { value: event.target.value })}
                  />
                  <span className="flex items-center justify-end gap-1">
                    {!ghost && (
                      <>
                        <button
                          type="button"
                          className="rounded px-1 text-[10px] text-slate-400 opacity-0 transition-opacity hover:text-slate-700 group-hover:opacity-100"
                          title={`Copiar {{${row.name}}}`}
                          onClick={() => void copy(row.name.trim())}
                          disabled={!row.name.trim()}
                        >
                          {copied === row.name.trim() ? "copiado" : "{{ }}"}
                        </button>
                        <button
                          type="button"
                          aria-label={`Eliminar ${row.name || "la variable"}`}
                          className="rounded px-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                          disabled={disabled}
                          onClick={() => onChange(withGhost(shown.filter((_row, position) => position !== index)))}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {problem && <p className="px-2 pb-1.5 pl-12 text-[11px] text-rose-600">{problem}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
