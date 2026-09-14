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

/**
 * The node «types», as this editor means them.
 *
 * The reference tool draws Auth, Condition, Loop, Merge and Delay as separate draggable shapes.
 * Here every node is a request — a node with no HTTP would be a case with no request, a row in the
 * report that means something different from every other row — so these are not other kinds of
 * node: they are a request wearing a behaviour. The palette says which behaviours exist and marks
 * the glyph each one shows on the canvas; the behaviour itself is set from the node's menu, or in
 * the inspector where the ones that need a dependency (condition, loop, merge) belong.
 */
const PALETTE = [
  { glyph: "●", label: "Petición", hint: "Cada nodo es una petición reutilizable" },
  { glyph: "🔑", label: "Login", hint: "Su respuesta da la credencial de los pasos siguientes" },
  { glyph: "◇", label: "Condición", hint: "Se ejecuta solo si un paso anterior cumple algo" },
  { glyph: "↻", label: "Bucle", hint: "Una vez por elemento de una lista que devolvió otro paso" },
  { glyph: "⇉", label: "Merge", hint: "Con varias dependencias, basta con que llegue una" },
  { glyph: "⏱", label: "Espera", hint: "Pausa antes de enviar, para lo que tarda en verse" },
] as const;

const AUTH_DEFAULT = { from: "body", path: "token", header: "Authorization", scheme: "Bearer " } as const;

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
        {data.authorizes && <span title="Inicia sesión para los pasos siguientes">🔑</span>}
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
  runStatus,
}: {
  steps: WorkflowStepView[];
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  onChange: (steps: WorkflowStepView[]) => void;
  onSelect: (stepId: string) => void;
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2">
        <span className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Tipos de nodo</span>
        {PALETTE.map((item) => (
          <span key={item.label} className="flex items-center gap-1 text-[11px] text-slate-500" title={item.hint}>
            <span aria-hidden>{item.glyph}</span>
            {item.label}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-slate-400">Clic derecho en un nodo para su menú</span>
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
            {(menuStep.dependsOn?.length ?? 0) >= 2 && (
              <MenuItem onClick={() => put({ ...menuStep, waits: menuStep.waits === "any" ? "all" : "any" })}>
                {menuStep.waits === "any" ? "⇉ Esperar a todas" : "⇉ Basta con una (merge)"}
              </MenuItem>
            )}
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
