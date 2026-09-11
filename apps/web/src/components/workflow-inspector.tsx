import { Button, Field, inputClass } from "@/components/ui";
import { JsonObjectField } from "@/components/json-object-field";
import { RequestPreviewPanel } from "@/components/request-preview";
import { removeStep, replaceStep } from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import type {
  CaptureSource,
  Environment,
  RequestTemplateView,
  StepCheckView,
  WorkflowStepView,
  WorkflowView,
} from "@/lib/types";

const AUTH = ["default", "none", "insufficient", "api-key"];

/** The same lists the engine validates against, written here because the contract package emits
 * no runtime. A value the engine does not know is a 422 on save, which is where it belongs. */
const CHECK_SOURCES: StepCheckView["source"][] = ["status", "body", "header", "durationMs"];
/** Las cuatro rutas por las que se saca un valor de una respuesta, y qué se escribe al lado. */
const CAPTURE_SOURCES: { value: CaptureSource; hint: string }[] = [
  { value: "body", hint: "data.id" },
  { value: "header", hint: "X-Request-Id" },
  { value: "cookie", hint: "session" },
  { value: "regex", hint: "pedido: (PED-\\d+)" },
];
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
  base,
  workflow,
  steps,
  selectedStep,
  templates,
  operations,
  environments,
  environmentId,
  concurrency,
  canEdit,
  onEnvironment,
  onConcurrency,
  onWorkflow,
  onSteps,
  onTemplate,
  onRun,
  onDelete,
  running,
}: {
  /** `/orgs/x/projects/y`. Passed down rather than rebuilt here: the panel below sends a real
   * request, and a second place that assembles this path is a second place to get it wrong. */
  base: string;
  workflow: WorkflowView;
  steps: WorkflowStepView[];
  selectedStep: string;
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  environments: Environment[];
  environmentId: string;
  concurrency: number;
  canEdit: boolean;
  onEnvironment: (id: string) => void;
  onConcurrency: (value: number) => void;
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
            base={base}
            step={step}
            template={template}
            operations={operations}
            environmentId={environmentId}
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
        <Field
          label="Pasos a la vez"
          hint="Solo corren juntos los que no dependen unos de otros. Lo que hace que sea seguro se comprueba al guardar."
        >
          <input
            className={inputClass}
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(event) => onConcurrency(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
          />
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
  base,
  step,
  template,
  operations,
  environmentId,
  canEdit,
  onTemplate,
  onChange,
  onRemove,
}: {
  base: string;
  step: WorkflowStepView;
  template: RequestTemplateView | undefined;
  operations: OperationSummary[];
  environmentId: string;
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
          {/* Lo que hay en el formulario, enviado de verdad. No hace falta guardar antes: lo que
              se manda es lo que se está mirando. */}
          <RequestPreviewPanel base={base} template={template} environmentId={environmentId} canSend={canEdit} />
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-rose-600">
          Este paso apunta a una prueba que ya no existe. Bórralo o vuelve a crearla.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        Extrae valores de esta respuesta para los pasos siguientes. Del cuerpo, con una ruta como{" "}
        <span className="font-mono">data.id</span>; de una cabecera o una cookie, con su nombre; y si la respuesta no
        tiene forma que recorrer, con una expresión regular sobre el texto —su grupo, si lo lleva—.
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
                      position === index ? { ...item, from: event.target.value as CaptureSource } : item,
                    ),
                  )
                }
              >
                {CAPTURE_SOURCES.map((source) => (
                  <option key={source.value} value={source.value}>
                    {source.value}
                  </option>
                ))}
              </select>
              <input
                aria-label="Ruta de captura"
                className={inputClass}
                value={capture.path}
                // El ejemplo cambia con la ruta elegida: `data.id` al lado de un selector que dice
                // «cookie» es una pista que estorba más de lo que ayuda.
                placeholder={CAPTURE_SOURCES.find((source) => source.value === capture.from)?.hint}
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

      <SessionEditor step={step} canEdit={canEdit} onChange={onChange} />
      <ScheduleEditor step={step} canEdit={canEdit} onChange={onChange} />
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

/**
 * Cuándo se ejecuta este paso, y cuántas veces.
 *
 * Los dos leen la respuesta de otro paso, y los dos exigen que ese paso sea una dependencia: sin
 * la arista no hay garantía de que haya contestado, y la lectura volvería vacía de una forma que
 * se parece a una condición falsa o a una lista sin elementos. Por eso el desplegable solo ofrece
 * los pasos de los que este ya depende, en vez de ofrecerlos todos y dejar que el servidor
 * conteste un 422.
 */
