import { describe, expect, test } from "vitest";
import { flowConnections, subflowTree, subflowsOf } from "./workflow-subflow";
import type { WorkflowStepView, WorkflowView } from "@/lib/types";

const call = (id: string, workflowId: string) => ({ id, kind: "subflow", subflow: { workflowId } }) as WorkflowStepView;
const flow = (id: string, steps: WorkflowStepView[] = []) =>
  ({ id, name: id, status: "draft", steps }) as Pick<WorkflowView, "id" | "name" | "status" | "steps">;

describe("subflowsOf", () => {
  test("lists each flow once, in node order", () => {
    expect(subflowsOf(flow("a", [call("n1", "b"), call("n2", "c"), call("n3", "b")]))).toEqual(["b", "c"]);
  });
});

describe("flowConnections", () => {
  test("knows who runs whom and which suites hold each flow", () => {
    const flows = [flow("a", [call("n1", "b")]), flow("b", [call("n1", "c")]), flow("c"), flow("d", [call("n", "c")])];
    const result = flowConnections(flows, [{ id: "s", workflowIds: ["a", "c", "a"] }]);
    expect(result.a).toEqual({ calls: ["b"], calledBy: [], suites: ["s"] });
    expect(result.c).toEqual({ calls: [], calledBy: ["b", "d"], suites: ["s"] });
  });

  test("a call to a deleted flow stays in calls and touches nothing else", () => {
    const result = flowConnections([flow("a", [call("n", "gone")])]);
    expect(result.a.calls).toEqual(["gone"]);
    expect(result.gone).toBeUndefined();
  });
});

describe("subflowTree", () => {
  test("nests what each subflow runs", () => {
    const tree = subflowTree([flow("a", [call("n", "b")]), flow("b", [call("n", "c")]), flow("c")], "a");
    expect(tree.map((node) => node.id)).toEqual(["b"]);
    expect(tree[0].children.map((node) => node.id)).toEqual(["c"]);
  });

  test("marks a cycle instead of walking it forever", () => {
    const tree = subflowTree([flow("a", [call("n", "b")]), flow("b", [call("n", "a")])], "a");
    expect(tree[0].children[0]).toMatchObject({ id: "a", cycle: true, children: [] });
  });

  test("keeps a missing flow as a dangling leaf", () => {
    expect(subflowTree([flow("a", [call("n", "gone")])], "a")[0]).toMatchObject({ id: "gone", flow: null });
  });
});
