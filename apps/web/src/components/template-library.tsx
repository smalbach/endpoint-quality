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
export function TemplateLibrary({
  templates,
  operations,
  canEdit,
  onCreate,
  onAdd,
  onDelete,
  addDisabled,
  error,
}: {
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  canEdit: boolean;
  onCreate: (template: NewTemplate) => void;
  onAdd: (template: RequestTemplateView) => void;
  onDelete: (template: RequestTemplateView) => void;
  addDisabled: boolean;
  error: string | null;
}) {
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Pruebas reutilizables</p>
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
            setError(caught instanceof Error ? caught.message : "JSON inválido");
          }
        }}
      >
        Crear prueba
      </Button>
    </div>
  );
}
