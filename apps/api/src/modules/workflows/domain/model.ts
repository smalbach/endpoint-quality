import type { ScenarioAuth, WorkflowDocument } from "@eq/runner-core";

/**
 * What a project owns beyond the generated matrix: named requests, and the graphs built from them.
 *
 * Written out rather than derived from the engine's `RequestTemplate`, because a row and a value
 * disagree about absence: a column is `null`, and the engine's optional field is absent. Deriving
 * one from the other would leave `exactOptionalPropertyTypes` arguing at every boundary;
 * converting once, where the scenario is built, is cheaper and says what it does.
 */
export type RequestTemplateRow = {
  id: string;
  projectId: string;
  name: string;
  operationId: string;
  description: string | null;
  expectedStatus: number;
  parameters: Record<string, string>;
  /** `null` is «no payload», `{}` is «an empty one on purpose». The engine sends the second. */
  body: Record<string, unknown> | null;
  auth: ScenarioAuth;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

/** The document is the engine's own, so what was validated on write is what the orchestrator orders. */
export type WorkflowRow = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  definition: WorkflowDocument;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};
