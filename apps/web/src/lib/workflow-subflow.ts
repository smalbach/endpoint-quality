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
export function subflowChoices(flows: Pick<WorkflowView, "id" | "name" | "status" | "steps">[], currentFlowId: string): SubflowChoice[] {
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
