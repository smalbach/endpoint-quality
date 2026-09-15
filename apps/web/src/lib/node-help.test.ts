import { describe, expect, it } from "vitest";
import { NODE_HELP } from "@/lib/node-help";
import { CONTROL_PALETTE } from "@/lib/workflow-draft";
import { HELP_TOPICS } from "@/lib/help-content";

describe("node help", () => {
  it("covers every kind the palette drops, plus request and login", () => {
    const kinds = ["request", "login", ...CONTROL_PALETTE.map((item) => item.kind)];
    for (const kind of kinds) {
      const help = NODE_HELP[kind as keyof typeof NODE_HELP];
      expect(help, kind).toBeDefined();
      expect(help.summary.trim(), kind).not.toBe("");
      expect(help.how.length, kind).toBeGreaterThan(0);
      expect(help.example.trim(), kind).not.toBe("");
      expect(help.pitfalls.length, kind).toBeGreaterThan(0);
    }
  });

  it("warns that a poll does not retry a step that failed, and points at the retry node", () => {
    expect(NODE_HELP.poll.pitfalls.join(" ")).toMatch(/nodo Reintento/);
    expect(NODE_HELP.retry.how.join(" ")).toMatch(/«reintentar»/);
  });

  it("lists every node in the help panel", () => {
    const topic = HELP_TOPICS.find((entry) => entry.id === "nodos");
    expect(topic?.steps.map((step) => step.title)).toEqual(Object.values(NODE_HELP).map((help) => help.title));
  });
});
