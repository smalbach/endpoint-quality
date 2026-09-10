import { useEffect, useMemo, useState } from "react";
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
import { cn, methodStyle } from "@/lib/format";
import { applyPositions, connectStep, disconnectEdges, toEdges, toNodes } from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import type { RequestTemplateView, WorkflowStepView } from "@/lib/types";

type StepNodeData = {
  name: string;
  method: string;
  path: string;
  expectedStatus: number;
  captures: number;
  checks: number;
};

function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  return (
    <div
      className={cn(
        "w-64 rounded-xl border bg-white p-3 shadow-sm",
        selected ? "border-slate-900 ring-2 ring-slate-200" : "border-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Badge className={cn("w-14 justify-center", methodStyle(data.method))}>{data.method}</Badge>
        <span className="truncate text-xs font-semibold text-slate-800">{data.name}</span>
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
}: {
  steps: WorkflowStepView[];
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  onChange: (steps: WorkflowStepView[]) => void;
  onSelect: (stepId: string) => void;
}) {
  const fromDocument = useMemo(
    () => toNodes(steps, templates, operations) as Node<StepNodeData>[],
    [steps, templates, operations],
  );
  const [nodes, setNodes] = useState<Node<StepNodeData>[]>(fromDocument);

  // The document decides which nodes exist and what they say; the canvas keeps where each one is
  // and what it measured. A node that is still here keeps both.
  useEffect(() => {
    setNodes((current) => {
      const seen = new Map(current.map((node) => [node.id, node]));
      return fromDocument.map((node) => {
        const previous = seen.get(node.id);
        return previous ? { ...previous, data: node.data } : node;
      });
    });
  }, [fromDocument]);

  const edges: Edge[] = toEdges(steps);

  return (
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
    >
      <Background gap={20} size={1} />
      <MiniMap pannable zoomable />
      <Controls />
    </ReactFlow>
  );
}
