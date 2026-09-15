import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Badge } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { cn, methodStyle } from "@/lib/format";
import {
  applyPositions,
  connectStep,
  disconnectEdges,
  duplicateStep,
  mergeNodes,
  predecessorFor,
  removeStep,
  replaceStep,
  toEdges,
  toNodes,
} from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import type { CaseStatus, RequestTemplateView, WorkflowStepView } from "@/lib/types";

const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  running: "Ejecutando",
  passed: "Correcto",
  failed: "Fallido",
  skipped: "No ejecutado",
  queued: "En cola",
};

const AUTH_DEFAULT = { from: "body", path: "token", header: "Authorization", scheme: "Bearer " } as const;

/** Turn a behaviour off by dropping its key, never by setting `undefined`: the step's fields are
 * truly optional and an explicit `undefined` is a different thing the compiler rejects. */
const withoutKey = (step: WorkflowStepView, key: keyof WorkflowStepView): WorkflowStepView => {
  const next = { ...step };
  delete next[key];
  return next;
};

/**
 * The behaviours a node can wear, as the toolbar offers them.
 *
 * The reference tool draws Auth, Condition, Loop, Merge and Delay as separate draggable shapes.
 * Here every node is a request — a node with no HTTP would be a case with no request, a row in the
 * report that means something different from every other row — so these are not other kinds of
 * node: they are a request wearing a behaviour. The toolbar applies one to the selected node with a
 * click (and shows it lit when it is on); the ones that read a previous step —condition, loop,
 * merge— light up only when the node hangs off another, which is where they have something to read.
 * The inspector is where each one's detail is tuned.
 */
type NodeBehaviour = {
  glyph: string;
  label: string;
  hint: string;
  active: (step: WorkflowStepView) => boolean;
  enabled: (step: WorkflowStepView, steps: WorkflowStepView[]) => boolean;
  disabledHint?: string;
  apply: (step: WorkflowStepView, steps: WorkflowStepView[]) => WorkflowStepView;
};

/** The step a condition or loop will read: one it already depends on, or —when it depends on
 * nothing yet— the predecessor we will wire it to so the read has something to land on. */
const readFrom = (step: WorkflowStepView, steps: WorkflowStepView[]): string | undefined =>
  step.dependsOn?.[0] ?? predecessorFor(steps, step.id);

const BEHAVIOURS: NodeBehaviour[] = [
  {
    glyph: "🔑",
    label: "Login",
    hint: "Su respuesta da la credencial de los pasos siguientes",
    active: (step) => Boolean(step.authorizes),
    enabled: () => true,
    apply: (step) => (step.authorizes ? withoutKey(step, "authorizes") : { ...step, authorizes: { ...AUTH_DEFAULT } }),
  },
  {
    glyph: "◇",
    label: "Condición",
    hint: "Se ejecuta solo si un paso anterior cumple algo",
    active: (step) => Boolean(step.runIf),
    // Reads a previous step, so it needs one to read: either the node already hangs off another, or
    // there is a node before it we can wire it to. Only a true root (nothing before it) is left out.
    enabled: (step, steps) => Boolean(readFrom(step, steps)),
    disabledHint: "No hay ningún nodo antes de este para condicionarlo",
    apply: (step, steps) => {
      if (step.runIf) return withoutKey(step, "runIf");
      const from = readFrom(step, steps);
      if (!from) return step;
      return {
        ...step,
        // Wire the dependency if it was not there, so the read is guaranteed to have run.
        dependsOn: step.dependsOn?.length ? step.dependsOn : [from],
        runIf: { from, check: { source: "status", operator: "equals", value: "200" } },
      };
    },
  },
  {
    glyph: "↻",
    label: "Bucle",
    hint: "Una vez por elemento de una lista que devolvió otro paso",
    active: (step) => Boolean(step.forEach),
    enabled: (step, steps) => Boolean(readFrom(step, steps)),
    disabledHint: "No hay ningún nodo antes de este cuya lista recorrer",
    apply: (step, steps) => {
      if (step.forEach) return withoutKey(step, "forEach");
      const from = readFrom(step, steps);
      if (!from) return step;
      return {
        ...step,
        dependsOn: step.dependsOn?.length ? step.dependsOn : [from],
        forEach: { from, path: "data", as: "item", max: 50 },
      };
    },
  },
  {
    glyph: "⇉",
    label: "Merge",
    hint: "Con varias dependencias, basta con que llegue una",
    active: (step) => step.waits === "any",
    enabled: (step) => (step.dependsOn?.length ?? 0) >= 2,
    disabledHint: "Necesita dos o más dependencias",
    apply: (step) => (step.waits === "any" ? withoutKey(step, "waits") : { ...step, waits: "any" }),
  },
  {
    glyph: "⏱",
    label: "Espera",
    hint: "Pausa antes de enviar, para lo que tarda en verse",
    active: (step) => Boolean(step.waitMs),
    enabled: () => true,
    apply: (step) => (step.waitMs ? withoutKey(step, "waitMs") : { ...step, waitMs: 1000 }),
  },
  {
    glyph: "✓",
    label: "Comprobación",
    hint: "Añade una aserción sobre la respuesta (status u otra)",
    active: (step) => (step.checks?.length ?? 0) > 0,
    enabled: () => true,
    apply: (step) => ({
      ...step,
      checks: [...(step.checks ?? []), { source: "status", operator: "equals", value: "200" }],
    }),
  },
  {
    glyph: "↺",
    label: "Reintento",
    hint: "Repite el paso cuando falla, con espera entre intentos",
    active: (step) => Boolean(step.retry),
    enabled: () => true,
    apply: (step) => (step.retry ? withoutKey(step, "retry") : { ...step, retry: { attempts: 2, delayMs: 500, backoff: 2 } }),
  },
];

