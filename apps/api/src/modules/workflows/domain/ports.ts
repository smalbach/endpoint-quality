import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
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

  /**
   * Los flujos del proyecto.
   *
   * `active` son **todos los que no están eliminados**, archivados incluidos: para un flujo,
   * archivar es su `status`, y la pantalla de flujos dibuja los tres estados con su propio filtro.
   * `archived` es el atajo para pedir solo esos, y `deleted` es la papelera.
   */
  listWorkflows(projectId: string, state?: LifecycleState): Promise<WorkflowRow[]>;
  /** Por id **en cualquier estado**: restaurar uno borrado empieza por encontrarlo. */
  findWorkflow(projectId: string, workflowId: string): Promise<WorkflowRow | null>;
  /** Por nombre, **solo entre los vivos**: el nombre de un flujo eliminado queda libre. */
  findWorkflowByName(projectId: string, name: string): Promise<WorkflowRow | null>;
  saveWorkflow(row: WorkflowRow): Promise<void>;
  /** El borrado de verdad, con sus conjuntos de datos por cascada. Solo «para siempre». */
  deleteWorkflow(projectId: string, workflowId: string): Promise<void>;
  /**
   * Si alguna suite **no eliminada** de este proyecto nombra el flujo. Borrar uno nombrado es un
   * 409, la misma respuesta que este producto da en todos los sitios donde hay una referencia.
   *
   * Una suite archivada cuenta: está apartada, no borrada, y desarchivarla tiene que devolver la
   * misma suite y no una con un paso menos. La que está en la papelera no cuenta, y ahí el guardia
   * es el otro lado —restaurarla comprueba que sus flujos siguen existiendo—.
   */
  isWorkflowReferenced(projectId: string, workflowId: string): Promise<boolean>;

  /** Los de ese estado. Sin estado, los activos. */
  listDatasets(projectId: string, state?: LifecycleState): Promise<DatasetRow[]>;
  /** Por id **en cualquier estado**. */
  findDataset(projectId: string, datasetId: string): Promise<DatasetRow | null>;
  /** Por nombre, **solo entre los vivos**: el nombre de uno eliminado queda libre. */
  findDatasetByName(workflowId: string, name: string): Promise<DatasetRow | null>;
  saveDataset(row: DatasetRow): Promise<void>;
  /** El borrado de verdad. Solo «para siempre». */
  deleteDataset(projectId: string, datasetId: string): Promise<void>;

  /** Las de ese estado. Sin estado, las activas. */
  listSuites(projectId: string, state?: LifecycleState): Promise<SuiteRow[]>;
  /** Por id **en cualquier estado**. */
  findSuite(projectId: string, suiteId: string): Promise<SuiteRow | null>;
  /** Por nombre, **solo entre las vivas**: el nombre de una eliminada queda libre. */
  findSuiteByName(projectId: string, name: string): Promise<SuiteRow | null>;
  saveSuite(row: SuiteRow): Promise<void>;
  /** El borrado de verdad. Solo «para siempre». */
  deleteSuite(projectId: string, suiteId: string): Promise<void>;
}
