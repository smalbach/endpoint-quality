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
 * The rows are edited as text — one JSON object per row, or the whole array — rather than in a
 * grid, because the realistic way forty rows arrive is pasted from somewhere else, and a grid is
 * the slowest possible way to receive a paste. The column names are checked here for the same
 * reason the API checks them: `{{dataset.precio total}}` is not a token that will ever be
 * substituted, and finding that out mid-run makes it look like the target's fault.
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
            placeholder='[{ "nombre": "primera" }, { "nombre": "segunda" }]'
          />
          <p className="mt-1 text-[11px] text-slate-400">
            Una lista de objetos de nombre a valor. Los nombres son los de las variables, así que empiezan por letra o
            «_».
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

/** The same rules the API applies, said before the request leaves rather than as a 422. */
export function parseRows(text: string): { ok: true; rows: Record<string, string>[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, rows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
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
