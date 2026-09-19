/**
 * What the subflow node's inspector offers: which flows it may run, and what they can hand back.
 *
 * Beside `workflow-draft.ts` rather than in it because neither is a graph invariant of the open
 * flow — both read the project's other flows, which only the workflows page holds. The server is
 * still the rule (cycles through several flows, depth, another project); this is so the selector
 * does not offer what it would refuse on the first hop.
 */
import type { WorkflowStepView, WorkflowView } from "@/lib/types";

export type SubflowChoice = {
  id: string;
  name: string;
  steps: number;
  /** Retired flows are not run as subflows; shown disabled so an existing pick still reads. */
  archived: boolean;
  /** It already runs the open flow, so picking it closes a cycle. */
  callsBack: boolean;
};

/** Every other flow of the project, as the selector lists it. The open flow is left out: a subflow
 * cannot run the flow that contains it. */
export function subflowChoices(
  flows: Pick<WorkflowView, "id" | "name" | "status" | "steps">[],
  currentFlowId: string,
): SubflowChoice[] {
  return flows
    .filter((flow) => flow.id !== currentFlowId)
    .map((flow) => ({
      id: flow.id,
      name: flow.name,
      steps: flow.steps.length,
      archived: flow.status === "archived",
      callsBack: flow.steps.some((step) => step.kind === "subflow" && step.subflow?.workflowId === currentFlowId),
    }));
}

/**
 * The variables a flow writes into its run — its captures, its set nodes and what its own subflows
 * hand back — as the names a subflow node may ask for as outputs. A script's writes are not
 * knowable without running it, so they are typed by hand.
 */
export function variablesWrittenBy(steps: WorkflowStepView[]): string[] {
  return [
    ...new Set(
      steps.flatMap((step) => [
        ...(step.captures ?? []).map((capture) => capture.variable),
        ...(step.set?.assignments ?? []).map((assignment) => assignment.variable),
        ...(step.subflow?.outputs ?? []),
      ]),
    ),
  ].filter(Boolean);
}

type FlowLike = Pick<WorkflowView, "id" | "name" | "status" | "steps">;

/** The flows one flow runs through its subflow nodes, in node order, each once. A subflow node that
 * names a flow no longer in the project is kept as a dangling id so the list can say so. */
export function subflowsOf(flow: Pick<WorkflowView, "steps">): string[] {
  return [
    ...new Set(
      flow.steps
        .filter((step) => step.kind === "subflow" && step.subflow?.workflowId)
        .map((step) => step.subflow!.workflowId),
    ),
  ];
}

/** How the project's flows are wired: who each one runs, who runs it, and which suites hold it. */
export type FlowConnections = {
  calls: string[];
  calledBy: string[];
  suites: string[];
};

export function flowConnections(
  flows: FlowLike[],
  suites: { id: string; workflowIds: string[] }[] = [],
): Record<string, FlowConnections> {
  const result: Record<string, FlowConnections> = {};
  for (const flow of flows) result[flow.id] = { calls: subflowsOf(flow), calledBy: [], suites: [] };
  for (const flow of flows) {
    for (const child of result[flow.id].calls) result[child]?.calledBy.push(flow.id);
  }
  for (const suite of suites) {
    for (const id of new Set(suite.workflowIds)) result[id]?.suites.push(suite.id);
  }
  return result;
}

/** One branch of the tree the list draws under a flow: the subflow, and what it runs in turn. */
export type SubflowTreeNode = {
  id: string;
  /** Null when the node names a flow that is not in the project any more. */
  flow: FlowLike | null;
  /** It is already an ancestor on this branch: drawn, but not opened again. */
  cycle: boolean;
  children: SubflowTreeNode[];
};

/**
 * The subflows a flow runs, and theirs, as a tree. Guarded against cycles (the server refuses them,
 * but a flow saved before that rule, or imported, may still close one) and cut at `maxDepth` — the
 * runner stops at three levels, so deeper than that is never walked anyway.
 */
export function subflowTree(flows: FlowLike[], rootId: string, maxDepth = 3): SubflowTreeNode[] {
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const walk = (flowId: string, ancestors: Set<string>, depth: number): SubflowTreeNode[] => {
    const flow = byId.get(flowId);
    if (!flow || depth >= maxDepth) return [];
    return subflowsOf(flow).map((childId) => {
      const child = byId.get(childId) ?? null;
      const cycle = ancestors.has(childId);
      return {
        id: childId,
        flow: child,
        cycle,
        children: cycle || !child ? [] : walk(childId, new Set([...ancestors, childId]), depth + 1),
      };
    });
  };
  return walk(rootId, new Set([rootId]), 0);
}
