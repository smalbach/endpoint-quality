import { Button, Field, inputClass } from "@/components/ui";
import { JsonObjectField } from "@/components/json-object-field";
import { removeStep, replaceStep } from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import type { Environment, RequestTemplateView, StepCheckView, WorkflowStepView, WorkflowView } from "@/lib/types";

const AUTH = ["default", "none", "insufficient", "api-key"];

/** The same lists the engine validates against, written here because the contract package emits
 * no runtime. A value the engine does not know is a 422 on save, which is where it belongs. */
const CHECK_SOURCES: StepCheckView["source"][] = ["status", "body", "header", "durationMs"];
const CHECK_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "less_than",
  "exists",
  "not_exists",
  "matches",
  "is_array",
  "is_not_empty",
  "has_length",
];
/** The operators that judge the value on its own, so the form hides the second field for them. */
const WITHOUT_OPERAND = ["exists", "not_exists", "is_array", "is_not_empty"];
const ON_ERROR: { value: NonNullable<WorkflowStepView["onError"]>; label: string; hint: string }[] = [
  {
    value: "skip-dependents",
    label: "Saltar lo que dependa",
    hint: "«creó mal, luego leyó mal» es un hallazgo contado dos veces",
  },
  { value: "continue", label: "Continuar igual", hint: "para el paso del que el resto no depende de verdad" },
  { value: "stop", label: "Detener el flujo", hint: "cuando sin este paso todo lo demás informa de otra cosa" },
];

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
        <Button
          variant="ghost"
          className="mt-2 h-8 text-xs"
          onClick={() => editCaptures([...captures, { variable: "", from: "body", path: "" }])}
        >
          + Captura
        </Button>
      )}

      <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />
      <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />

      {canEdit && (
        <Button variant="danger" className="mt-4 h-8 w-full text-xs" onClick={onRemove}>
          Eliminar paso
        </Button>
      )}
    </div>
  );
}

/**
 * What this step's author claims, beyond what the contract already says.
 *
 * The matrix asserts the things a document can be held to. These are the ones no document
 * expresses — «esta lista no está vacía», «responde en menos de 300 ms» — and they are written
 * rather than derived, which is why they live on the step and travel with it.
 */
