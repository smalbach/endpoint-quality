import { cn } from "@/lib/format";
import { emptyFieldRow, isBlankField, type FieldRow } from "@/lib/request-fields";

/**
 * The parameters and the headers of a request, as a table with a switch per row.
 *
 * It replaces a `textarea` holding raw JSON, which is what the inspector asked somebody to edit
 * before. Three things that field could not do and this one does:
 *
 * - **park a row instead of deleting it.** The checkbox is the whole feature: the value somebody
 *   deleted to stop sending it is exactly the one they had spent an afternoon finding.
 * - **say what is wrong next to what is wrong.** A duplicate name or a header with a line break in
 *   it was a 422 about `headers` after a round trip; here it is a line under the row.
 * - **be typed in without knowing JSON.** `{"id": "{{thingId}}"}` has four kinds of punctuation in
 *   it that mean nothing to the person writing a test, and one of them is a syntax error away from
 *   losing the whole field.
 *
 * The rows are the caller's state — the same division as `VariablesEditor`, whose table this is
 * the narrow version of. Everything decidable without a DOM is in `lib/request-fields.ts`.
 */
export function RequestFieldsEditor({
  label,
  hint,
  rows,
  problems,
  namePlaceholder,
  valuePlaceholder,
  disabled,
  onChange,
  renderValue,
}: {
  label: string;
  hint?: string;
  rows: FieldRow[];
  problems: { index: number; detail: string }[];
  namePlaceholder: string;
  valuePlaceholder: string;
  disabled: boolean;
  onChange: (rows: FieldRow[]) => void;
  /** Lets the caller wrap the value input — the `{{` suggestions are drawn around it. Absent
   * renders the plain field, which is what the value is without them. */
  renderValue?: (input: React.ReactNode, row: FieldRow, index: number) => React.ReactNode;
}) {
  /** The blank row at the bottom, always. Typing in it is what creates a parameter. */
  const withGhost = (next: FieldRow[]) =>
    next.length > 0 && isBlankField(next[next.length - 1]) ? next : [...next, emptyFieldRow()];
  // Rendered rows, ghost included — and **what an edit applies to**. Applying it to the rows the
  // parent holds instead means the ghost has no index there, so the first keystroke in it matches
  // nothing and is dropped: typing a name would silently begin at its second letter.
  const shown = withGhost(rows);
  const edit = (index: number, patch: Partial<FieldRow>) =>
    onChange(withGhost(shown.map((row, position) => (position === index ? { ...row, ...patch } : row))));
  const problemAt = (index: number) => problems.find((problem) => problem.index === index)?.detail;
  const parked = rows.filter((row) => row.name.trim() && !row.enabled).length;

  return (
    <div className="mt-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        {parked > 0 && (
          <span className="text-[10px] text-slate-400">
            {parked} {parked === 1 ? "apagado" : "apagados"}
          </span>
        )}
      </div>
      {hint && <p className="text-[10px] leading-4 text-slate-400">{hint}</p>}
      <div className="mt-1 overflow-hidden rounded-lg border border-slate-200">
        {shown.map((row, index) => {
          const problem = problemAt(index);
          const ghost = index === shown.length - 1 && isBlankField(row);
          const valueInput = (
            <input
              aria-label={`Valor de ${row.name || label.toLowerCase()}`}
              className={cn(
                "h-7 w-full rounded-md border-0 bg-transparent px-1.5 font-mono text-[11px] outline-none focus:bg-slate-50",
                !row.enabled && !ghost && "text-slate-400",
              )}
              value={row.value}
              placeholder={ghost ? "" : valuePlaceholder}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => edit(index, { value: event.target.value })}
            />
          );
          return (
            <div key={index} className="border-b border-slate-100 last:border-b-0">
              <div className="group grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1.2fr)_1.25rem] items-center gap-1 px-1 py-0.5">
                <input
                  type="checkbox"
                  className="justify-self-center"
                  aria-label={`Enviar ${row.name || label.toLowerCase()}`}
                  checked={row.enabled}
                  disabled={disabled || ghost}
                  onChange={(event) => edit(index, { enabled: event.target.checked })}
                />
                <input
                  aria-label={`Nombre de ${label.toLowerCase()}`}
                  className={cn(
                    "h-7 w-full rounded-md border-0 bg-transparent px-1.5 font-mono text-[11px] outline-none focus:bg-slate-50",
                    problem && "text-rose-700",
                    !row.enabled && !ghost && "text-slate-400 line-through",
                  )}
                  value={row.name}
                  placeholder={ghost ? namePlaceholder : ""}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(event) => edit(index, { name: event.target.value })}
                />
                {renderValue ? renderValue(valueInput, row, index) : valueInput}
                {!ghost && (
                  <button
                    type="button"
                    aria-label={`Eliminar ${row.name || label.toLowerCase()}`}
                    className="rounded text-slate-400 hover:text-rose-600 disabled:opacity-30"
                    disabled={disabled}
                    onClick={() => onChange(withGhost(shown.filter((_row, position) => position !== index)))}
                  >
                    ×
                  </button>
                )}
              </div>
              {problem && <p className="px-1 pb-1 pl-8 text-[10px] text-rose-600">{problem}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