function ScheduleEditor({
  step,
  canEdit,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
}) {
  const sources = step.dependsOn ?? [];
  const loop = step.forEach;
  const condition = step.runIf;

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <p className="text-xs font-semibold text-slate-800">Cuándo y cuántas veces</p>

      {/* Solo con varias dependencias: con una, «todas» y «cualquiera» son la misma frase, y un
          desplegable que no decide nada es una pregunta que alguien tiene que leer igual. */}
      {sources.length > 1 && (
        <Field label="Empieza cuando" hint="«Cualquiera» arranca con el primero que llegue, sin esperar al resto.">
          <select
            className={inputClass}
            value={step.waits ?? "all"}
            disabled={!canEdit}
            onChange={(event) => onChange({ ...step, waits: event.target.value === "any" ? "any" : undefined })}
          >
            <option value="all">han terminado todos los anteriores</option>
            <option value="any">ha terminado cualquiera de ellos</option>
          </select>
        </Field>
      )}

      <Field
        label="Esperar antes (ms)"
        hint="Para el destino que acepta la escritura y tarda un momento en poder leerla."
      >
        <input
          className={inputClass}
          type="number"
          min={0}
          max={60000}
          value={step.waitMs ?? 0}
          disabled={!canEdit}
          onChange={(event) =>
            onChange({ ...step, waitMs: Number(event.target.value) > 0 ? Number(event.target.value) : undefined })
          }
        />
      </Field>

      {sources.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-400">
          Conecta este paso a otro para poder condicionarlo o recorrer su lista.
        </p>
      ) : (
        <>
          <label className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={Boolean(condition)}
              disabled={!canEdit}
              onChange={(event) =>
                onChange({
                  ...step,
                  runIf: event.target.checked
                    ? { from: sources[0], check: { source: "status", operator: "equals", value: "200" } }
                    : undefined,
                })
              }
            />
            Solo si…
          </label>
          {condition && (
            <div className="mt-2 rounded-lg border border-slate-200 p-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Del paso">
                  <select
                    className={inputClass}
                    value={condition.from}
                    disabled={!canEdit}
                    onChange={(event) => onChange({ ...step, runIf: { ...condition, from: event.target.value } })}
                  >
                    {sources.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Origen">
                  <select
                    className={inputClass}
                    value={condition.check.source}
                    disabled={!canEdit}
                    onChange={(event) =>
                      onChange({
                        ...step,
                        runIf: {
                          ...condition,
                          check: { ...condition.check, source: event.target.value as StepCheckView["source"] },
                        },
                      })
                    }
                  >
                    {CHECK_SOURCES.map((source) => (
                      <option key={source} value={source}>
                        {source}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-[1fr_8rem_1fr] gap-2">
                <input
                  aria-label="Ruta de la condición"
                  className={inputClass}
                  value={condition.check.path ?? ""}
                  placeholder="data.0.id"
                  disabled={!canEdit || condition.check.source === "status" || condition.check.source === "durationMs"}
                  onChange={(event) =>
                    onChange({
                      ...step,
                      runIf: { ...condition, check: { ...condition.check, path: event.target.value } },
                    })
                  }
                />
                <select
                  aria-label="Operador de la condición"
                  className={inputClass}
                  value={condition.check.operator}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onChange({
                      ...step,
                      runIf: { ...condition, check: { ...condition.check, operator: event.target.value } },
                    })
                  }
                >
                  {CHECK_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
                {!WITHOUT_OPERAND.includes(condition.check.operator) && (
                  <input
                    aria-label="Valor de la condición"
                    className={inputClass}
                    value={condition.check.value === undefined ? "" : String(condition.check.value)}
                    disabled={!canEdit}
                    onChange={(event) =>
                      onChange({
                        ...step,
                        runIf: { ...condition, check: { ...condition.check, value: event.target.value } },
                      })
                    }
                  />
                )}
              </div>
              <p className="text-[11px] leading-5 text-slate-500">
                Si no se cumple, el paso queda <span className="font-medium">saltado</span>, no en rojo, y lo que
                dependa de él se ejecuta igual.
              </p>
            </div>
          )}

          <label className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={Boolean(loop)}
              disabled={!canEdit}
              onChange={(event) =>
                onChange({
                  ...step,
                  forEach: event.target.checked ? { from: sources[0], path: "data", as: "item", max: 50 } : undefined,
                })
              }
            />
            Una vez por elemento de…
          </label>
          {loop && (
            <div className="mt-2 rounded-lg border border-slate-200 p-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Lista del paso">
                  <select
                    className={inputClass}
                    value={loop.from}
                    disabled={!canEdit}
                    onChange={(event) => onChange({ ...step, forEach: { ...loop, from: event.target.value } })}
                  >
                    {sources.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Ruta">
                  <input
                    className={inputClass}
                    value={loop.path}
                    placeholder="data"
                    disabled={!canEdit}
                    onChange={(event) => onChange({ ...step, forEach: { ...loop, path: event.target.value } })}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Se llama" hint="Un objeto también se ata campo a campo: item.id.">
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    value={loop.as}
                    disabled={!canEdit}
                    onChange={(event) => onChange({ ...step, forEach: { ...loop, as: event.target.value } })}
                  />
                </Field>
                <Field label="Como mucho">
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={200}
                    value={loop.max ?? 50}
                    disabled={!canEdit}
                    onChange={(event) => onChange({ ...step, forEach: { ...loop, max: Number(event.target.value) } })}
                  />
                </Field>
              </div>
              <p className="text-[11px] leading-5 text-slate-500">
                Cada elemento es su propio caso. El tope no es una formalidad: la lista la decide el destino.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * El paso que inicia sesión.
 *
 * Lo que sustituye: pegar un token en el entorno a mano y volver a pegarlo cuando caduca, con lo
 * que cada suite es algo que hay que vigilar.
 *
 * Sustituye la credencial que funciona **y solo esa**. Los casos que presentan `none`,
 * `insufficient` o `api-key` existen para que los rechacen, y darles una sesión válida convertiría
 * cada uno en un 200 verde que no demuestra nada. Eso se dice aquí porque es exactamente lo que
 * alguien espera al revés.
 */
function SessionEditor({
  step,
  canEdit,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
}) {
  const auth = step.authorizes;
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
        <input
          type="checkbox"
          checked={Boolean(auth)}
          disabled={!canEdit}
          onChange={(event) =>
            onChange({ ...step, authorizes: event.target.checked ? { from: "body", path: "data.token" } : undefined })
          }
        />
        Este paso inicia sesión
      </label>
      {auth && (
        <div className="mt-2 rounded-lg border border-slate-200 p-2">
          <div className="grid grid-cols-[90px_1fr] gap-2">
            <select
              aria-label="De dónde sale el token"
              className={inputClass}
              value={auth.from}
              disabled={!canEdit}
              onChange={(event) =>
                onChange({ ...step, authorizes: { ...auth, from: event.target.value as CaptureSource } })
              }
            >
              {CAPTURE_SOURCES.map((source) => (
                <option key={source.value} value={source.value}>
                  {source.value}
                </option>
              ))}
            </select>
            <input
              aria-label="Ruta del token"
              className={inputClass}
              value={auth.path}
              placeholder="data.token"
              disabled={!canEdit}
              onChange={(event) => onChange({ ...step, authorizes: { ...auth, path: event.target.value } })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Cabecera">
              <input
                className={`${inputClass} font-mono text-xs`}
                value={auth.header ?? ""}
                placeholder="Authorization"
                disabled={!canEdit}
                onChange={(event) =>
                  onChange({ ...step, authorizes: { ...auth, header: event.target.value || undefined } })
                }
              />
            </Field>
            <Field label="Prefijo" hint="Vacío envía el token tal cual.">
              <input
                className={`${inputClass} font-mono text-xs`}
                value={auth.scheme ?? "Bearer "}
                disabled={!canEdit}
                onChange={(event) => onChange({ ...step, authorizes: { ...auth, scheme: event.target.value } })}
              />
            </Field>
          </div>
          <p className="text-[11px] leading-5 text-slate-500">
            Los pasos siguientes la presentan en lugar de la credencial guardada. Los que piden{" "}
            <span className="font-mono">none</span>, <span className="font-mono">insufficient</span> o{" "}
            <span className="font-mono">api-key</span> siguen presentando la suya: existen para que los rechacen.
          </p>
        </div>
      )}
    </div>
  );
}
