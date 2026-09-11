import { useEffect, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import type { DatasetView } from "@/lib/types";

/**
 * The table a flow is walked once per row of.
 *
 * What turns «crear un producto» into «crear estos cuarenta», which is the difference between a
 * smoke test and a suite. The columns reach the steps as `{{dataset.nombre}}`, so a flow written
 * against one row works against a thousand without being edited.
 *
 * The rows are edited as text rather than in a grid, because the realistic way forty rows arrive
 * is pasted from somewhere else, and a grid is the slowest possible way to receive a paste. Both
 * shapes that get pasted are read: the JSON another tab or an export produces, and the CSV a
 * spreadsheet produces — which is where forty rows actually come from, since nobody types them as
 * objects. The column names are checked here for the same reason the API checks them:
 * `{{dataset.precio total}}` is not a token that will ever be substituted, and finding that out
 * mid-run makes it look like the target's fault.
 */
export function DatasetsPanel({
  datasets,
  selectedId,
  canEdit,
  onSelect,
  onCreate,
  onSave,
  onDelete,
  loadRows,
}: {
  datasets: DatasetView[];
  /** The one a run would walk. Empty is «once, with no data». */
  selectedId: string;
  canEdit: boolean;
  onSelect: (datasetId: string) => void;
  onCreate: (name: string) => void;
  onSave: (datasetId: string, rows: Record<string, string>[]) => void;
  onDelete: (datasetId: string) => void;
  loadRows: (datasetId: string) => Promise<Record<string, string>[]>;
}) {
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The list deliberately does not carry the rows — five hundred of them in the payload that draws
  // a page is a download nobody asked for — so opening one is what fetches them.
  useEffect(() => {
    if (!editing) return;
    let live = true;
    setError(null);
    void loadRows(editing)
      .then((rows) => live && setText(JSON.stringify(rows, null, 2)))
      .catch((caught: Error) => live && setError(caught.message));
    return () => {
      live = false;
    };
  }, [editing, loadRows]);

  function save() {
    const parsed = parseRows(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onSave(editing, parsed.rows);
    setEditing("");
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-800">Datos</p>
        {canEdit && (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => {
              const name = window.prompt("Nombre del conjunto");
              if (name?.trim()) onCreate(name.trim());
            }}
          >
            + Conjunto
          </Button>
        )}
      </div>

      {datasets.length === 0 ? (
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          Un conjunto recorre el flujo una vez por fila, y sus columnas se gastan como{" "}
          <span className="font-mono">{"{{dataset.nombre}}"}</span>.
        </p>
      ) : (
        <>
          <Field label="Recorrer con">
            <select className={inputClass} value={selectedId} onChange={(event) => onSelect(event.target.value)}>
              <option value="">Una vez, sin datos</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} · {dataset.rowCount} filas
                </option>
              ))}
            </select>
          </Field>

          <ul className="mt-1 space-y-1">
            {datasets.map((dataset) => (
              <li key={dataset.id} className="flex items-center gap-1 text-[11px] text-slate-600">
                <span className="flex-1 truncate">
                  {dataset.name}
                  <span className="ml-1 font-mono text-[10px] text-slate-400">{dataset.columns.join(", ")}</span>
                </span>
                {canEdit && (
                  <>
                    <button
                      className="px-1 text-[10px] text-slate-400 hover:text-slate-700"
                      onClick={() => setEditing(editing === dataset.id ? "" : dataset.id)}
                    >
                      {editing === dataset.id ? "cerrar" : "editar"}
                    </button>
                    <button
                      className="px-1 text-slate-400 hover:text-rose-600"
                      onClick={() => onDelete(dataset.id)}
                      aria-label={`Eliminar ${dataset.name}`}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {editing && (
        <div className="mt-2">
          <textarea
            className={`${inputClass} h-48 font-mono text-[11px]`}
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            placeholder={'nombre;precio\nprimera;9,90\n\n…o [{ "nombre": "primera" }]'}
          />
          <p className="mt-1 text-[11px] text-slate-400">
            CSV pegado de una hoja de cálculo, o una lista de objetos de nombre a valor. En CSV la primera línea son las
            columnas, separadas por «,» o «;», y un valor entre comillas puede llevar comas y saltos de línea. Los
            nombres son los de las variables, así que empiezan por letra o «_».
          </p>
          {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
          <Button className="mt-2 h-8 w-full text-xs" onClick={save}>
            Guardar filas
          </Button>
        </div>
      )}
    </div>
  );
}

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

type ParsedRows = { ok: true; rows: Record<string, string>[] } | { ok: false; error: string };

/**
 * The same rules the API applies, said before the request leaves rather than as a 422.
 *
 * Two shapes are accepted, told apart by the first character rather than by a format selector
 * somebody would have to find first: `[` or `{` is JSON, anything else is CSV. Both are things
 * that get pasted here for different reasons — JSON is what another tab or an export hands over,
 * CSV is what a spreadsheet hands over, and a spreadsheet is the realistic source of forty rows.
 * Guessing is safe rather than merely convenient: a CSV header starts with a column name, and a
 * column name has to start with a letter or «_», so no valid CSV can open like JSON.
 */
export function parseRows(text: string): ParsedRows {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, rows: [] };
  return trimmed.startsWith("[") || trimmed.startsWith("{") ? fromJson(trimmed) : fromCsv(trimmed);
}

function fromJson(text: string): ParsedRows {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : "JSON inválido" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "Los datos son una lista de filas" };

  const rows: Record<string, string>[] = [];
  for (const [index, row] of parsed.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, error: `Fila ${index + 1}: cada fila es un objeto de nombre a valor` };
    }
    for (const [name, value] of Object.entries(row as Record<string, unknown>)) {
      if (!COLUMN_NAME.test(name)) return { ok: false, error: `Fila ${index + 1}: «${name}» no es un nombre válido` };
      if (typeof value !== "string") return { ok: false, error: `Fila ${index + 1}: «${name}» no es texto` };
    }
    rows.push(row as Record<string, string>);
  }
  return { ok: true, rows };
}

/**
 * A spreadsheet selection, pasted.
 *
 * Everything a cell held becomes text and nothing is converted, which is not laziness: `007` is a
 * customer number, `1.10` is a version, and a run substitutes whatever is here into a URL or a
 * body as characters. Reading them as numbers would be a lossy round trip that only ever loses
 * the cases somebody chose the spreadsheet to keep.
 *
 * A row with more or fewer fields than the header is an error rather than something to pad or
 * cut, because both repairs are silent and both are guesses. A short row means the paste lost a
 * column, and inventing an empty value for it hides that until a run puts «» into a request and
 * the target answers something that looks like the target's fault.
 */
function fromCsv(text: string): ParsedRows {
  const split = splitCsv(text, separatorOf(text));
  if (!split.ok) return split;
  const [header, ...body] = split.records;
  if (!header) return { ok: true, rows: [] };

  // Quoted header cells keep whatever is between the quotes, so the trim that the unquoted path
  // already did has to be repeated here to make «"nombre "» and «nombre » mean the same column.
  const columns = header.fields.map((name) => name.trim());
  const invalid = columns.find((name) => !COLUMN_NAME.test(name));
  if (invalid !== undefined) return { ok: false, error: `Línea 1: «${invalid}» no es un nombre válido` };
  const repeated = columns.find((name, index) => columns.indexOf(name) !== index);
  if (repeated !== undefined) return { ok: false, error: `Línea 1: «${repeated}» está dos veces` };

  const rows: Record<string, string>[] = [];
  for (const record of body) {
    if (record.fields.length !== columns.length) {
      const detail = `${record.fields.length} campos donde la cabecera tiene ${columns.length}`;
      return { ok: false, error: `Línea ${record.line}: ${detail}` };
    }
    rows.push(Object.fromEntries(columns.map((name, index) => [name, record.fields[index]])));
  }
  return { ok: true, rows };
}

/**
 * Which separator the file uses, counted rather than configured.
 *
 * Nobody who pastes a CSV picked its separator: a spreadsheet in a Spanish locale writes «;» and
 * one in an English locale writes «,», and both arrive here as «the thing I copied». Only the
 * header line votes, and only outside quotes, so a comma living inside a value cannot outnumber
 * the semicolons that actually divide the columns. A tie — including a single-column file, where
 * neither appears — resolves to «,», which is the one that is also the standard.
 */
function separatorOf(text: string): string {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const char of text) {
    // An escaped `""` flips this twice and so counts as nothing either way, which is the right
    // answer for a tally: what matters is only whether the next comma is inside a value.
    if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (char === "\n") break;
    else if (char === ",") commas += 1;
    else if (char === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

/** A record and the line its first field started on — not its index among the records, because a
 * quoted value may contain newlines and then the two stop agreeing. The line is the number the
 * editor's own cursor shows, which is the one worth putting in an error. */
type CsvRecord = { line: number; fields: string[] };

/**
 * The text, cut into records and fields.
 *
 * Quoting is implemented rather than approximated because it is not a corner case: a spreadsheet
 * wraps a cell in quotes the moment its content holds the separator, a newline or a quote, so the
 * values that break a `split(",")` are exactly the ones somebody reached for a spreadsheet to
 * write. Inside quotes the separator and newlines are content, and `""` is one literal quote.
 *
 * Outside quotes the field is trimmed, which is the same decision twice: the spaces someone typed
 * around a column name are not part of the name, and the «\r» of a CRLF file is not part of the
 * last value of a line. A quoted field is never trimmed — asking for the spaces is what the
 * quotes are for.
 */
function splitCsv(text: string, separator: string): { ok: true; records: CsvRecord[] } | { ok: false; error: string } {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let line = 1;
  let began = 1;
  let index = 0;

  const close = () => {
    // A record of one empty field is a blank line. Dropping it is what lets a paste that carries a
    // stray newline through the middle of it work at all; the cost is that a single-column file
    // cannot express a row whose only value is empty, which is a row nobody means to walk.
    if (fields.length > 1 || (fields.length === 1 && fields[0] !== "")) records.push({ line: began, fields });
    fields = [];
    began = line;
  };

  while (index < text.length) {
    let value = "";
    if (text[index] === '"') {
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '"') {
          if (text[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        if (text[index] === "\n") line += 1;
        value += text[index];
        index += 1;
      }
      if (!closed) return { ok: false, error: `Línea ${began}: falta la comilla de cierre` };
      while (text[index] === " " || text[index] === "\t") index += 1;
    } else {
      const from = index;
      while (index < text.length && text[index] !== separator && text[index] !== "\n") index += 1;
      value = text.slice(from, index).trim();
    }
    fields.push(value);

    if (index >= text.length) break;
    if (text[index] === separator) {
      index += 1;
      continue;
    }
    if (text[index] === "\r") index += 1;
    if (index >= text.length) break;
    if (text[index] !== "\n") return { ok: false, error: `Línea ${began}: sobra texto tras las comillas` };
    index += 1;
    line += 1;
    close();
  }
  close();
  return { ok: true, records };
}
