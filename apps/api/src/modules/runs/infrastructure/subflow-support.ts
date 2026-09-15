/**
 * The pure half of running a `subflow` node: how its child's cases are named and counted.
 *
 * Kept beside the orchestrator and out of it because none of this needs the walk — it is arithmetic
 * over prepared items and scenario ids, and the orchestrator is already the file every node kind
 * has to touch.
 */
import { createHash } from "node:crypto";

/** `run_cases.scenarioId` is a `varchar(200)`. */
const SCENARIO_ID_MAX = 200;

/**
 * A prepared item and every item nested under it, in walking order: a subflow node, then its child
 * flow's steps, then theirs. What the run saves as `queued` up front and counts toward its budget.
 */
export function flattenPrepared<T extends { children?: T[] }>(items: T[]): T[] {
  return items.flatMap((item) => [item, ...flattenPrepared(item.children ?? [])]);
}

/**
 * A child step's scenario id, re-rooted under the node that runs it.
 *
 * The child's own prepare names its steps `workflow:<child>:<step>` (and its own subflows'
 * `workflow:<child>:<node>>…`). Under the parent that becomes `workflow:<parent>:<node>><step>`, so
 * the report reads the path the run took, and a canvas that splits on `>` lights the parent's node
 * while the child walks — with the child's ids unable to collide with the parent's own.
 *
 * Three levels of 60-character ids do not fit in the column, so past it the middle of the path
 * collapses to a digest: the root flow, the first node and the child's own step id survive, which
 * is what somebody reading a failed case needs.
 */
export function nestedScenarioId(parentFlowId: string, nodeId: string, childFlowId: string, childScenarioId: string): string {
  const own = `workflow:${childFlowId}:`;
  const rest = childScenarioId.startsWith(own) ? childScenarioId.slice(own.length) : childScenarioId;
  const head = `workflow:${parentFlowId}:`;
  const full = `${head}${nodeId}>${rest}`;
  if (full.length <= SCENARIO_ID_MAX) return full;
  const digest = createHash("sha1").update(full).digest("hex").slice(0, 8);
  const node = nodeId.slice(0, 20);
  const tail = rest.slice(-(SCENARIO_ID_MAX - head.length - node.length - digest.length - 3));
  return `${head}${node}>${digest}>${tail}`;
}