type StepNodeData = {
  name: string;
  method: string;
  path: string;
  expectedStatus: number;
  captures: number;
  checks: number;
  loops: boolean;
  conditional: boolean;
  authorizes: boolean;
  waits: boolean;
  retries: boolean;
  merges: boolean;
  runStatus?: CaseStatus;
};

/** How a node looks for each live status: border and a soft wash so the eye lands on the one
 * running. Absent (no run being watched) leaves the node in its plain editor skin. */
const RUN_NODE_CLASS: Record<CaseStatus, string> = {
  running: "border-sky-400 bg-sky-50 ring-2 ring-sky-200",
  passed: "border-emerald-300 bg-emerald-50",
  failed: "border-rose-400 bg-rose-50 ring-2 ring-rose-200",
  skipped: "border-amber-300 bg-amber-50",
  queued: "border-slate-300 bg-white",
};
const RUN_DOT: Record<CaseStatus, string> = {
  running: "bg-sky-500 animate-pulse",
  passed: "bg-emerald-500",
  failed: "bg-rose-500",
  skipped: "bg-amber-400",
  queued: "bg-slate-300",
};

function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-64 rounded-xl border bg-white p-3 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-slate-200",
        // Selection still wins the outline, so clicking a node during a run keeps its ring.
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Badge className={cn("w-14 justify-center", methodStyle(data.method))}>{data.method}</Badge>
        <span className="truncate text-xs font-semibold text-slate-800">{data.name}</span>
        {/* Un paso que a veces no se ejecuta y uno que se ejecuta N veces no se leen igual que el
            resto, y el lienzo es donde se mira el flujo antes de abrir ningún panel. */}
        {data.conditional && <span title="Condicional">◇</span>}
        {data.loops && <span title="Una vez por elemento">↻</span>}
        {data.merges && <span title="Basta con que llegue una dependencia (merge)">⇉</span>}
        {data.authorizes && <span title="Inicia sesión para los pasos siguientes">🔑</span>}
        {data.waits && <span title="Espera antes de enviar">⏱</span>}
        {data.checks > 0 && <span title={`${data.checks} comprobaciones`}>✓</span>}
        {data.retries && <span title="Reintenta al fallar">↺</span>}
        {status && (
          <span className="ml-auto flex items-center gap-1 text-[9px] text-slate-500" title={CASE_STATUS_LABEL[status]}>
            <span className={cn("h-2 w-2 rounded-full", RUN_DOT[status])} />
          </span>
        )}
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-slate-500">{data.path}</p>
      <div className="mt-2 flex justify-between text-[10px] text-slate-400">
        <span>espera {data.expectedStatus}</span>
        <span>
          {data.captures} capturas{data.checks > 0 && ` · ${data.checks} comprob.`}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { step: StepNode };

/**
 * The graph. Everything it changes goes back into the document through `workflow-draft`, which is
 * where those rules are tested — this component only wires the canvas to them.
 *
 * React Flow keeps its **own** copy of the nodes, and that is not duplication: it stores what it
 * measured of each one, and a node it has not measured stays `visibility: hidden`. Rebuilding the
 * array from the document on every render threw that measurement away, which is why nothing was
 * visible. So the canvas owns the nodes, the document owns the steps, and each tells the other
 * only what it is authoritative about.
 */
