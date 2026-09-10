import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { RequestTemplateViewOf, WorkflowViewOf, WorkflowsViewOf } from "@eq/contracts";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { RequestTemplateRow, WorkflowRow } from "../../domain/model";
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
    const [requestTemplates, workflows] = await Promise.all([
      this.workflows.listTemplates(query.projectId),
      this.workflows.listWorkflows(query.projectId),
    ]);
    return {
      requestTemplates: requestTemplates.map(templateView),
      workflows: workflows.map(workflowView),
    };
  }
}
