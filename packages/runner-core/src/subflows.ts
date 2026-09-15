/**
 * What a `subflow` node may point at — the half of its integrity no zod schema can see.
 *
 * A document on its own can say «this node runs flow X»; whether X exists in the same project, is
 * not archived, does not come back round to the flow that runs it, and does not nest deeper than a
 * report can be read at, is a question about **other rows**. So it is a pure function over a lookup,
 * asked twice: by the command that saves a flow — the 422 names the node — and by the run that is
 * about to walk it, because the flows it names can be edited, archived or deleted after the save.
 */
import type { StepSubflow, WorkflowDocument, WorkflowStep } from "./workflows.ts";

/** Levels of subflows below the flow that is run. Three is already a report nobody reads top to
 * bottom; the ceiling exists so that one is the worst case and not the typical one. */
export const MAX_SUBFLOW_DEPTH = 3;

/** A flow as the check needs it. `status` is the row's: `archived` is refused. */
export type SubflowTarget = { id: string; name: string; status?: string; definition: WorkflowDocument };

/** One reason a subflow node cannot run, on the node of the **root** document it was reached through. */
export type SubflowProblem = { stepIndex: number; stepId: string; detail: string };

/** The subflow nodes of a document, with where they sit in it. */
export function subflowSteps(document: WorkflowDocument): { index: number; step: WorkflowStep & { subflow: StepSubflow } }[] {
  return document.steps.flatMap((step, index) =>
    step.kind === "subflow" && step.subflow ? [{ index, step: step as WorkflowStep & { subflow: StepSubflow } }] : [],
  );
}

/**
 * Every reason the subflows reachable from `root` cannot run, attributed to the root's node.
 *
 * `root.id` is absent for a flow that is being created: nothing can reference an id that does not
 * exist yet, so it cannot close a cycle. `lookup` is scoped to one project by whoever builds it,
 * which is what makes another tenant's flow indistinguishable from one that does not exist.
 *
 * The walk is bounded by the depth ceiling — it stops descending at the first level past it — so a
 * diamond of shared children costs at most branching³ lookups rather than following a cycle forever.
 */
export function subflowProblems(
  root: { id?: string; name?: string; definition: WorkflowDocument },
  lookup: (workflowId: string) => SubflowTarget | undefined,
): SubflowProblem[] {
  const problems: SubflowProblem[] = [];
  const rootName = root.name ? `«${root.name}»` : "este flujo";

  for (const { index, step } of subflowSteps(root.definition)) {
    const found = new Set<string>();
    const report = (detail: string) => {
      if (found.has(detail)) return;
      found.add(detail);
      problems.push({ stepIndex: index, stepId: step.id, detail });
    };

    const visit = (workflowId: string, chain: { id?: string; name: string }[], depth: number) => {
      const trail = (last: string) => [...chain.map((link) => link.name), last].join(" › ");
      if (chain.some((link) => link.id === workflowId)) {
        const again = chain.find((link) => link.id === workflowId)!;
        report(
          chain.length === 1
            ? "un sub-flujo no puede ejecutar el flujo que lo contiene"
            : `los sub-flujos forman un ciclo: ${trail(again.name)}`,
        );
        return;
      }
      const target = lookup(workflowId);
      if (!target) {
        report(`el flujo ${workflowId} no existe en este proyecto`);
        return;
      }
      const name = `«${target.name}»`;
      if (target.status === "archived") report(`el sub-flujo ${trail(name)} está archivado`);
      if (depth > MAX_SUBFLOW_DEPTH) {
        report(`${trail(name)} anida más de ${MAX_SUBFLOW_DEPTH} niveles de sub-flujos`);
        return;
      }
      for (const inner of subflowSteps(target.definition)) {
        visit(inner.step.subflow.workflowId, [...chain, { id: target.id, name }], depth + 1);
      }
    };

    visit(step.subflow.workflowId, [{ ...(root.id ? { id: root.id } : {}), name: rootName }], 1);
  }
  return problems;
}
