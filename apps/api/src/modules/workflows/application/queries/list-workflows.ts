import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { DatasetViewOf, RequestTemplateViewOf, SuiteViewOf, WorkflowViewOf, WorkflowsViewOf } from "@eq/contracts";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";

export class ListWorkflowsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

export const templateView = (row: RequestTemplateRow): RequestTemplateViewOf<Date> => ({
  id: row.id,
  name: row.name,
  operationId: row.operationId,
  description: row.description,
  expectedStatus: row.expectedStatus,
  parameters: row.parameters ?? {},
  disabledParameters: row.disabledParameters ?? {},
  headers: row.headers ?? {},
  disabledHeaders: row.disabledHeaders ?? {},
  body: row.body ?? null,
  auth: row.auth ?? "default",
  updatedAt: row.updatedAt,
});

export const workflowView = (row: WorkflowRow): WorkflowViewOf<Date> => ({
  id: row.id,
  name: row.name,
  description: row.description,
  steps: row.definition.steps,
  updatedAt: row.updatedAt,
});

/** A dataset without its rows: the list is drawn from this, and five hundred rows of nine columns
 * in a page load is a payload nobody asked for. The rows come with the dataset when it is opened. */
export const datasetView = (row: DatasetRow): DatasetViewOf<Date> => ({
  id: row.id,
  workflowId: row.workflowId,
  name: row.name,
  columns: [...new Set(row.rows.flatMap((entry) => Object.keys(entry)))].sort(),
  rowCount: row.rows.length,
  updatedAt: row.updatedAt,
});

export const suiteView = (row: SuiteRow): SuiteViewOf<Date> => ({
  id: row.id,
  name: row.name,
  description: row.description,
  workflowIds: row.workflowIds,
  updatedAt: row.updatedAt,
});

/**
 * Both lists in one answer, because the editor cannot draw one without the other: a node shows the
 * method and path of the request its step names, and a second round trip to learn that would make
 * the graph render twice.
 */
@QueryHandler(ListWorkflowsQuery)
export class ListWorkflowsHandler implements IQueryHandler<ListWorkflowsQuery, WorkflowsViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(query: ListWorkflowsQuery): Promise<WorkflowsViewOf<Date>> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const [requestTemplates, workflows, datasets, suites] = await Promise.all([
      this.workflows.listTemplates(query.projectId),
      this.workflows.listWorkflows(query.projectId),
      this.workflows.listDatasets(query.projectId),
      this.workflows.listSuites(query.projectId),
    ]);
    return {
      requestTemplates: requestTemplates.map(templateView),
      workflows: workflows.map(workflowView),
      datasets: datasets.map(datasetView),
      suites: suites.map(suiteView),
    };
  }
}
