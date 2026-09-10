import type { RequestTemplateRow, WorkflowRow } from "./model";

export const WORKFLOW_REPOSITORY = Symbol("WORKFLOW_REPOSITORY");

/**
 * Every read takes `projectId`, including the ones that already have a primary key.
 *
 * Not redundancy: it is what makes «execute workflow X» unable to reach another tenant's flow by
 * id alone. A repository that answers `findWorkflow(id)` puts that guarantee in the hands of every
 * caller instead of holding it once.
 */
export interface WorkflowRepositoryPort {
  listTemplates(projectId: string): Promise<RequestTemplateRow[]>;
  findTemplate(projectId: string, templateId: string): Promise<RequestTemplateRow | null>;
  findTemplateByName(projectId: string, name: string): Promise<RequestTemplateRow | null>;
  saveTemplate(row: RequestTemplateRow): Promise<void>;
  deleteTemplate(projectId: string, templateId: string): Promise<void>;
  /** Whether any flow of this project has a step pointing at the template. */
  isTemplateReferenced(projectId: string, templateId: string): Promise<boolean>;

  listWorkflows(projectId: string): Promise<WorkflowRow[]>;
  findWorkflow(projectId: string, workflowId: string): Promise<WorkflowRow | null>;
  findWorkflowByName(projectId: string, name: string): Promise<WorkflowRow | null>;
  saveWorkflow(row: WorkflowRow): Promise<void>;
  deleteWorkflow(projectId: string, workflowId: string): Promise<void>;
}
