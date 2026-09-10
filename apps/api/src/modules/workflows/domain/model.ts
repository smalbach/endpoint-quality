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

/**
 * A table of values a flow is run once per row of.
 *
 * What turns «crear un producto» into «crear estos cuarenta», which is the difference between a
 * smoke test and a suite. The columns reach the steps as `{{dataset.nombre}}`, so a flow written
 * against one row works against a thousand without being edited.
 *
 * Attached to a flow rather than to the project: a dataset's columns only mean anything next to
 * the steps that spend them, and the same column name in another flow would be a coincidence
 * rather than reuse.
 */
export type DatasetRow = {
  id: string;
  projectId: string;
  workflowId: string;
  name: string;
  /** Name to value, per row. Text only, because a variable is what goes into a URL or a body. */
  rows: Record<string, string>[];
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

/**
 * An ordered list of flows run as one, with one verdict.
 *
 * The nine flows somebody runs by hand before a release, in the order they have to run in, as a
 * single row in the history. Without it «¿estaba todo verde?» is nine answers somebody has to
 * remember to collect.
 */
export type SuiteRow = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  workflowIds: string[];
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};
