import type { RunSource } from "@eq/contracts";

import type { WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import type { ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import type { Run } from "../../domain/model";

/**
 * What a run executed, resolved into names.
 *
 * Read from the current rows rather than stored with the run, which is a decision about which of
 * two lies is worse. Storing the name freezes it: renaming a flow would leave the history calling
 * it something nobody can find. Reading it means a deleted flow resolves to `null` — «ya no
 * existe» — which is true, and is what the interface should say.
 *
 * The plan itself is not resolved away: `plan.workflowId` stays the record of what was asked for,
 * and this is a view over it.
 */
export type SourceCatalog = {
  workflows: Map<string, string>;
  datasets: Map<string, string>;
  suites: Map<string, { name: string; workflowIds: string[] }>;
  /** How many rows each dataset had *when this was read*. A run walked the rows it walked; this is
   * only what the list shows next to the name. */
  datasetRows: Map<string, number>;
  /** Los canales por id, para una corrida que ejecutó uno sin flujo (la de un monitor de canal). */
  channels: Map<string, string>;
};

/**
 * One read of each table for a whole page of runs.
 *
 * A list of twenty-five runs resolving its own names would be seventy-five queries, which is the
 * N+1 that this codebase has already had to remove from the report view once.
 */
export async function loadCatalog(
  workflows: WorkflowRepositoryPort,
  projectId: string,
  channels: ChannelRepositoryPort | null = null,
): Promise<SourceCatalog> {
  const [flows, datasets, suites, channelRows] = await Promise.all([
    workflows.listWorkflows(projectId),
    workflows.listDatasets(projectId),
    workflows.listSuites(projectId),
    channels ? channels.listByProject(projectId) : Promise.resolve([]),
  ]);
  return {
    workflows: new Map(flows.map((flow) => [flow.id, flow.name])),
    datasets: new Map(datasets.map((dataset) => [dataset.id, dataset.name])),
    datasetRows: new Map(datasets.map((dataset) => [dataset.id, dataset.rows.length])),
    suites: new Map(suites.map((suite) => [suite.id, { name: suite.name, workflowIds: suite.workflowIds }])),
    channels: new Map(channelRows.map((channel) => [channel.id, channel.name])),
  };
}

export function describeSource(run: Run, catalog: SourceCatalog): RunSource {
  if (run.plan.channel) {
    const channelId = run.plan.channel.channelId;
    return { kind: "channel", channelId, name: catalog.channels.get(channelId) ?? null };
  }
  if (run.plan.suiteId) {
    const suite = catalog.suites.get(run.plan.suiteId);
    return {
      kind: "suite",
      suiteId: run.plan.suiteId,
      name: suite?.name ?? null,
      flowNames: (suite?.workflowIds ?? []).map((id) => catalog.workflows.get(id) ?? null),
    };
  }
  if (run.plan.workflowId) {
    const datasetId = run.plan.datasetId ?? null;
    return {
      kind: "workflow",
      workflowId: run.plan.workflowId,
      name: catalog.workflows.get(run.plan.workflowId) ?? null,
      datasetId,
      datasetName: datasetId ? (catalog.datasets.get(datasetId) ?? null) : null,
      rows: datasetId ? (catalog.datasetRows.get(datasetId) ?? 0) : 1,
    };
  }
  // An empty `operationIds` is the whole contract, which is a different statement from a subset of
  // zero and is what the interface has to be able to tell apart.
  return { kind: "matrix", operationIds: run.plan.operationIds, labels: run.plan.labels ?? [] };
}
