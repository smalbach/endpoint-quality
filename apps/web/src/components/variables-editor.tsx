import { useEffect, useState } from "react";
import { Button, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import { MASKED_VALUE, bulkFrom, emptyRow, isBlank, parseBulk, type VariableRow } from "@/lib/env-variables";

/**
 * The variables table, the way Postman draws it.
 *
 * Six things it borrows, each because the old editor was worse for the lack of it:
 *
 * - **a checkbox per row**, so a value can be parked instead of deleted;
 * - **two value columns** — the one the project shares and the one this run spends — so that
 *   debugging with a throwaway token stops rewriting what everybody else pulls;
 * - **a secret toggle**, after which the value is ciphertext in the database and eight dots here;
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
  onReveal,
}: {
  rows: VariableRow[];
  problems: { index: number; detail: string }[];
  disabled: boolean;
  onChange: (rows: VariableRow[]) => void;
  /** Asks the API for the clear text of the secrets, when whoever is looking is allowed to. Absent
   * for everyone below `admin`, which is why the button is not merely disabled for them. */
  onReveal?: () => Promise<Record<string, string>>;
}) {
  const [asText, setAsText] = useState(false);
  const [text, setText] = useState(() => bulkFrom(rows));
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  // Editing in the table while the text view holds a stale copy is how a switch silently reverts
  // what was just typed. It is only carried in the direction that is not being edited.
  useEffect(() => {
    if (!asText) setText(bulkFrom(rows));
  }, [rows, asText]);

  const active = rows.filter((row) => row.name.trim() && row.enabled).length;
  const parked = rows.filter((row) => row.name.trim() && !row.enabled).length;
  const secrets = rows.filter((row) => row.name.trim() && row.sensitive).length;
  const problemAt = (index: number) => problems.find((problem) => problem.index === index)?.detail;

  /** The blank row at the bottom, always. Typing in it is what creates a variable. */
  const withGhost = (next: VariableRow[]) =>
    next.length > 0 && isBlank(next[next.length - 1]) ? next : [...next, emptyRow()];
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
    // The rows going in are what keeps `initial` and `sensitive` across the trip: one line of text
    // cannot say three things, so what it does not say is carried over rather than defaulted.
    const parsed = parseBulk(text, rows);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    onChange(withGhost(parsed.rows));
    setError(null);
    setAsText(false);
  }

  async function reveal() {
    if (!onReveal) return;
    setRevealing(true);
    setError(null);
    try {
      const revealed = await onReveal();
      // Only `current` is filled. `initial` stays masked, and the mask is what tells the API to
      // leave the shared value exactly as it was — revealing a secret must not rewrite one.
      onChange(rows.map((row) => (row.name in revealed ? { ...row, current: revealed[row.name] } : row)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudieron leer los secretos");
    } finally {
      setRevealing(false);
    }
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
          {secrets > 0 && ` · ${secrets} secretas`}
        </p>
        {onReveal && secrets > 0 && (
          <Button
            variant="ghost"
            className="ml-auto h-7 px-2 text-xs"
            onClick={() => void reveal()}
            disabled={revealing}
          >
            {revealing ? "Leyendo…" : "Ver secretos"}
          </Button>
        )}
        <Button
          variant="ghost"
          className={cn("h-7 px-2 text-xs", !(onReveal && secrets > 0) && "ml-auto")}
          onClick={switchView}
        >
          {asText ? "Tabla" : "Editar como texto"}
        </Button>
      </div>

      <p className="mt-1 max-w-3xl text-[11px] leading-5 text-slate-500">
        Se sustituyen como <span className="font-mono">{"{{nombre}}"}</span> en rutas, parámetros y cuerpos JSON. Una
        corrida gasta el <span className="font-medium">valor actual</span>; el inicial es el que comparte el proyecto.
        Las capturas de un flujo solo cambian la copia de estas variables durante esa corrida.
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
            Un <span className="font-mono">nombre:valor</span> por línea, con el valor actual. Una línea que empieza por{" "}
            <span className="font-mono">//</span> es una variable apagada. También se acepta un objeto JSON pegado tal
            cual.
          </p>
          {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
        </div>
      ) : (
        <div className="mt-2 overflow-hidden rounded-xl border border-slate-200">
          <div className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_3rem_4.5rem] items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <span className="sr-only">Activa</span>
            <span />
            <span>Variable</span>
            <span>Valor inicial</span>
            <span>Valor actual</span>
            <span className="text-center">Secreta</span>
            <span />
          </div>
          {shown.map((row, index) => {
            const problem = problemAt(index);
            const ghost = index === shown.length - 1 && isBlank(row);
            const valueClass = cn(
              "h-8 w-full rounded-md border-0 bg-transparent px-2 font-mono text-xs outline-none focus:bg-slate-50",
              !row.enabled && !ghost && "text-slate-400",
              row.sensitive && "text-violet-700",
            );
            return (
              <div key={index} className="border-b border-slate-100 last:border-b-0">
                <div className="group grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_3rem_4.5rem] items-center gap-2 px-2 py-1">
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
                    aria-label="Valor inicial"
                    className={valueClass}
                    value={row.initial}
                    placeholder={ghost ? "" : "123"}
                    disabled={disabled}
                    onChange={(event) => edit(index, { initial: event.target.value })}
                  />
                  <input
                    aria-label="Valor actual"
                    className={valueClass}
                    value={row.current}
                    placeholder={ghost ? "" : row.initial || "123"}
                    disabled={disabled}
                    onChange={(event) => edit(index, { current: event.target.value })}
                  />
                  <input
                    type="checkbox"
                    className="justify-self-center"
                    aria-label={`Guardar ${row.name || "la variable"} cifrada`}
                    checked={row.sensitive}
                    disabled={disabled || ghost}
                    // Ticking it hides a value that is already on screen and in this tab's memory;
                    // it does not un-leak it. What it does is stop the next reader from seeing it,
                    // which is why the field is left as typed and only the storage changes.
                    onChange={(event) => edit(index, { sensitive: event.target.checked })}
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
      {!asText && error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
      {secrets > 0 && (
        <p className="mt-1 text-[11px] text-slate-400">
          Una variable secreta se guarda cifrada y sale de la API como <span className="font-mono">{MASKED_VALUE}</span>
          . Devolver la máscara la deja como estaba, que es lo que permite editar el resto del entorno sin haber visto
          el secreto.
        </p>
      )}
    </div>
  );
}
