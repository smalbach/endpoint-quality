import { createContext, useContext, useState, type ReactNode } from "react";
import { Button, Field, InfoTip, inputClass } from "@/components/ui";
import { RequestBodyEditor } from "@/components/request-body-editor";
import { RequestFieldsEditor } from "@/components/request-fields-editor";
import { RequestPreviewPanel } from "@/components/request-preview";
import { cn } from "@/lib/format";
import { NODE_HELP, type NodeKind } from "@/lib/node-help";
import { GRAPHQL_OPERATION_NAME, graphqlVariablesProblem } from "@/lib/graphql-draft";
import { fieldMapsFrom, fieldProblems, fieldRowsFrom, type FieldRow } from "@/lib/request-fields";
import {
  loopBodyIds,
  rerunPathIds,
  removeStep,
  replaceStep,
  schemaJsonProblem,
  suggestCaptures,
  variablesFor,
} from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import { VariableSuggest } from "@/components/variable-suggest";
import {
  NOTIFY_CHANNELS,
  defaultNotify,
  notifyVariableHint,
  webhookVariables,
  type EnvironmentVariableView,
} from "@/lib/workflow-notify";
import { subflowChoices, variablesWrittenBy } from "@/lib/workflow-subflow";
import { mockBodyProblem, mockSampleBody, type MockView } from "@/lib/mock-draft";
import type {
  CaptureSource,
  Environment,
  RequestTemplateView,
  StepCheckView,
  StepConditionView,
  StepFetchView,
  StepGraphqlView,
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
  canEdit,
  onEnvironment,
  onRunSettings,
  runSummary,
  onWorkflow,
  onSteps,
  onTemplate,
  templateUsage,
  onFork,
  forking,
  onRun,
  onDelete,
  running,
  flows = [],
}: {
  /** Every flow of the project, for the subflow node's selector. */
  flows?: WorkflowView[];
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
  canEdit: boolean;
  onEnvironment: (id: string) => void;
  /** Opens «Configurar ejecución»: mode, pause between nodes, parallelism, stop on failure. */
  onRunSettings: () => void;
  /** The settings in a few words, or null when all are at their default. */
  runSummary: string | null;
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
  // Which section is on screen. Kept across nodes on purpose: somebody going through the checks of
  // five requests stays on «Comprobaciones»; a node without that tab falls back to its first one.
  const [tab, setTab] = useState("");

  const settings = (
    <FlowSettings
      workflow={workflow}
      steps={steps}
      environments={environments}
      environmentId={environmentId}
      canEdit={canEdit}
      onEnvironment={onEnvironment}
      onRunSettings={onRunSettings}
      runSummary={runSummary}
      onWorkflow={onWorkflow}
      onRun={onRun}
      onDelete={onDelete}
      running={running}
    />
  );

  if (!step) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {settings}
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
          Selecciona un nodo en el lienzo para configurarlo.
        </p>
      </div>
    );
  }

  const variables = variablesFor(
    steps,
    step.id,
    Object.keys(environments.find((item) => item.id === environmentId)?.variables ?? {}),
  );
  const onChange = (next: WorkflowStepView) => onSteps(replaceStep(steps, next));
  const onRemove = () => onSteps(removeStep(steps, step.id));
  const shell = { active: tab, setActive: setTab, flowTab: { id: "flow", label: "Flujo", content: settings } };
  const kind = step.kind ?? "request";

  return (
    <InspectorShell.Provider value={shell}>
      {kind === "branch" ? (
        <BranchInspector step={step} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "wait" ? (
        <WaitInspector step={step} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "merge" ? (
        <MergeInspector step={step} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "validate" ? (
        <ValidateInspector step={step} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "set" ? (
        <SetInspector step={step} variables={variables} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "script" ? (
        <ScriptInspector step={step} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "loop" ? (
        <LoopInspector
          step={step}
          body={loopBodyIds(steps, step.id)}
          canEdit={canEdit}
          onChange={onChange}
          onRemove={onRemove}
        />
      ) : kind === "notify" ? (
        <NotifyInspector
          step={step}
          variables={variables}
          environmentVariables={environments.find((item) => item.id === environmentId)?.variables}
          canEdit={canEdit}
          onChange={onChange}
          onRemove={onRemove}
        />
      ) : kind === "mock" ? (
        <MockInspector step={step} variables={variables} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "schema" ? (
        <SchemaInspector step={step} steps={steps} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "subflow" ? (
        <SubflowInspector
          step={step}
          flows={flows}
          currentFlowId={workflow.id}
          variables={variables}
          canEdit={canEdit}
          onChange={onChange}
          onRemove={onRemove}
        />
      ) : kind === "retry" ? (
        <RetryInspector step={step} steps={steps} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "poll" ? (
        <PollInspector step={step} steps={steps} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "graphql" ? (
        <GraphqlInspector step={step} variables={variables} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : kind === "fetch" ? (
        <FetchInspector step={step} variables={variables} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
      ) : (
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
          variables={variables}
          canEdit={canEdit}
          sharedBy={template ? templateUsage(template.id) : 0}
          forking={forking}
          onTemplate={onTemplate}
          onFork={(overrides) => onFork(step, overrides)}
          onChange={onChange}
          onRemove={onRemove}
        />
      )}
    </InspectorShell.Provider>
  );
}

/** The flow itself: its name, where it runs, and the button that runs it. */
function FlowSettings({
  workflow,
  steps,
  environments,
  environmentId,
  canEdit,
  onEnvironment,
  onRunSettings,
  runSummary,
  onWorkflow,
  onRun,
  onDelete,
  running,
}: {
  workflow: WorkflowView;
  steps: WorkflowStepView[];
  environments: Environment[];
  environmentId: string;
  canEdit: boolean;
  onEnvironment: (id: string) => void;
  onRunSettings: () => void;
  runSummary: string | null;
  onWorkflow: (change: Partial<Pick<WorkflowView, "name" | "description">>) => void;
  onRun: () => void;
  onDelete: () => void;
  running: boolean;
}) {
  return (
    <div className="grid gap-x-6 gap-y-4 @3xl:grid-cols-2">
      <div>
        <Field label="Nombre del flujo" info={"Cómo aparece el flujo en la lista, en las suites y en el informe. No se puede repetir dentro del proyecto."}>
          <input
            className={inputClass}
            value={workflow.name}
            disabled={!canEdit}
            onChange={(event) => onWorkflow({ name: event.target.value })}
          />
        </Field>
        <div className="mt-3">
          <Field label="Descripción" info={"Texto libre para quien lea el flujo después: qué prueba y por qué. No cambia cómo se ejecuta."}>
            <textarea
              className={`${inputClass} h-20`}
              value={workflow.description ?? ""}
              disabled={!canEdit}
              onChange={(event) => onWorkflow({ description: event.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3 @3xl:border-t-0 @3xl:pt-0">
        <Field label="Entorno" info={"Contra qué entorno se ejecuta: URL base, variables y credenciales de cada rol. Las {{variables}} de los nodos salen de aquí y de lo que capturen los pasos anteriores."}>
          <select className={inputClass} value={environmentId} onChange={(event) => onEnvironment(event.target.value)}>
            <option value="">Selecciona…</option>
            {environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          onClick={onRunSettings}
          className="mt-3 flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
        >
          <span>
            <span className="block font-medium">Configurar ejecución</span>
            <span className="block text-[11px] text-slate-500">{runSummary ?? "Continuo, sin pausa"}</span>
          </span>
          <span aria-hidden>⚙</span>
        </button>
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

type InspectorTab = {
  id: string;
  label: string;
  /** How many things the section holds — captures, checks — so the strip says where the content is. */
  count?: number;
  /** The section has something set that is not the default, without a number to show for it. */
  marked?: boolean;
  content: ReactNode;
};

/** What every node panel shares and none of them owns: the open tab, and the flow's own tab. */
const InspectorShell = createContext<{
  active: string;
  setActive: (id: string) => void;
  flowTab: InspectorTab;
} | null>(null);

/**
 * The frame of a node's panel: what the node is, a tab per section, and the section on screen.
 *
 * Every tab stays mounted and only the open one is shown. A tab switch must not throw away what a
 * section holds without saving it — the response the preview just got, a body pasted to suggest
 * captures from.
 */
function NodePanel({
  kind,
  title,
  subtitle,
  description,
  tabs,
  canEdit,
  removeLabel = "Eliminar nodo",
  onRemove,
}: {
  /** Which node's help the «Ayuda» tab shows. */
  kind: NodeKind;
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  tabs: InspectorTab[];
  canEdit: boolean;
  removeLabel?: string;
  onRemove: () => void;
}) {
  const shell = useContext(InspectorShell);
  if (!shell) throw new Error("NodePanel outside WorkflowInspector");
  const all: InspectorTab[] = [...tabs, { id: "help", label: "Ayuda", content: <NodeHelpView kind={kind} /> }, shell.flowTab];
  const current = all.find((item) => item.id === shell.active) ?? all[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-200 px-5 pt-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{title}</p>
            {subtitle && <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{subtitle}</p>}
            {description && <p className="mt-1 max-w-3xl text-[11px] leading-5 text-slate-500">{description}</p>}
          </div>
          {canEdit && (
            <Button variant="ghost" className="h-7 shrink-0 px-2 text-xs text-rose-600" onClick={onRemove}>
              {removeLabel}
            </Button>
          )}
        </div>
        <div role="tablist" aria-label="Secciones del nodo" className="mt-3 flex gap-1 overflow-x-auto overflow-y-hidden">
          {all.map((item) => {
            const selected = item.id === current.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => shell.setActive(item.id)}
                className={cn(
                  "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap",
                  item.id === "help" && "ml-auto",
                  selected
                    ? "border-slate-900 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-800",
                )}
              >
                {item.label}
                {item.count ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px] leading-4",
                      selected ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600",
                    )}
                  >
                    {item.count}
                  </span>
                ) : item.marked ? (
                  <span aria-label="configurado" className="size-1.5 rounded-full bg-sky-500" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="@container min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {all.map((item) => (
          <div key={item.id} role="tabpanel" hidden={item.id !== current.id}>
            {item.content}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The «Ayuda» tab: what the node does, how it runs, an example, and the mistakes people make with it. */
function NodeHelpView({ kind }: { kind: NodeKind }) {
  const help = NODE_HELP[kind];
  const heading = "text-[10px] font-semibold tracking-wide text-slate-400 uppercase";
  return (
    <div className="grid max-w-5xl gap-x-8 gap-y-5 text-xs leading-5 text-slate-600 @3xl:grid-cols-2">
      <section className="@3xl:col-span-2">
        <p className={heading}>Qué hace · {help.title}</p>
        <p className="mt-1 text-sm text-slate-800">{help.summary}</p>
      </section>
      <section>
        <p className={heading}>Cómo funciona</p>
        <ol className="mt-1.5 list-decimal space-y-1.5 pl-4 marker:text-slate-400">
          {help.how.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </section>
      <div className="space-y-5">
        <section>
          <p className={heading}>Ejemplo</p>
          <p className="mt-1.5 rounded-lg bg-slate-50 px-3 py-2 text-slate-700 ring-1 ring-slate-200">{help.example}</p>
        </section>
        <section>
          <p className={heading}>Errores comunes</p>
          <ul className="mt-1.5 space-y-1.5">
            {help.pitfalls.map((line) => (
              <li key={line} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                {line}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="text-[11px] text-slate-400 @3xl:col-span-2">
        Cada campo lleva una <span className="font-semibold">i</span> junto a su nombre con lo que significa.
      </p>
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
    <NodePanel
      kind="branch"
      title="Bifurcación (If)"
      subtitle={step.id}
      description={
        <>
          Lee la respuesta de un paso anterior y parte el flujo: la salida <span className="text-emerald-600">sí</span>{" "}
          se toma cuando la condición se cumple, la <span className="text-rose-500">no</span> cuando no. Conecta cada
          salida al siguiente paso arrastrando desde su punto.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Condición",
          content:
            sources.length === 0 ? (
              <p className="text-[11px] text-amber-700">Conéctalo a la petición que quieres leer para poder decidir.</p>
            ) : (
              <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_9rem_minmax(0,1fr)]">
                <Field label="Lee el paso" info={"El paso cuya respuesta decide la condición. Solo aparecen los conectados a la entrada del If: sin arista no hay garantía de que ya haya respondido."}>
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
                <Field label="Origen" info={"Qué parte de la respuesta se lee:\n• status: el código HTTP (200, 404…).\n• body: el JSON de la respuesta, con una ruta.\n• header: una cabecera, por su nombre.\n• durationMs: lo que tardó, en milisegundos."}>
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
                <Field label="Ruta" info={"Solo para body y header.\n• body: ruta con puntos, p. ej. data.id o data.items.0.name (los índices de lista son números). Vacía lee el body entero.\n• header: el nombre de la cabecera, p. ej. X-Total-Count.\nCon status y durationMs no se usa."}>
                  <input
                    aria-label="Ruta de la condición"
                    className={inputClass}
                    value={condition.check.path ?? ""}
                    placeholder="data.0.id"
                    disabled={
                      !canEdit || condition.check.source === "status" || condition.check.source === "durationMs"
                    }
                    onChange={(event) => setCheck({ path: event.target.value })}
                  />
                </Field>
                <Field label="Operador" info={"• equals / not_equals: igual o distinto. Compara como texto (200 y «200» son lo mismo); objetos y listas, completos.\n• contains / not_contains: en una lista, que tenga ese elemento; en un texto, que lo incluya.\n• greater_than / less_than: comparación numérica.\n• exists / not_exists: que el valor esté (ni ausente ni null).\n• matches: expresión regular sobre el texto.\n• is_array: que sea una lista.\n• is_not_empty: lista, texto u objeto con al menos un elemento.\n• has_length: tamaño exacto (elementos, caracteres o claves)."}>
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
                </Field>
                {!WITHOUT_OPERAND.includes(condition.check.operator) && (
                  <Field label="Valor" info={"Lo que se espera, como texto o número (con matches, una expresión regular). No aparece con los operadores que no comparan: exists, not_exists, is_array, is_not_empty."}>
                    <input
                      aria-label="Valor de la condición"
                      className={inputClass}
                      value={condition.check.value === undefined ? "" : String(condition.check.value)}
                      disabled={!canEdit}
                      onChange={(event) => setCheck({ value: event.target.value })}
                    />
                  </Field>
                )}
              </div>
            ),
        },
      ]}
    />
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
    <NodePanel
      kind="wait"
      title="Espera"
      subtitle={step.id}
      description="Pausa antes de dejar pasar el flujo. No es un reintento —«no era el momento», no «el fallo no era real»— para el destino que acepta una escritura y tarda un momento en hacerla legible."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Espera",
          content: (
            <div className="max-w-xs">
              <Field label="Milisegundos" info={"Cuánto dura la pausa: de 0 a 60 000 ms (un minuto). El nodo siempre pasa; lo conectado a su salida empieza al acabar."}>
                <input
                  className={inputClass}
                  type="number"
                  min={0}
                  max={60000}
                  value={step.waitMs ?? 0}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onChange({ ...step, waitMs: Math.min(60000, Math.max(0, Number(event.target.value) || 0)) })
                  }
                />
              </Field>
            </div>
          ),
        },
      ]}
    />
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
    <NodePanel
      kind="merge"
      title="Merge (unión)"
      subtitle={step.id}
      description="Junta varias ramas en una. Conecta a su entrada las que quieres unir; el flujo sigue por su salida cuando se cumple la condición de abajo."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Unión",
          count,
          content: (
            <div className="max-w-sm">
              <p className="text-[11px] text-slate-500">
                Ramas conectadas: <span className="font-medium text-slate-700">{count}</span>
              </p>
              <div className="mt-2">
                <Field label="Cuándo continúa" info={"• Cuando llegan todas: espera a que terminen todas las ramas conectadas.\n• Basta con que llegue una: sigue con la primera que termine. Úsalo cuando las ramas son alternativas, como las salidas «sí» y «no» de un If."}>
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
              </div>
            </div>
          ),
        },
      ]}
    />
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
    <NodePanel
      kind="validate"
      title="Validación"
      subtitle={step.id}
      description="Lee la respuesta de un paso anterior y la juzga. Si no pasa, lo que depende de esta validación se salta. Conéctalo al paso que quieres validar arrastrando una arista hasta su entrada."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "checks",
          label: "Comprobaciones",
          count: step.checks?.length,
          content: (
            <>
              {sources.length === 0 ? (
                <p className="text-[11px] text-amber-700">Conéctalo a la petición cuya respuesta quieres validar.</p>
              ) : (
                <div className="max-w-sm">
                  <Field label="Lee el paso" info={"El paso cuya respuesta se juzga. Solo aparecen los conectados a la entrada de la validación."}>
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
                </div>
              )}
              <div className="mt-4 border-t border-slate-100 pt-3">
                <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />
              </div>
            </>
          ),
        },
        {
          id: "script",
          label: "Script",
          marked: Boolean(step.validate?.script),
          content: (
            <>
              <p className="text-[11px] leading-5 text-slate-500">
                Se ejecuta en un proceso aislado con la API <code className="font-mono">pm</code>:{" "}
                <code className="font-mono">pm.response</code>, <code className="font-mono">pm.expect</code>,{" "}
                <code className="font-mono">pm.test(...)</code>. La validación pasa si todos sus{" "}
                <code className="font-mono">pm.test</code> pasan.
              </p>
              <textarea
                aria-label="Script de validación"
                className={`${inputClass} mt-2 h-[26rem] font-mono text-[11px]`}
                placeholder={
                  "pm.test('trae un id', function () {\n  pm.expect(pm.response.json().data.id).to.be.a('string');\n});"
                }
                value={step.validate?.script ?? ""}
                disabled={!canEdit}
                spellCheck={false}
                onChange={(event) => setValidate({ script: event.target.value || undefined })}
              />
            </>
          ),
        },
      ]}
    />
  );
}

/** Whether «Cuándo» holds anything beyond «right after the previous one, once». */
const scheduled = (step: WorkflowStepView) =>
  Boolean(step.runIf || step.forEach || step.waitMs || step.waits === "any");
/** Whether «Si falla» differs from the default: skip dependents, no retry. */
const failureSet = (step: WorkflowStepView) =>
  Boolean(step.retry || (step.onError && step.onError !== "skip-dependents"));

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
  // The last body the preview got back, so the captures can be suggested from a real response
  // instead of typed by hand. Held here because the preview panel that fetches it and the captures
  // that spend it are two tabs of the same node.
  const [sampleBody, setSampleBody] = useState<unknown>(undefined);
  const operation = template && operations.find((item) => item.id === template.operationId);
  const countOf = (map: Record<string, string> | undefined) => Object.keys(map ?? {}).length;

  const requestTab: InspectorTab = {
    id: "request",
    label: "Petición",
    count: template ? countOf(template.parameters) + countOf(template.headers) : undefined,
    content: template ? (
      <>
        {/* A reusable request edited here is one row: the change reaches every node that shares it. So
            when more than one does, the panel says so and offers a private copy — and changing the
            operation, which never means «make the others a different request too», forks on its own. */}
        {shared && canEdit && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
            <span>
              Esta petición la usan <span className="font-semibold">{sharedBy} nodos</span>. Al editarla cambian todos.
            </span>
            <button
              className="rounded-md bg-amber-100 px-2 py-1 font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50"
              disabled={forking}
              onClick={() => onFork()}
            >
              {forking ? "Creando copia…" : "Hacer independiente este nodo"}
            </button>
          </div>
        )}
        <div className="grid gap-3 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_6.5rem_8rem]">
          <Field label="Operación" info={"La operación del contrato que envía el paso (método y ruta). De ella salen los parámetros que existen y el esquema con el que se valida la respuesta. Si esta petición la comparten varios nodos, cambiarla crea una copia solo para este."}>
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
              {operations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.method} {item.path}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nombre" info={"Nombre de la prueba reutilizable: es el título del nodo y el nombre en el informe. Cambia en todos los nodos que compartan la petición."}>
            <input
              className={inputClass}
              value={template.name}
              disabled={!canEdit}
              onChange={(event) => onTemplate({ ...template, name: event.target.value })}
            />
          </Field>
          <Field label="Estado" info={"Código HTTP que debe responder: 200 al leer, 201 al crear, 204 al borrar, 404 si esperas que ya no exista… Si llega otro, el paso falla con «status». Junto al esquema del contrato y las comprobaciones, decide si el paso pasa."}>
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
          <Field label="Auth" info={"Qué credencial del entorno presenta el paso:\n• default: la principal del rol, o el token de un login anterior.\n• none: ninguna; para comprobar que responde 401.\n• insufficient: una que autentica pero sin permisos; para comprobar el 403.\n• api-key: la credencial alternativa (clave API) del entorno."}>
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
        <div className="mt-4 grid gap-x-6 gap-y-2 border-t border-slate-100 pt-1 @3xl:grid-cols-2">
          <RequestFieldsRows
            label="Parámetros" info={"Parámetros de ruta ({id} en /widgets/{id}) y de consulta (?page=2), por nombre. El valor acepta {{variables}}: id = {{widgetId}}. Un parámetro de ruta que no pongas se rellena con un valor de ejemplo, no con lo que creó un paso anterior. El interruptor de cada fila la apaga sin borrarla."}
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
            label="Cabeceras" info={"Cabeceras extra por nombre y valor; aceptan {{variables}}. Ganan sobre las que pone el motor. El interruptor de cada fila la apaga sin borrarla."}
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
        </div>
      </>
    ) : (
      <p className="text-[11px] text-rose-600">
        Este paso apunta a una prueba que ya no existe. Bórralo o vuelve a crearla.
      </p>
    ),
  };

  return (
    <NodePanel
      kind={step.kind === "login" ? "login" : "request"}
      title={template?.name || "Prueba reutilizable"}
      subtitle={operation ? `${operation.method} ${operation.path} · ${step.id}` : step.id}
      canEdit={canEdit}
      removeLabel="Eliminar paso"
      onRemove={onRemove}
      tabs={[
        requestTab,
        ...(template
          ? [
              {
                id: "body",
                label: "Body",
                marked: template.body.type !== "none",
                content: (
                  // Body and what it gets back side by side: the edit and its answer in one look.
                  <div className="grid gap-x-6 gap-y-4 @3xl:grid-cols-2">
                    <div className="-mt-2">
                      <RequestBodyEditor
                        body={template.body}
                        variables={variables}
                        canEdit={canEdit}
                        onChange={(body) => onTemplate({ ...template, body })}
                      />
                    </div>
                    {/* Lo que hay en el formulario, enviado de verdad. No hace falta guardar antes: lo
                        que se manda es lo que se está mirando. */}
                    <div className="-mt-3">
                      <RequestPreviewPanel
                        base={base}
                        template={template}
                        environmentId={environmentId}
                        canSend={canEdit}
                        onResponseBody={setSampleBody}
                      />
                    </div>
                  </div>
                ),
              },
            ]
          : []),
        {
          id: "captures",
          label: "Capturas",
          count: step.captures?.length,
          marked: Boolean(step.authorizes),
          content: <CapturesTab step={step} canEdit={canEdit} sampleBody={sampleBody} session onChange={onChange} />,
        },
        {
          id: "checks",
          label: "Comprobaciones",
          count: step.checks?.length,
          content: <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "schedule",
          label: "Cuándo",
          marked: scheduled(step),
          content: <ScheduleEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** Captures, and — for the nodes that can log in — the session beside them: both are what a
 * response hands on to the steps after it. */
function CapturesTab({
  step,
  canEdit,
  sampleBody,
  session = false,
  onChange,
}: {
  step: WorkflowStepView;
  canEdit: boolean;
  sampleBody?: unknown;
  session?: boolean;
  onChange: (step: WorkflowStepView) => void;
}) {
  if (!session) return <CapturesEditor step={step} canEdit={canEdit} sampleBody={sampleBody} onChange={onChange} />;
  return (
    <div className="grid gap-x-6 gap-y-4 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <CapturesEditor step={step} canEdit={canEdit} sampleBody={sampleBody} onChange={onChange} />
      <div className="border-t border-slate-100 pt-3 @4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-6">
        <SessionEditor step={step} canEdit={canEdit} onChange={onChange} />
      </div>
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
    <NodePanel
      kind="fetch"
      title="Fetch"
      subtitle={call.url ? `${call.method} ${call.url} · ${step.id}` : step.id}
      description={
        <>
          Una petición escrita a mano, fuera del catálogo: un webhook, otro servicio, un proveedor de identidad. Una
          ruta como <span className="font-mono">/things</span> cuelga de la URL base del entorno. Todo acepta{" "}
          <span className="font-mono">{"{{variables}}"}</span>.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "request",
          label: "Petición",
          count: Object.keys(call.headers ?? {}).length,
          content: (
            <>
              <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 @3xl:grid-cols-[6.5rem_minmax(0,1fr)_8rem]">
                <Field label="Método" info={"Método HTTP de la llamada. GET y HEAD no llevan body. Con un entorno sin escrituras permitidas, POST, PUT, PATCH y DELETE al mismo origen se bloquean."}>
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
                <Field label="URL" info={"Absoluta (https://api.ejemplo.com/cosas) o una ruta (/cosas), que se añade a la URL base del entorno. Acepta {{variables}}: /widgets/{{widgetId}}."}>
                  <input
                    className={`${inputClass} font-mono text-[11px]`}
                    value={call.url}
                    placeholder="https://api.ejemplo.com/recurso/{{id}}"
                    list={`fetch-vars-${step.id}`}
                    disabled={!canEdit}
                    onChange={(event) => setCall({ url: event.target.value })}
                  />
                </Field>
                <Field label="Estado esperado" info={"Código HTTP que debe responder. Vacío acepta cualquier 2xx. Si llega otro, el nodo falla."}>
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
              </div>
              <datalist id={`fetch-vars-${step.id}`}>
                {variables.map((name) => (
                  <option key={name} value={`{{${name}}}`} />
                ))}
              </datalist>
              <label className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={Boolean(call.useSession)}
                  disabled={!canEdit}
                  onChange={(event) => setCall({ useSession: event.target.checked || undefined })}
                />
                Enviar sesión del login
                <InfoTip label={"Qué es «Enviar sesión del login»"}>{"Envía el token del login anterior, con su cabecera y prefijo. Sin marcar, la llamada va sin sesión. Con una URL absoluta a otro host, el token viaja a ese host."}</InfoTip>
              </label>
              {call.useSession && /^https?:\/\//i.test(call.url) && (
                <p className="mt-1 text-[11px] text-amber-700">
                  La credencial obtenida en el login viajará a esta URL. Úsalo solo con hosts de confianza.
                </p>
              )}
              <div className="mt-3 border-t border-slate-100 pt-1">
                <RequestFieldsRows
                  label="Cabeceras" info={"Cabeceras de la llamada; aceptan {{variables}}. Para autenticar a mano: Authorization = Bearer {{token}}. Content-Type se deduce del body si no la pones."}
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
              </div>
            </>
          ),
        },
        ...(bodyAllowed
          ? [
              {
                id: "body",
                label: "Body",
                marked: Boolean(call.body),
                content: (
                  <Field label="Body" info={"Cuerpo de la petición, normalmente JSON: {\"id\": \"{{thingId}}\"}. Las {{variables}} se sustituyen antes de enviar. Content-Type se deduce si no lo pones en las cabeceras."}>
                    <textarea
                      className={`${inputClass} h-[24rem] font-mono text-[11px]`}
                      placeholder={'{"id": "{{thingId}}"}'}
                      value={call.body ?? ""}
                      disabled={!canEdit}
                      spellCheck={false}
                      onChange={(event) => setCall({ body: event.target.value || undefined })}
                    />
                  </Field>
                ),
              },
            ]
          : []),
        {
          id: "captures",
          label: "Capturas",
          count: step.captures?.length,
          marked: Boolean(step.authorizes),
          content: <CapturesTab step={step} canEdit={canEdit} session onChange={onChange} />,
        },
        {
          id: "checks",
          label: "Comprobaciones",
          count: step.checks?.length,
          content: <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "schedule",
          label: "Cuándo",
          marked: scheduled(step),
          content: <ScheduleEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** A GraphQL node: the operation — URL, query, variables, operationName, headers — then the same
 * captures, checks and failure handling as a fetch. Always a JSON POST, so there is no method to pick. */
function GraphqlInspector({
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
  const call: StepGraphqlView = step.graphql ?? { url: "", query: "" };
  const setCall = (change: Partial<StepGraphqlView>) => onChange({ ...step, graphql: { ...call, ...change } });
  const variablesProblem = graphqlVariablesProblem(call.variables);
  const badName = Boolean(call.operationName) && !GRAPHQL_OPERATION_NAME.test(call.operationName ?? "");

  return (
    <NodePanel
      kind="graphql"
      title="GraphQL"
      subtitle={call.url ? `${call.operationName || "anónima"} · ${call.url} · ${step.id}` : step.id}
      description={
        <>
          Una operación GraphQL enviada como POST JSON. Falla si la respuesta trae{" "}
          <span className="font-mono">errors</span>, aunque el estado sea 200. Las capturas y comprobaciones leen el
          body: <span className="font-mono">data.…</span>. URL, query, variables y cabeceras aceptan{" "}
          <span className="font-mono">{"{{variables}}"}</span>.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "request",
          label: "Petición",
          count: Object.keys(call.headers ?? {}).length,
          content: (
            <>
              <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_12rem_8rem]">
                <Field label="URL" info={"Endpoint GraphQL: absoluta o una ruta (/graphql) bajo la URL base del entorno. Acepta {{variables}}."}>
                  <input
                    className={`${inputClass} font-mono text-[11px]`}
                    value={call.url}
                    placeholder="/graphql o https://api.ejemplo.com/graphql"
                    list={`graphql-vars-${step.id}`}
                    disabled={!canEdit}
                    onChange={(event) => setCall({ url: event.target.value })}
                  />
                </Field>
                <Field label="operationName" info={"Qué operación ejecutar cuando la query define varias. Opcional si solo hay una. Solo letras, números y _, sin empezar por número."}>
                  <input
                    className={`${inputClass} font-mono text-[11px]`}
                    value={call.operationName ?? ""}
                    placeholder="opcional"
                    disabled={!canEdit}
                    onChange={(event) => setCall({ operationName: event.target.value || undefined })}
                  />
                </Field>
                <Field label="Estado esperado" info={"Código HTTP que debe responder. Vacío acepta cualquier 2xx. Aunque llegue 200, el nodo falla si la respuesta trae errors (salvo «Admitir errors»)."}>
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
              </div>
              {badName && (
                <p className="mt-1 text-[11px] text-rose-600">
                  Un operationName solo lleva letras, números y _, sin empezar por número.
                </p>
              )}
              <datalist id={`graphql-vars-${step.id}`}>
                {variables.map((name) => (
                  <option key={name} value={`{{${name}}}`} />
                ))}
              </datalist>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                  <input
                    type="checkbox"
                    checked={Boolean(call.useSession)}
                    disabled={!canEdit}
                    onChange={(event) => setCall({ useSession: event.target.checked || undefined })}
                  />
                  Enviar sesión del login
                  <InfoTip label={"Qué es «Enviar sesión del login»"}>{"Envía el token del login anterior, con su cabecera y prefijo. Sin marcar, la llamada va sin sesión. Con una URL absoluta a otro host, el token viaja a ese host."}</InfoTip>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                  <input
                    type="checkbox"
                    checked={Boolean(call.allowErrors)}
                    disabled={!canEdit}
                    onChange={(event) => setCall({ allowErrors: event.target.checked || undefined })}
                  />
                  Admitir errors en la respuesta
                  <InfoTip label={"Qué es «Admitir errors en la respuesta»"}>{"Por defecto una respuesta con errors no vacío falla aunque sea 200. Márcalo si esperas errores parciales y los juzgas con comprobaciones."}</InfoTip>
                </label>
              </div>
              {call.useSession && /^https?:\/\//i.test(call.url) && (
                <p className="mt-1 text-[11px] text-amber-700">
                  La credencial obtenida en el login viajará a esta URL. Úsalo solo con hosts de confianza.
                </p>
              )}
              <div className="mt-3 grid gap-3 @3xl:grid-cols-2">
                <Field label="Query" info={"El documento GraphQL: query o mutation, con sus $variables declaradas. Ejemplo: query Widget($id: ID!) { widget(id: $id) { id } }."}>
                  <textarea
                    className={`${inputClass} h-[18rem] font-mono text-[11px]`}
                    placeholder={"query Cosa($id: ID!) {\n  cosa(id: $id) { id nombre }\n}"}
                    value={call.query}
                    disabled={!canEdit}
                    spellCheck={false}
                    onChange={(event) => setCall({ query: event.target.value })}
                  />
                </Field>
                <Field label="Variables (JSON)" info={"Objeto JSON con los valores de las $variables de la query: {\"id\": \"{{widgetId}}\"}. Las {{variables}} se sustituyen antes de interpretar el JSON."}>
                  <textarea
                    className={cn(`${inputClass} h-[18rem] font-mono text-[11px]`, variablesProblem && "border-rose-300")}
                    placeholder={'{\n  "id": "{{thingId}}"\n}'}
                    value={call.variables ?? ""}
                    disabled={!canEdit}
                    spellCheck={false}
                    onChange={(event) => setCall({ variables: event.target.value || undefined })}
                  />
                  {variablesProblem && <p className="mt-1 text-[11px] text-rose-600">{variablesProblem}</p>}
                </Field>
              </div>
              <div className="mt-3 border-t border-slate-100 pt-1">
                <RequestFieldsRows
                  label="Cabeceras" info={"Cabeceras de la llamada; aceptan {{variables}}. Content-Type: application/json se añade si no la pones."}
                  kind="header"
                  hint="Content-Type: application/json se añade si no la pones."
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
              </div>
            </>
          ),
        },
        {
          id: "checks",
          label: "Comprobaciones",
          count: step.checks?.length,
          content: <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "captures",
          label: "Capturas",
          count: step.captures?.length,
          marked: Boolean(step.authorizes),
          content: <CapturesTab step={step} canEdit={canEdit} session onChange={onChange} />,
        },
        {
          id: "schedule",
          label: "Cuándo",
          marked: scheduled(step),
          content: <ScheduleEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
      ]}
    />
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
    <NodePanel
      kind="set"
      title="Set (variables)"
      subtitle={step.id}
      description={
        <>
          Escribe variables para los pasos siguientes sin hacer ninguna petición. El valor es una plantilla:{" "}
          <span className="font-mono">{"{{thingId}}"}</span>, <span className="font-mono">{"pedido-{{$uuid}}"}</span>.
          Solo vale durante la corrida; el entorno guardado no cambia.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "variables",
          label: "Variables",
          count: assignments.length,
          content: (
            <>
              <datalist id={listId}>
                {variables.map((name) => (
                  <option key={name} value={`{{${name}}}`} />
                ))}
              </datalist>
              {assignments.length > 0 && (
                <div className="mb-1 hidden grid-cols-[minmax(0,1fr)_1rem_minmax(0,1.6fr)_1.5rem] gap-1.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase @3xl:grid">
                  <span className="flex items-center">Variable<InfoTip label={"Qué es «Variable»"}>{"Nombre de la variable que se escribe. Si ya existe, se sobrescribe para el resto de la corrida."}</InfoTip></span>
                  <span />
                  <span className="flex items-center">Valor<InfoTip label={"Qué es «Valor»"}>{"Plantilla que se resuelve al ejecutar: texto con {{variables}} y valores generados como {{$uuid}}. Si usa una variable que no existe, el nodo falla."}</InfoTip></span>
                </div>
              )}
              <div className="space-y-2">
                {assignments.map((assignment, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1.6fr)_1.5rem] items-center gap-1.5"
                  >
                    <input
                      aria-label="Variable"
                      className={cn(inputClass, "mt-0 font-mono text-[11px]")}
                      value={assignment.variable}
                      placeholder="total"
                      disabled={!canEdit}
                      onChange={(event) =>
                        edit(
                          assignments.map((item, position) =>
                            position === index ? { ...item, variable: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <span className="text-center text-xs text-slate-400">=</span>
                    <input
                      aria-label="Valor"
                      className={cn(inputClass, "mt-0 font-mono text-[11px]")}
                      value={assignment.value}
                      placeholder="{{precio}}"
                      list={listId}
                      disabled={!canEdit}
                      onChange={(event) =>
                        edit(
                          assignments.map((item, position) =>
                            position === index ? { ...item, value: event.target.value } : item,
                          ),
                        )
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
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
      ]}
    />
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
    <NodePanel
      kind="script"
      title="Script"
      subtitle={step.id}
      description={
        <>
          JavaScript en un proceso aislado, sin red ni ficheros. Lee con <code className="font-mono">pm.response</code>{" "}
          y <code className="font-mono">pm.variables.get</code>, escribe con{" "}
          <code className="font-mono">pm.variables.set</code> (solo para esta corrida) y comprueba con{" "}
          <code className="font-mono">pm.test</code>. Falla si lanza un error o si un{" "}
          <code className="font-mono">pm.test</code> falla. Lo que imprime queda en el informe, con los secretos
          ocultos.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "script",
          label: "Script",
          content: (
            <>
              <div className="max-w-sm">
                <Field label="Lee la respuesta de" info={"Paso cuya respuesta queda en pm.response dentro del script. «Ninguna» si el script solo trabaja con variables. Solo aparecen los conectados a la entrada."}>
                  <select
                    className={inputClass}
                    value={script.from ?? ""}
                    disabled={!canEdit}
                    onChange={(event) =>
                      onChange({
                        ...step,
                        script: event.target.value
                          ? { code: script.code, from: event.target.value }
                          : { code: script.code },
                      })
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
              </div>
              <textarea
                aria-label="Código del script"
                className={`${inputClass} mt-3 h-[26rem] font-mono text-[11px]`}
                placeholder={
                  "const body = pm.response.json();\npm.variables.set('total', String(body.data.length));\npm.test('hay datos', () => pm.expect(body.data.length).to.be.above(0));"
                }
                value={script.code}
                disabled={!canEdit}
                spellCheck={false}
                onChange={(event) => onChange({ ...step, script: { ...script, code: event.target.value } })}
              />
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
      ]}
    />
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
    <NodePanel
      kind="loop"
      title="Bucle"
      subtitle={step.id}
      description="Recorre una lista que devolvió un paso anterior. Lo que conectes a la salida «cada» —y todo lo que cuelgue de ello— se ejecuta una vez por elemento, en orden, y cada vuelta deja su propio caso por nodo. La salida «fin» sigue cuando terminan todas las vueltas."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Bucle",
          content: (
            <>
              <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_9rem]">
                {sources.length === 0 ? (
                  <p className="text-[11px] text-amber-700 @3xl:self-center">Conéctalo al paso cuya respuesta trae la lista.</p>
                ) : (
                  <Field label="Lee la lista de" info={"Paso cuya respuesta trae la lista a recorrer. Solo aparecen los conectados a la entrada del bucle."}>
                    <select
                      className={inputClass}
                      value={loop.from}
                      disabled={!canEdit}
                      onChange={(event) => setLoop({ from: event.target.value })}
                    >
                      {!sources.includes(loop.from) && <option value="">Elige un paso</option>}
                      {sources.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Ruta a la lista en el body" info={"Ruta con puntos hasta el array dentro del body: data, data.items. Si no apunta a una lista, el nodo falla."}>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    value={loop.path}
                    placeholder="data.items"
                    disabled={!canEdit}
                    onChange={(event) => setLoop({ path: event.target.value })}
                  />
                </Field>
                <Field label="Cada elemento" info={"Nombre de la variable con el elemento de cada vuelta. Con «item»: {{item}} es el elemento entero en JSON y {{item.id}} uno de sus campos."}>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    value={loop.as}
                    disabled={!canEdit}
                    onChange={(event) => setLoop({ as: event.target.value })}
                  />
                </Field>
                <Field label="Máx. vueltas" info={"Tope de vueltas (1–200), para que una lista más larga de lo esperado no alargue la corrida sin límite."}>
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
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Úsalo como <code className="font-mono">{`{{${name}.id}}`}</code> campo a campo, o{" "}
                <code className="font-mono">{`{{${name}}}`}</code> para el elemento entero en JSON.
              </p>
              <p className={`mt-2 text-[11px] leading-5 ${body.length ? "text-slate-600" : "text-amber-700"}`}>
                {body.length ? `Por vuelta: ${body.join(" → ")}` : "Nada conectado a «cada»: el bucle no ejecutará nada."}
              </p>
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** A notify node: the channel, the environment variable that holds the webhook URL, and the message. */
function NotifyInspector({
  step,
  variables,
  environmentVariables,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  /** What `{{` offers in the message: environment, earlier captures, computed values. */
  variables: string[];
  /** The chosen environment's variables, for the URL picker. Undefined with no environment chosen. */
  environmentVariables: Record<string, EnvironmentVariableView> | undefined;
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const notify = step.notify ?? defaultNotify();
  const setNotify = (change: Partial<NonNullable<WorkflowStepView["notify"]>>) =>
    onChange({ ...step, notify: { ...notify, ...change } });
  const channel = NOTIFY_CHANNELS.find((item) => item.value === notify.channel);
  const candidates = webhookVariables(environmentVariables ?? {});
  const hint = notifyVariableHint(notify.urlVariable, environmentVariables);
  const listId = `notify-url-${step.id}`;

  return (
    <NodePanel
      kind="notify"
      title="Notificar"
      subtitle={step.id}
      description={
        <>
          Envía un mensaje a Slack, Teams o un webhook en mitad del flujo:{" "}
          <span className="font-mono">{"pedido creado: {{orderId}}"}</span>, o en la rama «no» de un If. La URL del
          webhook es un secreto: vive en una variable del entorno (mejor sensible) y aquí solo se escribe su nombre; en
          el informe aparece enmascarada.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Mensaje",
          content: (
            <>
              <div className="grid gap-3 @3xl:grid-cols-2">
                <Field label="Canal" info={"Formato del mensaje:\n• Slack: incoming webhook de Slack.\n• Microsoft Teams: webhook entrante de Teams.\n• Webhook: tu propia URL.\nLa ayuda bajo el selector dice qué cuerpo recibe cada uno."} hint={channel?.hint}>
                  <select
                    className={inputClass}
                    value={notify.channel}
                    disabled={!canEdit}
                    onChange={(event) => setNotify({ channel: event.target.value as typeof notify.channel })}
                  >
                    {NOTIFY_CHANNELS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div>
                  <Field label="Variable del entorno con la URL" info={"Nombre (no el valor) de la variable del entorno activo que guarda la URL del webhook, p. ej. SLACK_WEBHOOK_URL. Márcala como sensible: la URL es un secreto y en el informe sale enmascarada. Si no existe en el entorno, el nodo falla."}>
                    <input
                      aria-label="Variable del entorno con la URL"
                      className={cn(inputClass, "font-mono text-[11px]")}
                      value={notify.urlVariable}
                      list={listId}
                      placeholder="SLACK_WEBHOOK_URL"
                      disabled={!canEdit}
                      spellCheck={false}
                      onChange={(event) => setNotify({ urlVariable: event.target.value.trim() })}
                    />
                  </Field>
                  <datalist id={listId}>
                    {candidates.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.sensitive ? "sensible" : ""}
                      </option>
                    ))}
                  </datalist>
                  {hint && (
                    <p className={`mt-1 text-[11px] leading-5 ${hint.tone === "warn" ? "text-amber-700" : "text-slate-500"}`}>
                      {hint.text}
                    </p>
                  )}
                </div>
              </div>
              <Field label="Mensaje" info={"Texto a enviar. Escribe {{ para insertar variables: {{orderId}}, {{baseUrl}}… Si alguna no existe al ejecutar, el nodo falla sin enviar nada."}>
                <VariableSuggest variables={variables} value={notify.message} onChange={(message) => setNotify({ message })}>
                  {(suggest) => (
                    <textarea
                      {...suggest}
                      aria-label="Mensaje"
                      className={`${inputClass} mt-1 h-32 font-mono text-[11px]`}
                      placeholder={"Pedido creado: {{orderId}}"}
                      disabled={!canEdit}
                      spellCheck={false}
                    />
                  )}
                </VariableSuggest>
              </Field>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                Escribe <span className="font-mono">{"{{"}</span> para usar una variable. Si alguna no está definida al
                ejecutar, el nodo falla sin enviar nada.
              </p>
              <label className="mt-3 flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={notify.onError === "fail"}
                  disabled={!canEdit}
                  onChange={(event) => setNotify({ onError: event.target.checked ? "fail" : "continue" })}
                />
                Fallar el nodo si el mensaje no llega (respuesta no 2xx o sin conexión)
                <InfoTip label={"Qué es «Fallar el nodo si el mensaje no llega (respuesta no 2xx o sin conexión)»"}>{"Sin marcar, un envío fallido deja el nodo en verde con un aviso: una caída del chat no es un fallo de la API. Márcalo si que el aviso llegue es parte de lo que pruebas."}</InfoTip>
              </label>
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                Desmarcado, un envío fallido deja el nodo en verde con un aviso: una caída del chat no es un fallo de la API.
              </p>
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** A mock node: the response it answers with — status, headers, body, delay — then the same checks,
 * captures and failure handling as a request. Its captures are suggested from its own body. */
function MockInspector({
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
  const mock: MockView = step.mock ?? { status: 200 };
  const setMock = (change: Partial<MockView>) => onChange({ ...step, mock: { ...mock, ...change } });
  const bodyProblem = mockBodyProblem(mock);
  const listId = `mock-vars-${step.id}`;

  return (
    <NodePanel
      kind="mock"
      title="Mock (respuesta simulada)"
      subtitle={`${mock.status} · ${step.id}`}
      description={
        <>
          No hace ninguna petición: responde lo que escribas aquí, y los nodos siguientes lo leen como una respuesta
          real. Sirve para montar el flujo antes de que exista el servicio o para fijar una respuesta. Cabeceras y body
          aceptan <span className="font-mono">{"{{variables}}"}</span>; una que no exista hace fallar el nodo. El
          informe lo marca como simulado.
        </>
      }
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "response",
          label: "Respuesta",
          count: Object.keys(mock.headers ?? {}).length,
          content: (
            <>
              <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-[8rem_10rem]">
                <Field label="Estado" info={"Código HTTP de la respuesta simulada (100–599). Las comprobaciones y los nodos siguientes lo leen como si fuera real."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={100}
                    max={599}
                    value={Number.isFinite(mock.status) ? mock.status : ""}
                    disabled={!canEdit}
                    onChange={(event) => setMock({ status: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Retardo (ms)" info={"Cuánto tarda el mock en responder (0–60 000 ms), para simular un servicio lento. Vacío = inmediato."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={60000}
                    placeholder="0"
                    value={mock.delayMs ?? ""}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setMock({ delayMs: event.target.value ? Number(event.target.value) : undefined })
                    }
                  />
                </Field>
              </div>
              <datalist id={listId}>
                {variables.map((name) => (
                  <option key={name} value={`{{${name}}}`} />
                ))}
              </datalist>
              <div className="mt-3 border-t border-slate-100 pt-1">
                <RequestFieldsRows
                  label="Cabeceras" info={"Cabeceras de la respuesta simulada. Las comprobaciones de header y las capturas las leen."}
                  kind="header"
                  hint="Sin Content-Type se deduce del body: application/json si es JSON, text/plain si no."
                  namePlaceholder="Content-Type"
                  valuePlaceholder="application/json"
                  enabled={mock.headers ?? {}}
                  disabledMap={mock.disabledHeaders ?? {}}
                  variables={variables}
                  canEdit={canEdit}
                  onChange={(maps) =>
                    setMock({
                      headers: Object.keys(maps.enabled).length ? maps.enabled : undefined,
                      disabledHeaders: Object.keys(maps.disabled).length ? maps.disabled : undefined,
                    })
                  }
                />
              </div>
              <Field label="Body" info={"Body de la respuesta simulada. Si es JSON, las capturas y comprobaciones lo recorren con rutas (data.id). Acepta {{variables}}; una que no exista hace fallar el nodo."}>
                <textarea
                  aria-label="Body simulado"
                  className={`${inputClass} h-[18rem] font-mono text-[11px]`}
                  placeholder={'{"id": "{{thingId}}", "estado": "pendiente"}'}
                  value={mock.body ?? ""}
                  disabled={!canEdit}
                  spellCheck={false}
                  onChange={(event) => setMock({ body: event.target.value || undefined })}
                />
              </Field>
              {bodyProblem && <p className="mt-1 text-[11px] leading-5 text-amber-700">El {bodyProblem}</p>}
            </>
          ),
        },
        {
          id: "checks",
          label: "Comprobaciones",
          count: step.checks?.length,
          content: <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "captures",
          label: "Capturas",
          count: step.captures?.length,
          content: <CapturesTab step={step} canEdit={canEdit} sampleBody={mockSampleBody(mock)} onChange={onChange} />,
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** A schema node: the step whose body it validates, and the contract's schema or one written here. */
function SchemaInspector({
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
  const sources = step.dependsOn ?? [];
  const schema = step.schema ?? { from: "", source: "custom" as const };
  const setSchema = (change: Partial<NonNullable<WorkflowStepView["schema"]>>) =>
    onChange({ ...step, schema: { ...schema, ...change } });
  const fromKind = steps.find((other) => other.id === schema.from)?.kind ?? "request";
  // The contract is looked up by operation, and only a saved request or a login has one.
  const contractable = fromKind === "request" || fromKind === "login";
  const jsonProblem = schema.source === "custom" ? schemaJsonProblem(schema.json) : null;

  return (
    <NodePanel
      kind="schema"
      title="Esquema"
      subtitle={step.id}
      description="Valida el body de la respuesta de un paso contra un JSON Schema: el que el contrato declara para esa operación y el código que llegó, o uno escrito aquí —para un fetch a un servicio que el contrato no describe—. En modo estricto también falla con los campos que el esquema no declara."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Esquema",
          content: (
            <>
              <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                {sources.length === 0 ? (
                  <p className="text-[11px] text-amber-700 @3xl:self-center">Conéctalo al paso cuya respuesta quieres validar.</p>
                ) : (
                  <Field label="Valida el paso" info={"Paso cuyo body se valida. Solo aparecen los conectados a la entrada."}>
                    <select
                      className={inputClass}
                      value={schema.from}
                      disabled={!canEdit}
                      onChange={(event) => setSchema({ from: event.target.value })}
                    >
                      {!sources.includes(schema.from) && <option value="">Elige un paso</option>}
                      {sources.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Contra" info={"• El contrato (OpenAPI): el esquema que declara la operación de ese paso para el código que respondió. Solo para peticiones y logins.\n• Un esquema propio: el JSON Schema escrito debajo; sirve para fetch, GraphQL o mock."}>
                  <select
                    className={inputClass}
                    value={schema.source}
                    disabled={!canEdit}
                    onChange={(event) => setSchema({ source: event.target.value as "contract" | "custom" })}
                  >
                    <option value="contract" disabled={!contractable}>
                      El contrato (OpenAPI)
                    </option>
                    <option value="custom">Un esquema propio</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 text-xs text-slate-700 @3xl:self-end @3xl:pb-2">
                  <input
                    type="checkbox"
                    checked={Boolean(schema.strict)}
                    disabled={!canEdit}
                    onChange={(event) => setSchema({ strict: event.target.checked })}
                  />
                  Estricto: sin campos no declarados
                  <InfoTip label={"Qué es «Estricto: sin campos no declarados»"}>{"Además de lo que exige el esquema, falla si el body trae campos que el esquema no declara. Sirve para detectar datos de más, como un password en la respuesta."}</InfoTip>
                </label>
              </div>
              {schema.source === "contract" ? (
                <p className={`mt-3 text-[11px] leading-5 ${contractable ? "text-slate-500" : "text-amber-700"}`}>
                  {contractable
                    ? "Usa el esquema que el contrato declara para la operación de ese paso y el código de estado que respondió. Si el contrato no declara uno, el nodo falla."
                    : "Ese paso no es una petición guardada: el contrato no sabe qué debería responder. Usa un esquema propio."}
                </p>
              ) : (
                <>
                  <textarea
                    aria-label="JSON Schema"
                    className={`${inputClass} mt-3 h-[22rem] font-mono text-[11px]`}
                    value={schema.json ?? ""}
                    disabled={!canEdit}
                    spellCheck={false}
                    placeholder={'{\n  "type": "object",\n  "required": ["data"]\n}'}
                    onChange={(event) => setSchema({ json: event.target.value })}
                  />
                  <p className={`mt-1 text-[11px] leading-5 ${jsonProblem ? "text-amber-700" : "text-slate-500"}`}>
                    {jsonProblem ??
                      "type, required, properties, items, enum, allOf/anyOf/oneOf, mínimos y máximos. $ref locales (#/definitions/…). Sin «pattern»."}
                  </p>
                </>
              )}
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** A subflow node: the flow it runs, the variables it passes in, and the ones it takes back. */
function SubflowInspector({
  step,
  flows,
  currentFlowId,
  variables,
  canEdit,
  onChange,
  onRemove,
}: {
  step: WorkflowStepView;
  flows: WorkflowView[];
  currentFlowId: string;
  variables: string[];
  canEdit: boolean;
  onChange: (step: WorkflowStepView) => void;
  onRemove: () => void;
}) {
  const config = step.subflow ?? { workflowId: "" };
  const inputs = config.inputs ?? [];
  const outputs = config.outputs ?? [];
  const setConfig = (change: Partial<NonNullable<WorkflowStepView["subflow"]>>) =>
    onChange({ ...step, subflow: { ...config, ...change } });
  const choices = subflowChoices(flows, currentFlowId);
  const chosen = flows.find((flow) => flow.id === config.workflowId);
  const choice = choices.find((item) => item.id === config.workflowId);
  const offered = chosen ? variablesWrittenBy(chosen.steps).filter((name) => !outputs.includes(name)) : [];
  const listId = `subflow-vars-${step.id}`;

  return (
    <NodePanel
      kind="subflow"
      title="Sub-flujo"
      subtitle={step.id}
      description="Ejecuta otro flujo del proyecto como un paso de este. El hijo empieza con una copia de las variables de la corrida más sus entradas; al terminar solo vuelven las variables de «Salidas» (y la sesión, si inicia una). Sus pasos salen en el informe bajo este nodo, y el nodo pasa si pasan todos."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "subflow",
          label: "Flujo",
          content: (
            <>
              <Field label="Ejecuta el flujo" info={"Flujo del proyecto que se ejecuta en este punto. No se ofrecen los archivados ni los que ya ejecutan este (formarían un ciclo). Como mucho 3 niveles de sub-flujos."}>
                <select
                  className={inputClass}
                  value={config.workflowId}
                  disabled={!canEdit}
                  onChange={(event) => setConfig({ workflowId: event.target.value })}
                >
                  {!choice && <option value="">{config.workflowId ? "Un flujo que ya no existe" : "Elige un flujo"}</option>}
                  {choices.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={(item.archived || item.callsBack) && item.id !== config.workflowId}
                    >
                      {item.name}
                      {item.archived ? " (archivado)" : item.callsBack ? " (ya ejecuta este flujo)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <p
                className={cn(
                  "mt-2 text-[11px] leading-5",
                  choice && (choice.archived || choice.callsBack) ? "text-amber-700" : "text-slate-500",
                )}
              >
                {!config.workflowId
                  ? "Elige el flujo que se ejecutará en este punto."
                  : !choice
                    ? "Ese flujo ya no está en el proyecto: elige otro."
                    : choice.archived
                      ? "Ese flujo está archivado: no se puede ejecutar como sub-flujo."
                      : choice.callsBack
                        ? "Ese flujo ya ejecuta este: juntos formarían un ciclo."
                        : `${choice.steps} ${choice.steps === 1 ? "paso" : "pasos"}. Como mucho 3 niveles de sub-flujos, y no dentro de un bucle.`}
              </p>
            </>
          ),
        },
        {
          id: "inputs",
          label: "Entradas",
          count: inputs.length,
          content: (
            <>
              <p className="mb-2 text-[11px] leading-5 text-slate-500">
                Variables que el hijo recibe, además de las de la corrida. El valor es una plantilla sobre las de este flujo:{" "}
                <span className="font-mono">{"{{thingId}}"}</span>.
              </p>
              <datalist id={listId}>
                {variables.map((name) => (
                  <option key={name} value={`{{${name}}}`} />
                ))}
              </datalist>
              <div className="space-y-2">
                {inputs.map((input, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1.6fr)_1.5rem] items-center gap-1.5">
                    <input
                      aria-label="Variable del hijo"
                      className={cn(inputClass, "mt-0 font-mono text-[11px]")}
                      value={input.variable}
                      placeholder="entityName"
                      disabled={!canEdit}
                      onChange={(event) =>
                        setConfig({
                          inputs: inputs.map((item, position) =>
                            position === index ? { ...item, variable: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    <span className="text-center text-xs text-slate-400">=</span>
                    <input
                      aria-label="Valor"
                      className={cn(inputClass, "mt-0 font-mono text-[11px]")}
                      value={input.value}
                      placeholder="{{nombre}}"
                      list={listId}
                      disabled={!canEdit}
                      onChange={(event) =>
                        setConfig({
                          inputs: inputs.map((item, position) =>
                            position === index ? { ...item, value: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    {canEdit && (
                      <button
                        className="text-[11px] text-rose-600"
                        aria-label="Quitar entrada"
                        onClick={() => setConfig({ inputs: inputs.filter((_item, position) => position !== index) })}
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
                  onClick={() => setConfig({ inputs: [...inputs, { variable: "", value: "" }] })}
                >
                  + Entrada
                </Button>
              )}
            </>
          ),
        },
        {
          id: "outputs",
          label: "Salidas",
          count: outputs.length,
          content: (
            <>
              <p className="mb-2 text-[11px] leading-5 text-slate-500">
                Variables del hijo que vuelven a este flujo al terminar, también como{" "}
                <span className="font-mono">{`${step.id}.nombre`}</span>. Las demás se quedan en el hijo. Si una no aparece, el nodo falla.
              </p>
              <div className="space-y-2">
                {outputs.map((name, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1.5">
                    <input
                      aria-label="Variable devuelta"
                      className={cn(inputClass, "mt-0 font-mono text-[11px]")}
                      value={name}
                      placeholder="thingId"
                      disabled={!canEdit}
                      onChange={(event) =>
                        setConfig({
                          outputs: outputs.map((item, position) => (position === index ? event.target.value : item)),
                        })
                      }
                    />
                    {canEdit && (
                      <button
                        className="text-[11px] text-rose-600"
                        aria-label="Quitar salida"
                        onClick={() => setConfig({ outputs: outputs.filter((_item, position) => position !== index) })}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {canEdit && (
                <Button variant="ghost" className="mt-2 h-8 text-xs" onClick={() => setConfig({ outputs: [...outputs, ""] })}>
                  + Salida
                </Button>
              )}
              {canEdit && offered.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-500">El hijo escribe:</span>
                  {offered.map((name) => (
                    <button
                      key={name}
                      className="rounded-full bg-indigo-50 px-2 py-0.5 font-mono text-[10px] text-indigo-700 ring-1 ring-indigo-200"
                      onClick={() => setConfig({ outputs: [...outputs, name] })}
                    >
                      + {name}
                    </button>
                  ))}
                </div>
              )}
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />,
        },
      ]}
    />
  );
}

/** A retry node: the step it watches, where the flow is walked again from, how many times, how far apart. */
function RetryInspector({
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
  const rerun = step.rerun ?? { from: "", target: "", attempts: 3, delayMs: 1000 };
  const setRerun = (change: Partial<typeof rerun>) => onChange({ ...step, rerun: { ...rerun, ...change } });
  // Where it can start again: the watched step itself or any node before it.
  const targets = rerun.from ? steps.map((other) => other.id).filter((id) => rerunPathIds(steps, id, rerun.from) !== null) : [];
  const path = rerun.from && rerun.target ? rerunPathIds(steps, rerun.target, rerun.from) : null;

  return (
    <NodePanel
      kind="retry"
      title="Reintento"
      subtitle={step.id}
      description="Vigila el paso conectado a su entrada. Si pasa, no hace nada. Si falla, vuelve a ejecutar el flujo desde el nodo al que apunta «reintentar» hasta ese paso, las veces indicadas. En cuanto el paso pase, el flujo sigue desde él; si se agotan los intentos, sigue por «si se agota»."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Reintento",
          content: (
            <>
              <div className="grid gap-3 @3xl:grid-cols-2">
                <Field label="Vigila el paso" info={"El paso conectado a la entrada de este nodo. Cuando falla, empieza el reintento. Cambia la conexión en el lienzo para vigilar otro."}>
                  {rerun.from ? (
                    <p className="py-1.5 font-mono text-xs text-slate-700">{rerun.from}</p>
                  ) : (
                    <p className="py-1.5 text-[11px] text-amber-700">Conecta a su entrada el paso que puede fallar.</p>
                  )}
                </Field>
                <Field label="Repite desde" info={"El nodo desde el que se vuelve a ejecutar el flujo: el mismo paso, o uno anterior (por ejemplo, el que crea lo que el paso lee). También se elige arrastrando la salida «reintentar» a ese nodo."}>
                  <select
                    className={inputClass}
                    value={rerun.target}
                    disabled={!canEdit || targets.length === 0}
                    onChange={(event) => setRerun({ target: event.target.value })}
                  >
                    {!targets.includes(rerun.target) && <option value="">Elige un nodo</option>}
                    {targets.map((id) => (
                      <option key={id} value={id}>
                        {id === rerun.from ? `${id} (el mismo paso)` : id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reintentos (máx.)" info={"Cuántas veces, como mucho, se vuelve a ejecutar el tramo después del primer fallo (1–10)."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={10}
                    value={rerun.attempts}
                    disabled={!canEdit}
                    onChange={(event) => setRerun({ attempts: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })}
                  />
                </Field>
                <Field label="Espera antes de cada uno (ms)" info={"Pausa antes de cada reintento (0–60 000 ms)."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={60000}
                    step={500}
                    value={rerun.delayMs}
                    disabled={!canEdit}
                    onChange={(event) => setRerun({ delayMs: Math.min(60000, Math.max(0, Number(event.target.value) || 0)) })}
                  />
                </Field>
              </div>
              {path && (
                <p className="mt-3 text-[11px] leading-5 text-slate-600">
                  Cada reintento ejecuta: <span className="font-mono">{path.join(" → ")}</span>
                </p>
              )}
              <p className="mt-2 text-[11px] leading-5 text-amber-700">
                Si en ese tramo hay peticiones que escriben (POST, DELETE…), vuelven a escribir en cada reintento.
              </p>
            </>
          ),
        },
      ]}
    />
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
    <NodePanel
      kind="poll"
      title="Sondeo"
      subtitle={step.id}
      description="Repite la petición de un paso hasta que su respuesta cumpla las comprobaciones: el trabajo que responde «pendiente» hasta que termina. Primero juzga la respuesta que ese paso ya obtuvo; si ya cumple, no reenvía nada. Lo que cuelgue de este nodo lee la última respuesta."
      canEdit={canEdit}
      onRemove={onRemove}
      tabs={[
        {
          id: "main",
          label: "Sondeo",
          content: (
            <>
              <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_9rem_9rem]">
                {sources.length === 0 ? (
                  <p className="text-[11px] text-amber-700 @3xl:self-center">
                    Conéctalo a una petición o un fetch (sin bucle ni login) que repetir.
                  </p>
                ) : (
                  <Field label="Repite el paso" info={"Petición o fetch conectado a la entrada cuya llamada se reenvía. Tiene que haber PASADO: si falla, el Sondeo queda saltado. Para repetir un paso que falla, usa el nodo Reintento."}>
                    <select
                      className={inputClass}
                      value={poll.from}
                      disabled={!canEdit}
                      onChange={(event) => setPoll({ from: event.target.value })}
                    >
                      {!sources.includes(poll.from) && <option value="">Elige un paso</option>}
                      {sources.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Reenvíos (máx.)" info={"Cuántas veces, como mucho, se vuelve a enviar (1–20) después de juzgar la primera respuesta. Si ninguna cumple las comprobaciones, el nodo falla."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={20}
                    value={poll.attempts}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setPoll({ attempts: Math.min(20, Math.max(1, Number(event.target.value) || 1)) })
                    }
                  />
                </Field>
                <Field label="Cada (ms)" info={"Espera antes de cada reenvío (0–60 000 ms)."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={60000}
                    step={500}
                    value={poll.delayMs}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setPoll({ delayMs: Math.min(60000, Math.max(0, Number(event.target.value) || 0)) })
                    }
                  />
                </Field>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-amber-700">
                Si la petición escribe, cada reenvío vuelve a escribir.
              </p>
            </>
          ),
        },
        {
          id: "checks",
          label: "Comprobaciones",
          count: step.checks?.length,
          content: <ChecksEditor step={step} canEdit={canEdit} onChange={onChange} />,
        },
        {
          id: "captures",
          label: "Capturas",
          count: step.captures?.length,
          content: (
            <>
              <p className="text-xs font-semibold text-slate-800">Capturas de la última respuesta</p>
              <CapturesEditor step={step} canEdit={canEdit} onChange={onChange} />
            </>
          ),
        },
        {
          id: "failure",
          label: "Si falla",
          marked: failureSet(step),
          content: <FailureEditor step={step} canEdit={canEdit} retries={false} onChange={onChange} />,
        },
      ]}
    />
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
  const patch = (index: number, change: Partial<WorkflowCaptureView>) =>
    editCaptures(captures.map((item, position) => (position === index ? { ...item, ...change } : item)));
  const row =
    "grid grid-cols-[6.5rem_minmax(0,1fr)_1.5rem] items-center gap-2 @3xl:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1.5fr)_1.5rem]";

  return (
    <div>
      <p className="text-[11px] leading-5 text-slate-500">
        Extrae valores de esta respuesta para los pasos siguientes. Del cuerpo, con una ruta como{" "}
        <span className="font-mono">data.id</span>; de una cabecera o una cookie, con su nombre; y si la respuesta no
        tiene forma que recorrer, con una expresión regular sobre el texto —su grupo, si lo lleva—.
      </p>
      {captures.length > 0 && (
        <div
          className={cn(row, "mt-3 hidden text-[10px] font-medium tracking-wide text-slate-400 uppercase @3xl:grid")}
        >
          <span className="flex items-center">Variable<InfoTip label={"Qué es «Variable»"}>{"Nombre con el que los pasos siguientes usan el valor: userId se usa como {{userId}}."}</InfoTip></span>
          <span className="flex items-center">Origen<InfoTip label={"Qué es «Origen»"}>{"• body: el JSON, con una ruta (data.id).\n• header: una cabecera, por nombre.\n• cookie: una cookie de la respuesta, por nombre.\n• regex: expresión regular sobre el texto; se toma su grupo si lo lleva."}</InfoTip></span>
          <span className="flex items-center">Ruta<InfoTip label={"Qué es «Ruta»"}>{"Depende del origen: ruta con puntos en el body (data.items.0.id), nombre de la cabecera o la cookie, o la expresión regular."}</InfoTip></span>
        </div>
      )}
      <div className="mt-2 space-y-2">
        {captures.map((capture, index) => (
          <div key={index} className={cn(row, "rounded-lg border border-slate-200 p-2 @3xl:border-0 @3xl:p-0")}>
            <input
              aria-label="Variable capturada"
              className={cn(inputClass, "col-span-3 mt-0 @3xl:col-span-1")}
              value={capture.variable}
              placeholder="userId"
              disabled={!canEdit}
              onChange={(event) => patch(index, { variable: event.target.value })}
            />
            <select
              aria-label="Origen de la captura"
              className={cn(inputClass, "mt-0")}
              value={capture.from}
              disabled={!canEdit}
              onChange={(event) => patch(index, { from: event.target.value as CaptureSource })}
            >
              {CAPTURE_SOURCES.map((source) => (
                <option key={source.value} value={source.value}>
                  {source.value}
                </option>
              ))}
            </select>
            <input
              aria-label="Ruta de captura"
              className={cn(inputClass, "mt-0 font-mono text-xs")}
              value={capture.path}
              // El ejemplo cambia con la ruta elegida: `data.id` al lado de un selector que dice
              // «cookie» es una pista que estorba más de lo que ayuda.
              placeholder={CAPTURE_SOURCES.find((source) => source.value === capture.from)?.hint}
              disabled={!canEdit}
              onChange={(event) => patch(index, { path: event.target.value })}
            />
            {canEdit ? (
              <button
                className="text-[11px] text-rose-600"
                aria-label="Eliminar captura"
                title="Eliminar captura"
                onClick={() => editCaptures(captures.filter((_item, position) => position !== index))}
              >
                ✕
              </button>
            ) : (
              <span />
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
      {canEdit && (
        <CaptureSuggestions
          sampleBody={sampleBody}
          existing={captures}
          onAdd={(capture) => editCaptures([...captures, capture])}
        />
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
  info,
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
  info?: ReactNode;
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
      info={info}
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
  // One line per check when there is room: source, path, operator, value, then its flags.
  const row =
    "grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 @3xl:grid-cols-[6.5rem_minmax(0,1.3fr)_9rem_minmax(0,1fr)_auto]";

  return (
    <div>
      <p className="text-[11px] leading-5 text-slate-500">
        Lo que el contrato no dice: que la lista trae algo, que el total cuadra, que responde a tiempo. Un{" "}
        <span className="font-medium">aviso</span> queda escrito y no pone el caso en rojo.
      </p>
      {checks.length > 0 && (
        <div
          className={cn(row, "mt-3 hidden text-[10px] font-medium tracking-wide text-slate-400 uppercase @3xl:grid")}
        >
          <span className="flex items-center">Origen<InfoTip label={"Qué es «Origen»"}>{"Qué parte de la respuesta se lee:\n• status: el código HTTP (200, 404…).\n• body: el JSON de la respuesta, con una ruta.\n• header: una cabecera, por su nombre.\n• durationMs: lo que tardó, en milisegundos."}</InfoTip></span>
          <span className="flex items-center">Ruta o cabecera<InfoTip label={"Qué es «Ruta o cabecera»"}>{"Solo para body y header.\n• body: ruta con puntos, p. ej. data.id o data.items.0.name (los índices de lista son números). Vacía lee el body entero.\n• header: el nombre de la cabecera, p. ej. X-Total-Count.\nCon status y durationMs no se usa."}</InfoTip></span>
          <span className="flex items-center">Operador<InfoTip label={"Qué es «Operador»"}>{"• equals / not_equals: igual o distinto. Compara como texto (200 y «200» son lo mismo); objetos y listas, completos.\n• contains / not_contains: en una lista, que tenga ese elemento; en un texto, que lo incluya.\n• greater_than / less_than: comparación numérica.\n• exists / not_exists: que el valor esté (ni ausente ni null).\n• matches: expresión regular sobre el texto.\n• is_array: que sea una lista.\n• is_not_empty: lista, texto u objeto con al menos un elemento.\n• has_length: tamaño exacto (elementos, caracteres o claves)."}</InfoTip></span>
          <span className="flex items-center">Valor esperado<InfoTip label={"Qué es «Valor esperado»"}>{"Lo que se espera, como texto o número (con matches, una expresión regular). No aparece con los operadores que no comparan: exists, not_exists, is_array, is_not_empty."}</InfoTip></span>
        </div>
      )}
      <div className="mt-2 space-y-2">
        {checks.map((check, index) => (
          <div key={index} className={cn(row, "rounded-lg border border-slate-200 p-2 @3xl:border-0 @3xl:p-0")}>
            <select
              aria-label="Origen"
              className={cn(inputClass, "mt-0")}
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
              className={cn(inputClass, "mt-0 font-mono text-xs")}
              value={check.path ?? ""}
              placeholder={check.source === "header" ? "X-Total-Count" : "data.0.id"}
              disabled={!canEdit || check.source === "status" || check.source === "durationMs"}
              onChange={(event) => patch(index, { path: event.target.value })}
            />
            <select
              aria-label="Operador"
              className={cn(inputClass, "mt-0")}
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
            {WITHOUT_OPERAND.includes(check.operator) ? (
              <span className="text-[11px] text-slate-400">—</span>
            ) : (
              <input
                aria-label="Valor esperado"
                className={cn(inputClass, "mt-0")}
                value={check.value === undefined ? "" : String(check.value)}
                placeholder="200"
                disabled={!canEdit}
                onChange={(event) => patch(index, { value: event.target.value })}
              />
            )}
            <div className="col-span-2 flex items-center justify-between gap-3 @3xl:col-span-1">
              <label className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-slate-600">
                <input
                  type="checkbox"
                  checked={check.severity === "warning"}
                  disabled={!canEdit}
                  onChange={(event) => patch(index, { severity: event.target.checked ? "warning" : undefined })}
                />
                Solo aviso
                <InfoTip label={"Qué es «Solo aviso»"}>{"Si esta comprobación falla, queda escrita como aviso y no pone el caso en rojo."}</InfoTip>
              </label>
              {canEdit && (
                <button
                  className="text-[11px] text-rose-600"
                  aria-label="Eliminar comprobación"
                  title="Eliminar comprobación"
                  onClick={() => edit(checks.filter((_item, position) => position !== index))}
                >
                  ✕
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
    <div className="grid gap-x-6 gap-y-4 @3xl:grid-cols-2">
      <div>
        <Field label="Si este paso falla" info={"• Saltar lo que dependa (por defecto): los pasos conectados después quedan saltados.\n• Continuar igual: el paso queda en rojo, pero los siguientes se ejecutan.\n• Detener el flujo: no se ejecuta nada más."}>
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
      </div>

      {retries && (
        <div className="border-t border-slate-100 pt-3 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-6">
          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={Boolean(retry)}
              disabled={!canEdit}
              onChange={(event) =>
                onChange({
                  ...step,
                  retry: event.target.checked ? { attempts: 2, delayMs: 500, backoff: 2 } : undefined,
                })
              }
            />
            Reintentar
            <InfoTip label={"Qué es «Reintentar»"}>{"Repite ESTE paso cuando falla, con espera creciente: es la opción para «si falla, reinténtalo». Para fallos pasajeros (arranque en frío, 502/503, datos que tardan en propagarse). Acota con «Solo estos estados» para no tapar errores reales."}</InfoTip>
          </label>
          {retry && (
            <>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Field label="Intentos" info={"Intentos extra tras el primero (0–5): 2 significa hasta 3 peticiones. Se reintenta cuando el paso falla (estado, esquema o comprobaciones). Si al final pasa, queda un aviso en el informe."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={5}
                    value={retry.attempts}
                    disabled={!canEdit}
                    onChange={(event) =>
                      onChange({ ...step, retry: { ...retry, attempts: Number(event.target.value) } })
                    }
                  />
                </Field>
                <Field label="Espera (ms)" info={"Espera antes del primer reintento (0–30 000 ms)."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={30000}
                    value={retry.delayMs}
                    disabled={!canEdit}
                    onChange={(event) =>
                      onChange({ ...step, retry: { ...retry, delayMs: Number(event.target.value) } })
                    }
                  />
                </Field>
                <Field label="Factor" info={"Multiplica la espera tras cada intento: con 500 ms y factor 2 espera 500, 1000, 2000… Con 1 la espera es constante."}>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={10}
                    step={0.5}
                    value={retry.backoff ?? 1}
                    disabled={!canEdit}
                    onChange={(event) =>
                      onChange({ ...step, retry: { ...retry, backoff: Number(event.target.value) } })
                    }
                  />
                </Field>
              </div>
              <Field label="Solo estos estados" info={"Códigos HTTP que justifican reintentar, separados por comas: 502, 503, 504. Si llega otro código, no se reintenta. Vacío reintenta cualquier fallo. Un paso que escribe (POST…) sin acotar escribe una vez por intento."} hint="Vacío reintenta cualquier fallo.">
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
    <div>
      <div className="grid gap-3 @3xl:grid-cols-2">
        {/* Solo con varias dependencias: con una, «todas» y «cualquiera» son la misma frase, y un
          desplegable que no decide nada es una pregunta que alguien tiene que leer igual. */}
        {sources.length > 1 && (
          <Field label="Empieza cuando" info={"Con varios pasos conectados a la entrada:\n• han terminado todos: espera a todos.\n• ha terminado cualquiera: arranca con el primero que llegue."} hint="«Cualquiera» arranca con el primero que llegue, sin esperar al resto.">
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
          label="Esperar antes (ms)" info={"Pausa antes de enviar este paso (0–60 000 ms), para la API que acepta una escritura y tarda en poder leerla. No reintenta nada."}
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
      </div>

      {sources.length === 0 ? (
        <p className="mt-4 text-[11px] text-slate-400">
          Conecta este paso a otro para poder condicionarlo o recorrer su lista.
        </p>
      ) : (
        <div className="mt-4 grid gap-x-6 gap-y-4 border-t border-slate-100 pt-3 @3xl:grid-cols-2">
          <div>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
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
              <InfoTip label={"Qué es «Solo si…»"}>{"Ejecuta este paso solo si la respuesta de un paso anterior cumple la condición: paso, origen, ruta, operador y valor. Si no se cumple, queda saltado, no en rojo."}</InfoTip>
            </label>
            {condition && (
              <div className="mt-2 rounded-lg border border-slate-200 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Del paso" info={"Paso cuya respuesta decide si este se ejecuta. Solo aparecen los conectados a la entrada."}>
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
                  <Field label="Origen" info={"Qué parte de la respuesta se lee:\n• status: el código HTTP (200, 404…).\n• body: el JSON de la respuesta, con una ruta.\n• header: una cabecera, por su nombre.\n• durationMs: lo que tardó, en milisegundos."}>
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
                    disabled={
                      !canEdit || condition.check.source === "status" || condition.check.source === "durationMs"
                    }
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
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700">
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
              <InfoTip label={"Qué es «Una vez por elemento de…»"}>{"Envía este paso una vez por cada elemento de una lista de otra respuesta. Para repetir varios pasos por elemento, usa el nodo Bucle."}</InfoTip>
            </label>
            {loop && (
              <div className="mt-2 rounded-lg border border-slate-200 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Lista del paso" info={"Paso cuya respuesta trae la lista. Este paso se envía una vez por elemento, cada uno como su propio caso."}>
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
                  <Field label="Ruta" info={"Ruta con puntos a la lista dentro del body del paso elegido: data o data.items. Tiene que ser un array."}>
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
                  <Field label="Se llama" info={"Nombre de la variable con el elemento actual: {{item}} entero o {{item.id}} campo a campo."} hint="Un objeto también se ata campo a campo: item.id.">
                    <input
                      className={`${inputClass} font-mono text-xs`}
                      value={loop.as}
                      disabled={!canEdit}
                      onChange={(event) => onChange({ ...step, forEach: { ...loop, as: event.target.value } })}
                    />
                  </Field>
                  <Field label="Como mucho" info={"Tope de elementos (1–200): la longitud de la lista la decide la API, así que el tope evita corridas sin fin."}>
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
          </div>
        </div>
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
    <div>
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
        <InfoTip label={"Qué es «Este paso inicia sesión»"}>{"Convierte el paso en login: al pasar, toma el token de su respuesta y los pasos siguientes con Auth default lo presentan en lugar de la credencial del entorno."}</InfoTip>
      </label>
      {auth && (
        <div className="mt-2 rounded-lg border border-slate-200 p-2">
          <p className="flex items-center text-xs font-medium text-slate-600">
            Token
            <InfoTip label={"Qué es «Token»"}>{"De dónde sale el token en la respuesta del login: body con una ruta (data.token), header o cookie por nombre, o una expresión regular sobre el texto."}</InfoTip>
          </p>
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
            <Field label="Cabecera" info={"Cabecera en la que los pasos siguientes envían el token, normalmente Authorization."}>
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
            <Field label="Prefijo" info={"Texto delante del token: «Bearer » (con el espacio) por defecto. Vacío envía el token tal cual."} hint="Vacío envía el token tal cual.">
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
