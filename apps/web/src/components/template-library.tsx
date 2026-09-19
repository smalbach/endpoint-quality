import { useEffect, useState } from "react";

import { Button, Field, inputClass } from "@/components/ui";
import type { OperationSummary } from "@/lib/workflow-draft";
import type { RequestBodyView, RequestTemplateView } from "@/lib/types";

export type NewTemplate = {
  name: string;
  operationId: string;
  expectedStatus: number;
  parameters: Record<string, string>;
  body: RequestBodyView;
};

/**
 * The library of saved requests, and the form that adds one.
 *
 * A request is created against the server the moment it is named, not held in a draft: it is a row
 * that other flows will reference, and «saved locally in this tab» is not a state a shared thing
 * should have.
 */
/** The colour each verb wears in the operations catalogue, so a GET reads apart from a DELETE at a
 * glance. Matches the palette the canvas nodes use. */
const METHOD_BADGE: Record<string, string> = {
  GET: "bg-sky-50 text-sky-700 ring-sky-200",
  POST: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  PUT: "bg-amber-50 text-amber-700 ring-amber-200",
  PATCH: "bg-amber-50 text-amber-700 ring-amber-200",
  DELETE: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function TemplateLibrary({
  templates,
  operations,
  canEdit,
  onCreate,
  onAdd,
  onAddOperation,
  onDelete,
  addDisabled,
  adding,
  error,
}: {
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  canEdit: boolean;
  onCreate: (template: NewTemplate) => void;
  onAdd: (template: RequestTemplateView) => void;
  onAddOperation: (operation: OperationSummary) => void;
  onDelete: (template: RequestTemplateView) => void;
  addDisabled: boolean;
  adding: boolean;
  error: string | null;
}) {
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  return (
    <div>
      {canEdit && (
        <OperationCatalogue
          operations={operations}
          onAdd={onAddOperation}
          disabled={addDisabled || adding}
          busy={adding}
        />
      )}
      <p className="mt-4 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Pruebas reutilizables</p>
      <div className="mt-2 space-y-1">
        {templates.length === 0 && <p className="text-[11px] text-slate-400">Ninguna guardada todavía.</p>}
        {templates.map((template) => (
          <div key={template.id} className="rounded-lg border border-slate-200">
            <button
              disabled={addDisabled}
              onClick={() => onAdd(template)}
              className="w-full p-2 text-left hover:bg-slate-50 disabled:opacity-40"
              title={addDisabled ? "Selecciona un flujo primero" : "Añadir al flujo"}
            >
              <span className="block truncate text-xs font-medium text-slate-700">+ {template.name}</span>
              <span className="block truncate font-mono text-[10px] text-slate-400">
                {operationById.get(template.operationId)?.path ?? template.operationId}
              </span>
            </button>
            {canEdit && (
              <button className="px-2 pb-1 text-[10px] text-rose-600" onClick={() => onDelete(template)}>
                Eliminar
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-[10px] text-rose-600">{error}</p>}
      {canEdit && <TemplateCreator operations={operations} onCreate={onCreate} />}
    </div>
  );
}

/**
 * The contract's operations, each a click away from being a node. This is the quick path: one tap
 * drops a request for that operation into the open flow, named after it and with the status its
 * verb usually answers. The form below is for when the default is not enough. A filter keeps a big
 * contract usable.
 */
function OperationCatalogue({
  operations,
  onAdd,
  disabled,
  busy,
}: {
  operations: OperationSummary[];
  onAdd: (operation: OperationSummary) => void;
  disabled: boolean;
  busy: boolean;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? operations.filter((operation) =>
        `${operation.method} ${operation.path} ${operation.summary}`.toLowerCase().includes(needle),
      )
    : operations;
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Operaciones del contrato</p>
      {operations.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-400">Este entorno no expone operaciones.</p>
      ) : (
        <>
          <input
            className={`${inputClass} mt-2 h-8`}
            value={filter}
            placeholder="Filtrar por ruta o método…"
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-0.5">
            {shown.length === 0 && <p className="text-[11px] text-slate-400">Nada coincide.</p>}
            {shown.map((operation) => (
              <button
                key={operation.id}
                disabled={disabled}
                onClick={() => onAdd(operation)}
                className="flex w-full items-center gap-2 rounded-lg border border-slate-200 p-2 text-left hover:bg-slate-50 disabled:opacity-40"
                title={disabled ? (busy ? "Añadiendo…" : "Selecciona un flujo primero") : "Añadir al flujo"}
              >
                <span
                  className={`inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ring-1 ring-inset ${
                    METHOD_BADGE[operation.method.toUpperCase()] ?? "bg-slate-100 text-slate-600 ring-slate-200"
                  }`}
                >
                  {operation.method.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[10px] text-slate-600">{operation.path}</span>
                  {operation.summary && (
                    <span className="block truncate text-[10px] text-slate-400">{operation.summary}</span>
                  )}
                </span>
                <span className="shrink-0 text-sm leading-none text-slate-400">+</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TemplateCreator({
  operations,
  onCreate,
}: {
  operations: OperationSummary[];
  onCreate: (template: NewTemplate) => void;
}) {
  const [operationId, setOperationId] = useState(operations[0]?.id ?? "");
  const [name, setName] = useState("");
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [parameters, setParameters] = useState("{}");
  const [body, setBody] = useState("{}");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!operationId && operations[0]) setOperationId(operations[0].id);
  }, [operations, operationId]);

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <p className="text-xs font-semibold text-slate-800">Nueva prueba</p>
      <Field label="Operación">
        <select className={inputClass} value={operationId} onChange={(event) => setOperationId(event.target.value)}>
          {operations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.method} {item.path}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Nombre">
        <input
          className={inputClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Actualizar perfil"
        />
      </Field>
      <Field label="Estado esperado">
        <input
          className={inputClass}
          type="number"
          min={100}
          max={599}
          value={expectedStatus}
          onChange={(event) => setExpectedStatus(Number(event.target.value))}
        />
      </Field>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-slate-500">Parámetros y body</summary>
        <Field label="Parámetros JSON" hint="Acepta {{variables}} del entorno o capturadas antes.">
          <textarea
            className={`${inputClass} h-16 font-mono text-[10px]`}
            value={parameters}
            spellCheck={false}
            onChange={(event) => setParameters(event.target.value)}
          />
        </Field>
        <Field label="Body JSON">
          <textarea
            className={`${inputClass} h-20 font-mono text-[10px]`}
            value={body}
            spellCheck={false}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
      </details>
      {error && <p className="mt-1 text-[10px] text-rose-600">{error}</p>}
      <Button
        variant="ghost"
        className="mt-2 h-8 w-full text-xs"
        disabled={!name.trim() || !operationId}
        onClick={() => {
          try {
            const parsedParameters = JSON.parse(parameters) as Record<string, string>;
            const parsedBody = JSON.parse(body) as Record<string, unknown>;
            onCreate({
              name: name.trim(),
              operationId,
              expectedStatus,
              parameters: parsedParameters,
              // JSON or nothing, which is what this two-field form can honestly offer. The other
              // three types need a selector and a content type, and they are one click away in the
              // inspector — where the request is actually written, and where the «Enviar» button
              // is that says whether it worked.
              body: Object.keys(parsedBody).length ? { type: "json", json: parsedBody } : { type: "none" },
            });
            setName("");
            setError(null);
          } catch (caught) {
            // Lo único que lanza aquí es `JSON.parse`, y lanza un `SyntaxError` con el motivo.
            setError((caught as Error).message);
          }
        }}
      >
        Crear prueba
      </Button>
    </div>
  );
}
