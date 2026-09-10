import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "./model";

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
  /** Whether any suite of this project names the flow. Deleting one that is named is a 409, the
   * same answer this product gives everywhere else a reference exists. */
  isWorkflowReferenced(projectId: string, workflowId: string): Promise<boolean>;

  listDatasets(projectId: string): Promise<DatasetRow[]>;
  findDataset(projectId: string, datasetId: string): Promise<DatasetRow | null>;
  findDatasetByName(workflowId: string, name: string): Promise<DatasetRow | null>;
  saveDataset(row: DatasetRow): Promise<void>;
  deleteDataset(projectId: string, datasetId: string): Promise<void>;

  listSuites(projectId: string): Promise<SuiteRow[]>;
  findSuite(projectId: string, suiteId: string): Promise<SuiteRow | null>;
  findSuiteByName(projectId: string, name: string): Promise<SuiteRow | null>;
  saveSuite(row: SuiteRow): Promise<void>;
  deleteSuite(projectId: string, suiteId: string): Promise<void>;
}
