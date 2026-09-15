import { useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { RequestBodyEditor } from "@/components/request-body-editor";
import { RequestFieldsEditor } from "@/components/request-fields-editor";
import { RequestPreviewPanel } from "@/components/request-preview";
import { fieldMapsFrom, fieldProblems, fieldRowsFrom, type FieldRow } from "@/lib/request-fields";
import { loopBodyIds, removeStep, replaceStep, suggestCaptures, variablesFor } from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import type {
  CaptureSource,
  Environment,
  RequestTemplateView,
  StepCheckView,
  StepConditionView,
  StepFetchView,
  WorkflowCaptureView,
  WorkflowStepView,
  WorkflowView,
} from "@/lib/types";

const AUTH = ["default", "none", "insufficient", "api-key"];
const FETCH_METHODS: StepFetchView["method"][] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

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
  delayMs,
  canEdit,
  onEnvironment,
  onConcurrency,
  onDelay,
  onWorkflow,
  onSteps,
  onTemplate,
  templateUsage,
  onFork,
  forking,
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
  delayMs: number;
  canEdit: boolean;
  onEnvironment: (id: string) => void;
  onConcurrency: (value: number) => void;
  onDelay: (value: number) => void;
  onWorkflow: (change: Partial<Pick<WorkflowView, "name" | "description">>) => void;
  onSteps: (steps: WorkflowStepView[]) => void;
  onTemplate: (template: RequestTemplateView) => void;
  /** How many nodes (across every flow) share the given reusable request. */
  templateUsage: (templateId: string) => number;
  /** Fork a private copy of this node's request, carrying the edit that triggered it. */
  onFork: (step: WorkflowStepView, overrides?: Partial<RequestTemplateView>) => void;
  forking: boolean;
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
        {step && (step.kind ?? "request") === "branch" ? (
          <BranchInspector
            step={step}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "wait" ? (
          <WaitInspector
            step={step}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "merge" ? (
          <MergeInspector
            step={step}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "validate" ? (
          <ValidateInspector
            step={step}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "set" ? (
          <SetInspector
            step={step}
            variables={variablesFor(
              steps,
              step.id,
              Object.keys(environments.find((item) => item.id === environmentId)?.variables ?? {}),
            )}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "script" ? (
          <ScriptInspector
            step={step}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "loop" ? (
          <LoopInspector
            step={step}
            body={loopBodyIds(steps, step.id)}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "poll" ? (
          <PollInspector
            step={step}
            steps={steps}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step && step.kind === "fetch" ? (
          <FetchInspector
            step={step}
            variables={variablesFor(
              steps,
              step.id,
              Object.keys(environments.find((item) => item.id === environmentId)?.variables ?? {}),
            )}
            canEdit={canEdit}
            onChange={(next) => onSteps(replaceStep(steps, next))}
            onRemove={() => onSteps(removeStep(steps, step.id))}
          />
        ) : step ? (
          <StepInspector
            base={base}
            step={step}
            template={template}
            operations={operations}
            environmentId={environmentId}
            // What `{{` can name in this step's fields: the chosen environment's variables, plus
            // what the steps it depends on capture. Computed here because this is the only place
            // that holds both the environments and the graph — and the disabled ones are left out
            // on purpose, because a run does not substitute them.
            variables={variablesFor(
              steps,
              step.id,
              Object.keys(environments.find((item) => item.id === environmentId)?.variables ?? {}),
            )}
            canEdit={canEdit}
            sharedBy={template ? templateUsage(template.id) : 0}
            forking={forking}
            onTemplate={onTemplate}
            onFork={(overrides) => onFork(step, overrides)}
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
        <Field
          label="Velocidad"
          hint="Una pausa entre pasos, para poder mirar el timeline mientras corre. No es una espera del paso: no cambia lo que se prueba, solo el ritmo."
        >
          <select className={inputClass} value={delayMs} onChange={(event) => onDelay(Number(event.target.value))}>
            <option value={0}>Rápido</option>
            <option value={300}>Normal</option>
            <option value={1000}>Lento</option>
            <option value={2500}>Paso a paso</option>
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

/**
 * Captures a response offers, as one-click chips.
 *
 * The path is the part that is wrong by one segment and fails on the third case, so the editor
 * reads a real body and fills it in: «Usar última respuesta» takes the body the preview just got
 * back, or a body pasted from anywhere goes in the box. Every scalar leaf becomes a chip — the ones
 * that look like an id or a token first — and a click adds the capture with its path already right.
 * A chip whose path is already captured is not offered, so the list shrinks as it is spent.
 */
function CaptureSuggestions({
  sampleBody,
  existing,
  onAdd,
}: {
  sampleBody: unknown;
  existing: WorkflowCaptureView[];
  onAdd: (capture: WorkflowCaptureView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  const existingPaths = new Set(existing.filter((capture) => capture.from === "body").map((capture) => capture.path));
  const existingVars = existing.map((capture) => capture.variable);
  let suggestions: WorkflowCaptureView[] = [];
  let error: string | null = null;
  if (text.trim()) {
    try {
      suggestions = suggestCaptures(JSON.parse(text), existingVars).filter(
        (suggestion) => !existingPaths.has(suggestion.path),
      );
    } catch {
      error = "No es JSON válido.";
    }
  }

  return (
    <div className="mt-2">
      <button className="text-[11px] text-slate-500 hover:text-slate-800" onClick={() => setOpen((value) => !value)}>
        {open ? "Ocultar sugerencias" : "Sugerir capturas desde la respuesta"}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-dashed border-slate-200 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400">Pega una respuesta JSON o usa la última enviada.</span>
            <button
              className="text-[10px] text-slate-500 hover:text-slate-800 disabled:opacity-40"
              disabled={sampleBody === undefined}
              onClick={() => setText(JSON.stringify(sampleBody, null, 2))}
            >
              Usar última respuesta
            </button>
          </div>
          <textarea
            className={`${inputClass} mt-1 h-24 font-mono text-[10px]`}
            placeholder='{ "data": { "id": 1, "token": "…" } }'
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
          />
          {error && <p className="mt-1 text-[10px] text-rose-600">{error}</p>}
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.path}
                  className="rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-200"
                  title={suggestion.path}
                  onClick={() => onAdd(suggestion)}
                >
                  + {suggestion.variable}
                  <span className="ml-1 font-mono text-slate-400">{suggestion.path}</span>
                </button>
              ))}
            </div>
          )}
          {text.trim() && !error && suggestions.length === 0 && (
            <p className="mt-1 text-[10px] text-slate-400">Nada nuevo que capturar en esta respuesta.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The `If` node's panel: what it reads and the check that decides «sí» from «no».
 *
 * It sends no request, so there is nothing of the request inspector here — only the condition. The
 * step it reads has to be one it depends on (the engine reads that node's answer), so the list is
 * its dependencies; the two sides are wired on the canvas by dragging the «sí»/«no» handles.
 */
function BranchInspector({
  step,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const sources = step.dependsOn ?? [];
  const condition: StepConditionView = step.condition ?? {
    from: sources[0] ?? "",
    check: { source: "status", operator: "equals", value: "200" },
  };
  const setCheck = (change: Partial<StepCheckView>) =>
    onChange({ ...step, condition: { ...condition, check: { ...condition.check, ...change } } });

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Bifurcación (If)</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Lee la respuesta de un paso anterior y parte el flujo: la salida <span className="text-emerald-600">sí</span> se
        toma cuando la condición se cumple, la <span className="text-rose-500">no</span> cuando no. Conecta cada salida
        al siguiente paso arrastrando desde su punto.
      </p>

      {sources.length === 0 ? (
        <p className="mt-3 text-[11px] text-amber-700">Conéctalo a la petición que quieres leer para poder decidir.</p>
      ) : (
        <div className="mt-3 rounded-lg border border-slate-200 p-2">
          <Field label="Lee el paso">
            <select
              className={inputClass}
              value={condition.from}
              disabled={!canEdit}
              onChange={(event) => onChange({ ...step, condition: { ...condition, from: event.target.value } })}
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
              onChange={(event) => setCheck({ source: event.target.value as StepCheckView["source"] })}
            >
              {CHECK_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-[1fr_8rem_1fr] gap-2">
            <input
              aria-label="Ruta de la condición"
              className={inputClass}
              value={condition.check.path ?? ""}
              placeholder="data.0.id"
              disabled={!canEdit || condition.check.source === "status" || condition.check.source === "durationMs"}
              onChange={(event) => setCheck({ path: event.target.value })}
            />
            <select
              aria-label="Operador de la condición"
              className={inputClass}
              value={condition.check.operator}
              disabled={!canEdit}
              onChange={(event) => setCheck({ operator: event.target.value })}
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
                onChange={(event) => setCheck({ value: event.target.value })}
              />
            )}
          </div>
        </div>
      )}

      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** The espera node: a single number, and what it is for. */
function WaitInspector({
  step,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Espera</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Pausa antes de dejar pasar el flujo. No es un reintento —«no era el momento», no «el fallo no era real»— para el
        destino que acepta una escritura y tarda un momento en hacerla legible.
      </p>
      <Field label="Milisegundos">
        <input
          className={inputClass}
          type="number"
          min={0}
          max={60000}
          value={step.waitMs ?? 0}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...step, waitMs: Math.min(60000, Math.max(0, Number(event.target.value) || 0)) })}
        />
      </Field>
      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** The merge node: whether it needs every branch into it, or just the first to arrive. */
function MergeInspector({
  step,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const count = step.dependsOn?.length ?? 0;
  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Merge (unión)</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Junta varias ramas en una. Conecta a su entrada las que quieres unir; el flujo sigue por su salida cuando se
        cumple la condición de abajo.
      </p>
      <p className="mt-2 text-[11px] text-slate-500">
        Ramas conectadas: <span className="font-medium text-slate-700">{count}</span>
      </p>
      <Field label="Cuándo continúa">
        <select
          className={inputClass}
          value={step.waits ?? "all"}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...step, waits: event.target.value === "any" ? "any" : "all" })}
        >
          <option value="all">Cuando llegan todas</option>
          <option value="any">Basta con que llegue una</option>
        </select>
      </Field>
      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** The validate node: which step it reads, its checks, and an optional sandbox script. */
function ValidateInspector({
  step,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const sources = step.dependsOn ?? [];
  const from = step.validate?.from ?? "";
  const setValidate = (change: Partial<NonNullable<WorkflowStepView["validate"]>>) =>
    onChange({ ...step, validate: { from, ...step.validate, ...change } });

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Validación</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Lee la respuesta de un paso anterior y la juzga. Si no pasa, lo que depende de esta validación se salta. Conéctalo
        al paso que quieres validar arrastrando una arista hasta su entrada.
      </p>

      {sources.length === 0 ? (
        <p className="mt-3 text-[11px] text-amber-700">Conéctalo a la petición cuya respuesta quieres validar.</p>
      ) : (
        <Field label="Lee el paso">
          <select
            className={inputClass}
            value={from}
            disabled={!canEdit}
            onChange={(event) => setValidate({ from: event.target.value })}
          >
            {sources.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      )}

      <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />

      <div className="mt-4 border-t border-slate-100 pt-3">
        <p className="text-xs font-semibold text-slate-800">Script</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          Se ejecuta en un proceso aislado con la API <code className="font-mono">pm</code>: <code className="font-mono">pm.response</code>,{" "}
          <code className="font-mono">pm.expect</code>, <code className="font-mono">pm.test(...)</code>. La validación pasa si todos sus{" "}
          <code className="font-mono">pm.test</code> pasan.
        </p>
        <textarea
          className={`${inputClass} mt-2 h-28 font-mono text-[11px]`}
          placeholder={"pm.test('trae un id', function () {\n  pm.expect(pm.response.json().data.id).to.be.a('string');\n});"}
          value={step.validate?.script ?? ""}
          disabled={!canEdit}
          onChange={(event) => setValidate({ script: event.target.value || undefined })}
        />
      </div>

      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

function StepInspector({
  base,
  step,
  template,
  operations,
  environmentId,
  variables,
  canEdit,
  sharedBy,
  forking,
  onTemplate,
  onFork,
  onChange,
  onRemove,
}: {
  base: string;
  step: WorkflowStepView;
  template: RequestTemplateView | undefined;
  operations: OperationSummary[];
  environmentId: string;
  variables: string[];
  canEdit: boolean;
  /** Number of nodes sharing this request; > 1 means an edit here would change them all. */
  sharedBy: number;
  forking: boolean;
  onTemplate: (template: RequestTemplateView) => void;
  onFork: (overrides?: Partial<RequestTemplateView>) => void;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const shared = sharedBy > 1;
  // The last body the preview got back, so the captures below can be suggested from a real response
  // instead of typed by hand. Held here because the preview panel that fetches it and the captures
  // that spend it are two sections of the same node.
  const [sampleBody, setSampleBody] = useState<unknown>(undefined);

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Prueba reutilizable</p>
      {/* A reusable request edited here is one row: the change reaches every node that shares it. So
          when more than one does, the panel says so and offers a private copy — and changing the
          operation, which never means «make the others a different request too», forks on its own. */}
      {template && shared && canEdit && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] leading-5 text-amber-800">
          Esta petición la usan <span className="font-semibold">{sharedBy} nodos</span>. Al editarla cambian todos.
          <button
            className="mt-1 block rounded-md bg-amber-100 px-2 py-1 font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50"
            disabled={forking}
            onClick={() => onFork()}
          >
            {forking ? "Creando copia…" : "Hacer independiente este nodo"}
          </button>
        </div>
      )}
      {template ? (
        <div className="mt-2 rounded-lg border border-slate-200 p-2">
          <Field label="Operación">
            <select
              className={inputClass}
              value={template.operationId}
              disabled={!canEdit || forking}
              // Changing the operation is the edit that must never drag the twins along: if the
              // request is shared, fork a private copy that already carries the new operation.
              onChange={(event) =>
                shared
                  ? onFork({ operationId: event.target.value })
                  : onTemplate({ ...template, operationId: event.target.value })
              }
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
          <RequestFieldsRows
            label="Parámetros"
            kind="parameter"
            hint="De ruta y de consulta. Acepta {{variables}} del entorno o capturadas antes."
            namePlaceholder="id"
            valuePlaceholder="{{thingId}}"
            enabled={template.parameters}
            disabledMap={template.disabledParameters}
            variables={variables}
            canEdit={canEdit}
            onChange={(maps) =>
              onTemplate({ ...template, parameters: maps.enabled, disabledParameters: maps.disabled })
            }
          />
          <RequestFieldsRows
            label="Cabeceras"
            kind="header"
            hint="Lo que el contrato no declara y la petición necesita igual. Ganan sobre las que pone el motor."
            namePlaceholder="X-Tenant"
            valuePlaceholder="acme"
            enabled={template.headers}
            disabledMap={template.disabledHeaders}
            variables={variables}
            canEdit={canEdit}
            onChange={(maps) => onTemplate({ ...template, headers: maps.enabled, disabledHeaders: maps.disabled })}
          />
          <RequestBodyEditor
            body={template.body}
            variables={variables}
            canEdit={canEdit}
            onChange={(body) => onTemplate({ ...template, body })}
          />
          {/* Lo que hay en el formulario, enviado de verdad. No hace falta guardar antes: lo que
              se manda es lo que se está mirando. */}
          <RequestPreviewPanel
            base={base}
            template={template}
            environmentId={environmentId}
            canSend={canEdit}
            onResponseBody={setSampleBody}
          />
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-rose-600">
          Este paso apunta a una prueba que ya no existe. Bórralo o vuelve a crearla.
        </p>
      )}

      <CapturesEditor step={step} canEdit={canEdit} sampleBody={sampleBody} onChange={onChange} />

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

/** A fetch node: the call written by hand, then the same captures, checks and failure handling as
 * any request. No preview panel — that one sends a saved request. */
function FetchInspector({
  step,
  variables,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  variables: string[];
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const call: StepFetchView = step.fetch ?? { method: "GET", url: "" };
  const setCall = (change: Partial<StepFetchView>) => onChange({ ...step, fetch: { ...call, ...change } });
  const bodyAllowed = call.method !== "GET" && call.method !== "HEAD";

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Fetch</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Una petición escrita a mano, fuera del catálogo: un webhook, otro servicio, un proveedor de identidad. Una ruta
        como <span className="font-mono">/things</span> cuelga de la URL base del entorno. Todo acepta{" "}
        <span className="font-mono">{"{{variables}}"}</span>.
      </p>
      <div className="mt-2 grid grid-cols-[6.5rem_1fr] gap-2">
        <Field label="Método">
          <select
            className={inputClass}
            value={call.method}
            disabled={!canEdit}
            onChange={(event) => setCall({ method: event.target.value as StepFetchView["method"] })}
          >
            {FETCH_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL">
          <input
            className={`${inputClass} font-mono text-[11px]`}
            value={call.url}
            placeholder="https://api.ejemplo.com/recurso/{{id}}"
            list={`fetch-vars-${step.id}`}
            disabled={!canEdit}
            onChange={(event) => setCall({ url: event.target.value })}
          />
        </Field>
      </div>
      <datalist id={`fetch-vars-${step.id}`}>
        {variables.map((name) => (
          <option key={name} value={`{{${name}}}`} />
        ))}
      </datalist>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Estado esperado">
          <input
            className={inputClass}
            type="number"
            min={100}
            max={599}
            placeholder="2xx"
            value={call.expectedStatus ?? ""}
            disabled={!canEdit}
            onChange={(event) =>
              setCall({ expectedStatus: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </Field>
        <label className="mt-6 flex items-center gap-1.5 text-[11px] text-slate-600">
          <input
            type="checkbox"
            checked={Boolean(call.useSession)}
            disabled={!canEdit}
            onChange={(event) => setCall({ useSession: event.target.checked || undefined })}
          />
          Enviar sesión del login
        </label>
      </div>
      {call.useSession && /^https?:\/\//i.test(call.url) && (
        <p className="mt-1 text-[11px] text-amber-700">
          La credencial obtenida en el login viajará a esta URL. Úsalo solo con hosts de confianza.
        </p>
      )}
      <RequestFieldsRows
        label="Cabeceras"
        kind="header"
        hint="Content-Type se deduce del body si no la pones."
        namePlaceholder="Authorization"
        valuePlaceholder="Bearer {{token}}"
        enabled={call.headers ?? {}}
        disabledMap={call.disabledHeaders ?? {}}
        variables={variables}
        canEdit={canEdit}
        onChange={(maps) =>
          setCall({
            headers: Object.keys(maps.enabled).length ? maps.enabled : undefined,
            disabledHeaders: Object.keys(maps.disabled).length ? maps.disabled : undefined,
          })
        }
      />
      {bodyAllowed && (
        <Field label="Body">
          <textarea
            className={`${inputClass} h-24 font-mono text-[11px]`}
            placeholder={'{"id": "{{thingId}}"}'}
            value={call.body ?? ""}
            disabled={!canEdit}
            onChange={(event) => setCall({ body: event.target.value || undefined })}
          />
        </Field>
      )}

      <CapturesEditor step={step} canEdit={canEdit} onChange={onChange} />
      <SessionEditor step={step} canEdit={canEdit} onChange={onChange} />
      <ScheduleEditor step={step} canEdit={canEdit} onChange={onChange} />
      <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />
      <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />

      {canEdit && (
        <Button variant="danger" className="mt-4 h-8 w-full text-xs" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** The set node: rows of «variable = plantilla», resolved when the node runs. */
function SetInspector({
  step,
  variables,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  variables: string[];
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const assignments = step.set?.assignments ?? [];
  const edit = (next: typeof assignments) => onChange({ ...step, set: { assignments: next } });
  const listId = `set-vars-${step.id}`;

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Set (variables)</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Escribe variables para los pasos siguientes sin hacer ninguna petición. El valor es una plantilla:{" "}
        <span className="font-mono">{"{{thingId}}"}</span>, <span className="font-mono">{"pedido-{{$uuid}}"}</span>. Solo
        vale durante la corrida; el entorno guardado no cambia.
      </p>
      <datalist id={listId}>
        {variables.map((name) => (
          <option key={name} value={`{{${name}}}`} />
        ))}
      </datalist>
      <div className="mt-2 space-y-2">
        {assignments.map((assignment, index) => (
          <div key={index} className="grid grid-cols-[1fr_auto_1.4fr_auto] items-center gap-1.5">
            <input
              aria-label="Variable"
              className={`${inputClass} font-mono text-[11px]`}
              value={assignment.variable}
              placeholder="total"
              disabled={!canEdit}
              onChange={(event) =>
                edit(assignments.map((item, position) => (position === index ? { ...item, variable: event.target.value } : item)))
              }
            />
            <span className="text-xs text-slate-400">=</span>
            <input
              aria-label="Valor"
              className={`${inputClass} font-mono text-[11px]`}
              value={assignment.value}
              placeholder="{{precio}}"
              list={listId}
              disabled={!canEdit}
              onChange={(event) =>
                edit(assignments.map((item, position) => (position === index ? { ...item, value: event.target.value } : item)))
              }
            />
            {canEdit && (
              <button
                className="text-[11px] text-rose-600"
                aria-label="Quitar variable"
                onClick={() => edit(assignments.filter((_item, position) => position !== index))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <Button
          variant="ghost"
          className="mt-2 h-8 text-xs"
          onClick={() => edit([...assignments, { variable: "", value: "" }])}
        >
          + Variable
        </Button>
      )}
      <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />
      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** The script node: which response it reads, and its code. */
function ScriptInspector({
  step,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const sources = step.dependsOn ?? [];
  const script = step.script ?? { code: "" };

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Script</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        JavaScript en un proceso aislado, sin red ni ficheros. Lee con <code className="font-mono">pm.response</code> y{" "}
        <code className="font-mono">pm.variables.get</code>, escribe con <code className="font-mono">pm.variables.set</code>{" "}
        (solo para esta corrida) y comprueba con <code className="font-mono">pm.test</code>. Falla si lanza un error o si un{" "}
        <code className="font-mono">pm.test</code> falla. Lo que imprime queda en el informe, con los secretos ocultos.
      </p>
      <Field label="Lee la respuesta de">
        <select
          className={inputClass}
          value={script.from ?? ""}
          disabled={!canEdit}
          onChange={(event) =>
            onChange({ ...step, script: event.target.value ? { code: script.code, from: event.target.value } : { code: script.code } })
          }
        >
          <option value="">Ninguna</option>
          {sources.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Field>
      <textarea
        aria-label="Código del script"
        className={`${inputClass} mt-2 h-48 font-mono text-[11px]`}
        placeholder={
          "const body = pm.response.json();\npm.variables.set('total', String(body.data.length));\npm.test('hay datos', () => pm.expect(body.data.length).to.be.above(0));"
        }
        value={script.code}
        disabled={!canEdit}
        spellCheck={false}
        onChange={(event) => onChange({ ...step, script: { ...script, code: event.target.value } })}
      />
      <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />
      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** A loop node: where the list is, what each element is called, and what runs per element. */
function LoopInspector({
  step,
  body,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  body: string[];
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const sources = step.dependsOn ?? [];
  const loop = step.loop ?? { from: "", path: "data", as: "item", max: 50 };
  const setLoop = (change: Partial<typeof loop>) => onChange({ ...step, loop: { ...loop, ...change } });
  const name = loop.as || "item";

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Bucle</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Recorre una lista que devolvió un paso anterior. Lo que conectes a la salida «cada» —y todo lo que cuelgue de ello— se
        ejecuta una vez por elemento, en orden, y cada vuelta deja su propio caso por nodo. La salida «fin» sigue cuando
        terminan todas las vueltas.
      </p>
      {sources.length === 0 ? (
        <p className="mt-3 text-[11px] text-amber-700">Conéctalo al paso cuya respuesta trae la lista.</p>
      ) : (
        <Field label="Lee la lista de">
          <select className={inputClass} value={loop.from} disabled={!canEdit} onChange={(event) => setLoop({ from: event.target.value })}>
            {!sources.includes(loop.from) && <option value="">Elige un paso</option>}
            {sources.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Ruta a la lista en el body">
        <input
          className={`${inputClass} font-mono text-xs`}
          value={loop.path}
          placeholder="data.items"
          disabled={!canEdit}
          onChange={(event) => setLoop({ path: event.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Cada elemento">
          <input
            className={`${inputClass} font-mono text-xs`}
            value={loop.as}
            disabled={!canEdit}
            onChange={(event) => setLoop({ as: event.target.value })}
          />
        </Field>
        <Field label="Máx. vueltas">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={200}
            value={loop.max ?? 50}
            disabled={!canEdit}
            onChange={(event) => setLoop({ max: Math.min(200, Math.max(1, Number(event.target.value) || 1)) })}
          />
        </Field>
      </div>
      <p className="text-[11px] leading-5 text-slate-500">
        Úsalo como <code className="font-mono">{`{{${name}.id}}`}</code> campo a campo, o{" "}
        <code className="font-mono">{`{{${name}}}`}</code> para el elemento entero en JSON.
      </p>
      <p className={`mt-2 text-[11px] leading-5 ${body.length ? "text-slate-600" : "text-amber-700"}`}>
        {body.length ? `Por vuelta: ${body.join(" → ")}` : "Nada conectado a «cada»: el bucle no ejecutará nada."}
      </p>
      <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />
      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** A poll node: the request it repeats, how often, and the checks that say when to stop. */
function PollInspector({
  step,
  steps,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  steps: WorkflowStepView[];
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  // Only what it can send again as it is: a request or a fetch it depends on, with no loop and no login.
  const sources = (step.dependsOn ?? []).filter((id) => {
    const source = steps.find((other) => other.id === id);
    return source && ["request", "fetch"].includes(source.kind ?? "request") && !source.forEach && !source.authorizes;
  });
  const poll = step.poll ?? { from: "", attempts: 5, delayMs: 2000 };
  const setPoll = (change: Partial<typeof poll>) => onChange({ ...step, poll: { ...poll, ...change } });

  return (
    <div>
      <p className="text-xs font-semibold text-slate-800">Reintento</p>
      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
        Repite la petición de un paso hasta que su respuesta cumpla las comprobaciones: el trabajo que responde «pendiente»
        hasta que termina. Primero juzga la respuesta que ese paso ya obtuvo; si ya cumple, no reenvía nada. Lo que cuelgue
        de este nodo lee la última respuesta.
      </p>

      {sources.length === 0 ? (
        <p className="mt-3 text-[11px] text-amber-700">Conéctalo a una petición o un fetch (sin bucle ni login) que repetir.</p>
      ) : (
        <Field label="Repite el paso">
          <select className={inputClass} value={poll.from} disabled={!canEdit} onChange={(event) => setPoll({ from: event.target.value })}>
            {!sources.includes(poll.from) && <option value="">Elige un paso</option>}
            {sources.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Reenvíos (máx.)">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={20}
            value={poll.attempts}
            disabled={!canEdit}
            onChange={(event) => setPoll({ attempts: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })}
          />
        </Field>
        <Field label="Cada (ms)">
          <input
            className={inputClass}
            type="number"
            min={0}
            max={60000}
            step={500}
            value={poll.delayMs}
            disabled={!canEdit}
            onChange={(event) => setPoll({ delayMs: Math.min(60000, Math.max(0, Number(event.target.value) || 0)) })}
          />
        </Field>
      </div>
      <p className="text-[11px] leading-5 text-amber-700">Si la petición escribe, cada reenvío vuelve a escribir.</p>

      <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />
      <div className="mt-4 border-t border-slate-100 pt-3">
        <p className="text-xs font-semibold text-slate-800">Capturas de la última respuesta</p>
        <CapturesEditor step={step} canEdit={canEdit} onChange={onChange} />
      </div>
      <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />
      {canEdit && (
        <Button variant="ghost" className="mt-3 h-8 w-full text-xs text-rose-600" onClick={onRemove}>
          Eliminar nodo
        </Button>
      )}
    </div>
  );
}

/** What a response yields to the steps after it. Shared by request and fetch nodes. */
function CapturesEditor({
  step,
  canEdit,
  sampleBody,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  /** The last body a preview got back, when there is one, to suggest captures from. */
  sampleBody?: unknown;
  onChange: (step: WorkflowStepView) => void;
}) {
  const captures = step.captures ?? [];
  const editCaptures = (next: typeof captures) => onChange({ ...step, captures: next });

  return (
    <div>
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
        <CaptureSuggestions
          sampleBody={sampleBody}
          existing={captures}
          onAdd={(capture) => editCaptures([...captures, capture])}
        />
      )}

      {canEdit && (
        <Button
          variant="ghost"
          className="mt-2 h-8 text-xs"
          onClick={() => editCaptures([...captures, { variable: "", from: "body", path: "" }])}
        >
          + Captura
        </Button>
      )}

    </div>
  );
}

/**
 * The bridge between the two stored maps and the rows the table draws.
 *
 * It holds no state: the rows are derived from the maps on every render and converted back on
 * every edit. A local copy would be a second source of truth for the same thing, and the bug it
 * causes is the one that is hardest to see — a row typed after a save that silently reverts,
 * because the copy was made before the save and never told about it.
 *
 * What that costs is the order: the rows come back sorted by name, so a row being typed does not
 * jump, but one that is renamed does. The alternative is keeping order in the database, and a
 * `jsonb` column cannot — Postgres orders its keys by length and then bytewise.
 */
function RequestFieldsRows({
  label,
  kind,
  hint,
  namePlaceholder,
  valuePlaceholder,
  enabled,
  disabledMap,
  variables,
  canEdit,
  onChange,
}: {
  label: string;
  kind: "parameter" | "header";
  hint: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  enabled: Record<string, string>;
  disabledMap: Record<string, string>;
  variables: string[];
  canEdit: boolean;
  onChange: (maps: { enabled: Record<string, string>; disabled: Record<string, string> }) => void;
}) {
  const rows = fieldRowsFrom(enabled ?? {}, disabledMap ?? {});
  return (
    <RequestFieldsEditor
      label={label}
      hint={hint}
      rows={rows}
      problems={fieldProblems(rows, kind)}
      namePlaceholder={namePlaceholder}
      valuePlaceholder={valuePlaceholder}
      variables={variables}
      disabled={!canEdit}
      onChange={(next: FieldRow[]) => onChange(fieldMapsFrom(next))}
    />
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
  retries = true,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  /** Whether to offer the step's own retry. A poll node repeats by itself and ignores it. */
  retries?: boolean;
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

      {retries && (
      <>
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