export function WorkflowCanvas({
  steps,
  templates,
  operations,
  onChange,
  onSelect,
  onAddRequest,
  runStatus,
}: {
  steps: WorkflowStepView[];
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  onChange: (steps: WorkflowStepView[]) => void;
  onSelect: (stepId: string) => void;
  /** Open the request catalogue so a new node can be added. The toolbar's «Petición» calls it. */
  onAddRequest?: () => void;
  /** Per-step live status while a run is being watched; nodes light up by it. */
  runStatus?: Record<string, CaseStatus>;
}) {
  const fromDocument = useMemo(
    () => toNodes(steps, templates, operations, runStatus) as Node<StepNodeData>[],
    [steps, templates, operations, runStatus],
  );
  const [nodes, setNodes] = useState<Node<StepNodeData>[]>(fromDocument);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // The document decides which nodes exist, what they say and where they are; the canvas keeps
  // what it measured of each one. `mergeNodes` is where that division is written down and tested.
  useEffect(() => {
    setNodes((current) => mergeNodes(current, fromDocument));
  }, [fromDocument]);

  const edges: Edge[] = toEdges(steps);
  const menuStep = menu ? steps.find((step) => step.id === menu.id) : undefined;
  // The node the toolbar acts on: whichever one ReactFlow has selected. Selection lives in the
  // canvas node state (mergeNodes keeps it), so a click on a toolbar behaviour reads it from there.
  const selectedId = nodes.find((node) => node.selected)?.id;
  const selectedStep = selectedId ? steps.find((step) => step.id === selectedId) : undefined;

  /** Write one changed step back into the document and close the menu. */
  const put = (next: WorkflowStepView) => {
    onChange(replaceStep(steps, next));
    setMenu(null);
  };

  /** Turn a behaviour off by dropping its key, never by setting it to `undefined`: the step type's
   * fields are truly optional, and an explicit `undefined` is a different thing the compiler rejects. */
  const drop = (step: WorkflowStepView, key: keyof WorkflowStepView): WorkflowStepView => {
    const next = { ...step };
    delete next[key];
    return next;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2">
        {onAddRequest && (
          <>
            <button
              onClick={onAddRequest}
              title="Añadir una petición al flujo"
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
            >
              <span aria-hidden>＋</span> Petición
            </button>
            <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden />
          </>
        )}
        {BEHAVIOURS.map((behaviour) => {
          const on = selectedStep ? behaviour.active(selectedStep) : false;
          const can = Boolean(selectedStep) && behaviour.enabled(selectedStep!, steps);
          return (
            <button
              key={behaviour.label}
              disabled={!can}
              title={
                !selectedStep
                  ? "Selecciona un nodo para aplicarlo"
                  : !can
                    ? (behaviour.disabledHint ?? behaviour.hint)
                    : behaviour.hint
              }
              onClick={() => selectedStep && onChange(replaceStep(steps, behaviour.apply(selectedStep, steps)))}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors",
                on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100",
                !can && "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
            >
              <span aria-hidden>{behaviour.glyph}</span>
              {behaviour.label}
            </button>
          );
        })}
        <span className="ml-auto text-[10px] text-slate-400">
          {selectedStep ? "Se aplica al nodo seleccionado" : "Elige un nodo · clic derecho para su menú"}
        </span>
      </div>
      <div className="relative flex-1" onClick={() => setMenu(null)}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          deleteKeyCode={["Backspace", "Delete"]}
          onNodesChange={(changes) => {
            const next = applyNodeChanges(changes, nodes);
            setNodes(next);
            // Written to the document when the drag ends, not on every frame: a step per mouse move
            // would mark the flow dirty sixty times a second and save a position nobody chose yet.
            if (changes.some((change) => change.type === "position" && !change.dragging)) {
              onChange(
                applyPositions(
                  steps,
                  next.map((node) => ({ id: node.id, position: node.position })),
                ),
              );
            }
          }}
          onConnect={(connection: Connection) => onChange(connectStep(steps, connection.source, connection.target))}
          onEdgesDelete={(deleted) =>
            onChange(
              disconnectEdges(
                steps,
                deleted.map((edge) => ({ source: edge.source, target: edge.target })),
              ),
            )
          }
          onNodeClick={(_event, node) => onSelect(node.id)}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            onSelect(node.id);
            setMenu({ id: node.id, x: event.clientX, y: event.clientY });
          }}
          onPaneClick={() => setMenu(null)}
        >
          <Background gap={20} size={1} />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>

        {menu && menuStep && (
          <div
            className="fixed z-50 w-52 rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-lg"
            style={{ top: menu.y, left: menu.x }}
            onClick={(event) => event.stopPropagation()}
          >
            <MenuItem onClick={() => (onSelect(menu.id), setMenu(null))}>Editar…</MenuItem>
            <MenuItem
              onClick={() => {
                onChange(duplicateStep(steps, menu.id));
                setMenu(null);
              }}
            >
              Duplicar nodo
            </MenuItem>
            <div className="my-1 border-t border-slate-100" />
            <MenuItem
              onClick={() =>
                put(
                  menuStep.authorizes ? drop(menuStep, "authorizes") : { ...menuStep, authorizes: { ...AUTH_DEFAULT } },
                )
              }
            >
              {menuStep.authorizes ? "🔑 Quitar login" : "🔑 Marcar como login"}
            </MenuItem>
            <MenuItem onClick={() => put(menuStep.waitMs ? drop(menuStep, "waitMs") : { ...menuStep, waitMs: 1000 })}>
              {menuStep.waitMs ? "⏱ Quitar espera" : "⏱ Añadir espera"}
            </MenuItem>
            {/* Condición y bucle leen la respuesta de un paso anterior: sin dependencia no hay de
                dónde leer, así que solo se ofrecen cuando hay un nodo antes al que colgarse (y si no
                lo tiene aún, se conecta al pulsar). Solo un nodo raíz se queda sin ellas. */}
            {(menuStep.runIf || readFrom(menuStep, steps)) && (
              <MenuItem
                onClick={() => {
                  if (menuStep.runIf) return put(drop(menuStep, "runIf"));
                  const from = readFrom(menuStep, steps)!;
                  put({
                    ...menuStep,
                    dependsOn: menuStep.dependsOn?.length ? menuStep.dependsOn : [from],
                    runIf: { from, check: { source: "status", operator: "equals", value: "200" } },
                  });
                }}
              >
                {menuStep.runIf ? "◇ Quitar condición" : "◇ Añadir condición"}
              </MenuItem>
            )}
            {(menuStep.forEach || readFrom(menuStep, steps)) && (
              <MenuItem
                onClick={() => {
                  if (menuStep.forEach) return put(drop(menuStep, "forEach"));
                  const from = readFrom(menuStep, steps)!;
                  put({
                    ...menuStep,
                    dependsOn: menuStep.dependsOn?.length ? menuStep.dependsOn : [from],
                    forEach: { from, path: "data", as: "item", max: 50 },
                  });
                }}
              >
                {menuStep.forEach ? "↻ Quitar bucle" : "↻ Recorrer una lista"}
              </MenuItem>
            )}
            {(menuStep.dependsOn?.length ?? 0) >= 2 && (
              <MenuItem onClick={() => put({ ...menuStep, waits: menuStep.waits === "any" ? "all" : "any" })}>
                {menuStep.waits === "any" ? "⇉ Esperar a todas" : "⇉ Basta con una (merge)"}
              </MenuItem>
            )}
            <div className="my-1 border-t border-slate-100" />
            <MenuItem
              onClick={() =>
                put({
                  ...menuStep,
                  checks: [...(menuStep.checks ?? []), { source: "status", operator: "equals", value: "200" }],
                })
              }
            >
              ✓ Añadir comprobación
            </MenuItem>
            <MenuItem
              onClick={() =>
                put(menuStep.retry ? drop(menuStep, "retry") : { ...menuStep, retry: { attempts: 2, delayMs: 500, backoff: 2 } })
              }
            >
              {menuStep.retry ? "↺ Quitar reintentos" : "↺ Reintentar al fallar"}
            </MenuItem>
            <div className="my-1 border-t border-slate-100" />
            <MenuItem
              danger
              onClick={() => {
                setConfirmId(menu.id);
                setMenu(null);
              }}
            >
              Eliminar nodo
            </MenuItem>
          </div>
        )}

        {confirmId && (
          <ConfirmDialog
            title="Eliminar nodo"
            message="Se quita del flujo junto con las conexiones que llegan a él. Esta acción no borra la petición reutilizable."
            confirmLabel="Eliminar"
            onClose={() => setConfirmId(null)}
            onConfirm={() => {
              onChange(removeStep(steps, confirmId));
              setConfirmId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={cn(
        "block w-full px-3 py-1.5 text-left hover:bg-slate-50",
        danger ? "text-rose-600 hover:bg-rose-50" : "text-slate-700",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
