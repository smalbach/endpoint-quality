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
        <span>{data.captures} capturas</span>
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
 * `onNodesChange` is what makes the nodes draggable *and* what saves where they were dropped. Its
 * absence was the whole reason the layout could not be arranged: not that it was forgotten on
 * reload, but that nothing could be moved in the first place.
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
  const nodes = toNodes(steps, templates, operations) as Node<StepNodeData>[];
  const edges: Edge[] = toEdges(steps);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      deleteKeyCode={["Backspace", "Delete"]}
      onNodesChange={(changes) => {
        const moved = applyNodeChanges(changes, nodes)
          .filter((node) => node.position)
          .map((node) => ({ id: node.id, position: node.position }));
        onChange(applyPositions(steps, moved));
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
