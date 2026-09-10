import { Button, Field, inputClass } from "@/components/ui";
import { JsonObjectField } from "@/components/json-object-field";
import { removeStep, replaceStep } from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import type { Environment, RequestTemplateView, WorkflowStepView, WorkflowView } from "@/lib/types";

const AUTH = ["default", "none", "insufficient", "api-key"];

/** The panel on the right: the flow itself, the selected node, and the button that runs it. */
export function WorkflowInspector({
  workflow,
  steps,
  selectedStep,
  templates,
  operations,
  environments,
  environmentId,
  canEdit,
  onEnvironment,
  onWorkflow,
  onSteps,
  onTemplate,
  onRun,
  onDelete,
  running,
}: {
  workflow: WorkflowView;
  steps: WorkflowStepView[];
  selectedStep: string;
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  environments: Environment[];
  environmentId: string;
  canEdit: boolean;
  onEnvironment: (id: string) => void;
  onWorkflow: (change: Partial<Pick<WorkflowView, "name" | "description">>) => void;
  onSteps: (steps: WorkflowStepView[]) => void;
  onTemplate: (template: RequestTemplateView) => void;
  onRun: () => void;
  onDelete: () => void;
  running: boolean;
}) {
  const step = steps.find((item) => item.id === selectedStep);
  const template = step && templates.find((item) => item.id === step.requestTemplateId);

  return (
    <div>
      <Field label="Nombre del flujo">
        <input
          className={inputClass}
          value={workflow.name}
          disabled={!canEdit}
          onChange={(event) => onWorkflow({ name: event.target.value })}
        />
      </Field>
      <Field label="Descripción">
        <textarea
          className={`${inputClass} h-20`}
          value={workflow.description ?? ""}
          disabled={!canEdit}
          onChange={(event) => onWorkflow({ description: event.target.value })}
        />
      </Field>

      <div className="mt-4 border-t border-slate-100 pt-3">
        {step ? (
          <StepInspector
            step={step}
            template={template}
            operations={operations}
            canEdit={canEdit}
            onTemplate={onTemplate}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : (
          <p className="text-xs text-slate-500">Selecciona un nodo para configurar sus capturas.</p>
        )}
      </div>

      <div className="mt-5 border-t border-slate-100 pt-3">
        <Field label="Entorno">
          <select className={inputClass} value={environmentId} onChange={(event) => onEnvironment(event.target.value)}>
            <option value="">Selecciona…</option>
            {environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Button className="mt-2 w-full" disabled={!environmentId || !steps.length || running} onClick={onRun}>
          Ejecutar flujo
        </Button>
        {canEdit && (
          <Button variant="danger" className="mt-2 h-8 w-full text-xs" onClick={onDelete}>
            Eliminar flujo
          </Button>
        )}
      </div>
    </div>
  );
}

function StepInspector({
  step,
  template,
  operations,
  canEdit,
  onTemplate,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  template: RequestTemplateView | undefined;
  operations: OperationSummary[];
  canEdit: boolean;
  onTemplate: (template: RequestTemplateView) => void;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const captures = step.captures ?? [];
  const editCaptures = (next: typeof captures) => onChange({ ...step, captures: next });

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Prueba reutilizable</p>
      {/* Edited here, saved to its own row: the change reaches every other flow that uses it. */}
      {template ? (
        <div className="mt-2 rounded-lg border border-slate-200 p-2">
          <Field label="Operación">
            <select
              className={inputClass}
              value={template.operationId}
              disabled={!canEdit}
              onChange={(event) => onTemplate({ ...template, operationId: event.target.value })}
            >
              {operations.map((operation) => (
                <option key={operation.id} value={operation.id}>
                  {operation.method} {operation.path}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nombre">
            <input
              className={inputClass}
              value={template.name}
              disabled={!canEdit}
              onChange={(event) => onTemplate({ ...template, name: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Estado">
              <input
                className={inputClass}
                type="number"
                min={100}
                max={599}
                value={template.expectedStatus}
                disabled={!canEdit}
                onChange={(event) => onTemplate({ ...template, expectedStatus: Number(event.target.value) })}
              />
            </Field>
            <Field label="Auth">
              <select
                className={inputClass}
                value={template.auth}
                disabled={!canEdit}
                onChange={(event) => onTemplate({ ...template, auth: event.target.value })}
              >
                {AUTH.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <JsonObjectField
            label="Parámetros"
            value={template.parameters}
            onChange={(value) => onTemplate({ ...template, parameters: value as Record<string, string> })}
          />
          <JsonObjectField
            label="Body"
            value={template.body ?? {}}
            onChange={(value) => onTemplate({ ...template, body: Object.keys(value).length ? value : null })}
          />
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-rose-600">
          Este paso apunta a una prueba que ya no existe. Bórralo o vuelve a crearla.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        Extrae campos de esta respuesta para los pasos siguientes. Un campo del cuerpo usa una ruta como{" "}
        <span className="font-mono">data.id</span>; una cabecera, su nombre.
      </p>
      <div className="mt-2 space-y-2">
        {captures.map((capture, index) => (
          <div key={index} className="rounded-lg border border-slate-200 p-2">
            <input
              aria-label="Variable capturada"
              className={inputClass}
              value={capture.variable}
              placeholder="userId"
              disabled={!canEdit}
              onChange={(event) =>
                editCaptures(
                  captures.map((item, position) =>
                    position === index ? { ...item, variable: event.target.value } : item,
                  ),
                )
              }
            />
            <div className="grid grid-cols-[90px_1fr] gap-2">
              <select
                className={inputClass}
                value={capture.from}
                disabled={!canEdit}
                onChange={(event) =>
                  editCaptures(
                    captures.map((item, position) =>
                      position === index ? { ...item, from: event.target.value as "body" | "header" } : item,
                    ),
                  )
                }
              >
                <option value="body">body</option>
                <option value="header">header</option>
              </select>
              <input
                aria-label="Ruta de captura"
                className={inputClass}
                value={capture.path}
                placeholder="data.id"
                disabled={!canEdit}
                onChange={(event) =>
                  editCaptures(
                    captures.map((item, position) =>
                      position === index ? { ...item, path: event.target.value } : item,
                    ),
                  )
                }
              />
            </div>
            {canEdit && (
              <button
                className="mt-1 text-[10px] text-rose-600"
                onClick={() => editCaptures(captures.filter((_item, position) => position !== index))}
              >
                Eliminar captura
              </button>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <>
          <Button
            variant="ghost"
            className="mt-2 h-8 text-xs"
            onClick={() => editCaptures([...captures, { variable: "", from: "body", path: "" }])}
          >
            + Captura
          </Button>
          <Button variant="danger" className="mt-4 h-8 w-full text-xs" onClick={onRemove}>
            Eliminar paso
          </Button>
        </>
      )}
    </div>
  );
}
