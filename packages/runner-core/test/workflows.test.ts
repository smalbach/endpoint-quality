import assert from "node:assert/strict";
import test from "node:test";
import { applyCaptures, orderWorkflowSteps } from "../src/workflows.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("orders workflow dependencies while preserving document order", () => {
  const steps = orderWorkflowSteps({
    steps: [
      { id: "read", requestTemplateId: uuid(1), dependsOn: ["update"] },
      { id: "update", requestTemplateId: uuid(2) },
    ],
  });
  assert.deepEqual(
    steps.map((step) => step.id),
    ["update", "read"],
  );
});

test("refuses to order a graph whose edge names a step that is not there", () => {
  assert.throws(
    () => orderWorkflowSteps({ steps: [{ id: "read", requestTemplateId: uuid(1), dependsOn: ["ausente"] }] }),
    /dependencias cíclicas o inexistentes/,
  );
});

test("captures response body and headers as runtime variables", () => {
  const variables = { base: "kept" };
  const result = applyCaptures(
    [
      { variable: "userId", from: "body", path: "data.id" },
      { variable: "cursor", from: "header", path: "x-cursor" },
    ],
    { body: { data: { id: 9 } }, headers: { "x-cursor": "next" } },
    variables,
  );
  assert.deepEqual(variables, { base: "kept", userId: "9", cursor: "next" });
  assert.deepEqual(result.missing, []);
});

test("a captured object is reported as missing, not stringified into a URL", () => {
  const variables: Record<string, string> = {};
  const result = applyCaptures(
    [{ variable: "user", from: "body", path: "data" }],
    { body: { data: { id: 9 } }, headers: {} },
    variables,
  );
  assert.deepEqual(result.missing, ["user"]);
  assert.deepEqual(variables, {});
});

test("rejects cycles, duplicate ids and self-dependency when the flow is saved", () => {
  const cyclic = safeParseWorkflowDocument({
    steps: [
      { id: "a", requestTemplateId: uuid(1), dependsOn: ["b"] },
      { id: "b", requestTemplateId: uuid(2), dependsOn: ["a"] },
    ],
  });
  assert.equal(cyclic.ok, false);
  if (!cyclic.ok) assert.ok(cyclic.issues.some((issue) => issue.detail.includes("cíclicas")));

  const duplicated = safeParseWorkflowDocument({
    steps: [
      { id: "a", requestTemplateId: uuid(1) },
      { id: "a", requestTemplateId: uuid(2) },
    ],
  });
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.ok(duplicated.issues.some((issue) => issue.detail.includes("únicos")));

  const selfish = safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), dependsOn: ["a"] }] });
  assert.equal(selfish.ok, false);
  if (!selfish.ok) assert.ok(selfish.issues.some((issue) => issue.detail.includes("sí mismo")));
});

test("an edge to a step that does not exist names the offending id", () => {
  const dangling = safeParseWorkflowDocument({
    steps: [{ id: "a", requestTemplateId: uuid(1), dependsOn: ["fantasma"] }],
  });
  assert.equal(dangling.ok, false);
  if (!dangling.ok) {
    assert.ok(dangling.issues.some((issue) => issue.detail.includes("fantasma")));
    assert.ok(dangling.issues.some((issue) => issue.field === "steps.0.dependsOn"));
  }
});

test("canvas coordinates survive validation and a bad one is refused", () => {
  assert.equal(
    safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), position: { x: 40, y: 60 } }] }).ok,
    true,
  );
  assert.equal(
    safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), position: { x: "40", y: 60 } }] }).ok,
    false,
  );
});