function ChecksEditor({
  step,
  canEdit,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
}) {
  const checks = step.checks ?? [];
  const edit = (next: StepCheckView[]) => onChange({ ...step, checks: next.length ? next : undefined });
  const patch = (index: number, change: Partial<StepCheckView>) =>
    edit(checks.map((item, position) => (position === index ? { ...item, ...change } : item)));

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <p className="text-xs font-semibold text-slate-800">Comprobaciones</p>
      <p className="mt-1 text-[11px] leading-5 text-slate-500">
        Lo que el contrato no dice: que la lista trae algo, que el total cuadra, que responde a tiempo. Un{" "}
        <span className="font-medium">aviso</span> queda escrito y no pone el caso en rojo.
      </p>
      <div className="mt-2 space-y-2">
        {checks.map((check, index) => (
          <div key={index} className="rounded-lg border border-slate-200 p-2">
            <div className="grid grid-cols-[5.5rem_1fr] gap-2">
              <select
                aria-label="Origen"
                className={inputClass}
                value={check.source}
                disabled={!canEdit}
                onChange={(event) => patch(index, { source: event.target.value as StepCheckView["source"] })}
              >
                {CHECK_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              <input
                aria-label="Ruta o cabecera"
                className={inputClass}
                value={check.path ?? ""}
                placeholder={check.source === "header" ? "X-Total-Count" : "data.0.id"}
                disabled={!canEdit || check.source === "status" || check.source === "durationMs"}
                onChange={(event) => patch(index, { path: event.target.value })}
              />
            </div>
            <div className="mt-2 grid grid-cols-[8rem_1fr] gap-2">
              <select
                aria-label="Operador"
                className={inputClass}
                value={check.operator}
                disabled={!canEdit}
                onChange={(event) => patch(index, { operator: event.target.value })}
              >
                {CHECK_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
              {!WITHOUT_OPERAND.includes(check.operator) && (
                <input
                  aria-label="Valor esperado"
                  className={inputClass}
                  value={check.value === undefined ? "" : String(check.value)}
                  placeholder="200"
                  disabled={!canEdit}
                  onChange={(event) => patch(index, { value: event.target.value })}
                />
              )}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={check.severity === "warning"}
                  disabled={!canEdit}
                  onChange={(event) => patch(index, { severity: event.target.checked ? "warning" : undefined })}
                />
                Solo aviso
              </label>
              {canEdit && (
                <button
                  className="text-[10px] text-rose-600"
                  onClick={() => edit(checks.filter((_item, position) => position !== index))}
                >
                  Eliminar
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {canEdit && (
        <Button
          variant="ghost"
          className="mt-2 h-8 text-xs"
          onClick={() => edit([...checks, { source: "status", operator: "equals", value: "200" }])}
        >
          + Comprobación
        </Button>
      )}
    </div>
  );
}

/**
 * Qué pasa cuando este paso no pasa.
 *
 * El reintento está apagado por defecto y cuesta un clic encenderlo a propósito: **repetir un paso
 * es afirmar que el fallo no era real**, y una suite que reintenta por defecto informa de un
 * destino inestable como si estuviera sano. El aviso sobre las escrituras no es decorativo: sin
 * acotar por estado, un POST reintentado escribe una vez por intento.
 */
function FailureEditor({
  step,
  canEdit,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
}) {
  const retry = step.retry;
  const writes = (value: string): number[] =>
    value
      .split(/[\s,]+/)
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 100 && item <= 599);

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <Field label="Si este paso falla">
        <select
          className={inputClass}
          value={step.onError ?? "skip-dependents"}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...step, onError: event.target.value as WorkflowStepView["onError"] })}
        >
          {ON_ERROR.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[11px] leading-5 text-slate-500">
        {ON_ERROR.find((option) => option.value === (step.onError ?? "skip-dependents"))?.hint}
      </p>

      <label className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
        <input
          type="checkbox"
          checked={Boolean(retry)}
          disabled={!canEdit}
          onChange={(event) =>
            onChange({ ...step, retry: event.target.checked ? { attempts: 2, delayMs: 500, backoff: 2 } : undefined })
          }
        />
        Reintentar
      </label>
      {retry && (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Field label="Intentos">
              <input
                className={inputClass}
                type="number"
                min={0}
                max={5}
                value={retry.attempts}
                disabled={!canEdit}
                onChange={(event) => onChange({ ...step, retry: { ...retry, attempts: Number(event.target.value) } })}
              />
            </Field>
            <Field label="Espera (ms)">
              <input
                className={inputClass}
                type="number"
                min={0}
                max={30000}
                value={retry.delayMs}
                disabled={!canEdit}
                onChange={(event) => onChange({ ...step, retry: { ...retry, delayMs: Number(event.target.value) } })}
              />
            </Field>
            <Field label="Factor">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={retry.backoff ?? 1}
                disabled={!canEdit}
                onChange={(event) => onChange({ ...step, retry: { ...retry, backoff: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field label="Solo estos estados" hint="Vacío reintenta cualquier fallo.">
            <input
              className={`${inputClass} font-mono text-xs`}
              value={(retry.onStatus ?? []).join(", ")}
              placeholder="502, 503, 504"
              disabled={!canEdit}
              onChange={(event) => {
                const statuses = writes(event.target.value);
                onChange({
                  ...step,
                  retry: { ...retry, ...(statuses.length ? { onStatus: statuses } : { onStatus: undefined }) },
                });
              }}
            />
          </Field>
          <p className="text-[11px] leading-5 text-amber-700">
            Un paso que escribe y se reintenta sin acotar por estado escribe una vez por intento.
          </p>
        </>
      )}
    </div>
  );
}
