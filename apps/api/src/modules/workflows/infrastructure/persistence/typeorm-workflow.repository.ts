import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { ScenarioCredential, WorkflowDocument } from "@eq/runner-core";

import {
  RequestTemplateEntity,
  WorkflowDatasetEntity,
  WorkflowEntity,
  WorkflowSuiteEntity,
} from "@/shared/database/entities";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "../../domain/model";
import type { WorkflowRepositoryPort } from "../../domain/ports";
import { lifecycleSql, type LifecycleState } from "@/shared/lifecycle/lifecycle";

/**
 * The one place where the `jsonb` columns become typed values.
 *
 * `definition` is `unknown` in the entity on purpose: the boundary with Postgres is where a cast
 * belongs, and doing it once here is what stops the rest of the code from believing a shape nobody
 * checked. What it holds was validated by the engine's schema on the way in.
 */
const toTemplate = (row: RequestTemplateEntity): RequestTemplateRow => ({
  ...row,
  auth: row.auth as ScenarioCredential,
});

const toWorkflow = (row: WorkflowEntity): WorkflowRow => ({
  ...row,
  status: row.status as WorkflowRow["status"],
  definition: row.definition as WorkflowDocument,
});

@Injectable()
export class TypeOrmWorkflowRepository implements WorkflowRepositoryPort {
  constructor(
    @InjectRepository(RequestTemplateEntity) private readonly templates: Repository<RequestTemplateEntity>,
    @InjectRepository(WorkflowEntity) private readonly workflows: Repository<WorkflowEntity>,
    @InjectRepository(WorkflowDatasetEntity) private readonly datasets: Repository<WorkflowDatasetEntity>,
    @InjectRepository(WorkflowSuiteEntity) private readonly suites: Repository<WorkflowSuiteEntity>,
  ) {}

  async listTemplates(projectId: string): Promise<RequestTemplateRow[]> {
    return (await this.templates.find({ where: { projectId }, order: { name: "ASC" } })).map(toTemplate);
  }
  async findTemplate(projectId: string, templateId: string): Promise<RequestTemplateRow | null> {
    const row = await this.templates.findOne({ where: { id: templateId, projectId } });
    return row ? toTemplate(row) : null;
  }
  async findTemplateByName(projectId: string, name: string): Promise<RequestTemplateRow | null> {
    const row = await this.templates.findOne({ where: { projectId, name } });
    return row ? toTemplate(row) : null;
  }
  async saveTemplate(row: RequestTemplateRow): Promise<void> {
    await this.templates.save(this.templates.create(row));
  }
  async deleteTemplate(projectId: string, templateId: string): Promise<void> {
    await this.templates.delete({ id: templateId, projectId });
  }

  /**
   * Asked over the documents, because the reference lives inside one.
   *
   * No GIN index: a project has tens of flows, not millions, and an index on `definition` would be
   * paid on every save of a graph to speed up a question asked only when somebody deletes a
   * request. If that ever stops being true the answer is an index, not a schema change.
   */
  async isTemplateReferenced(projectId: string, templateId: string): Promise<boolean> {
    // Solo los flujos vivos cuentan: un flujo eliminado que nombrara la petición bloquearía para
    // siempre su borrado, y lo que está en la papelera no ejecuta nada.
    const found: unknown[] = await this.workflows.query(
      `SELECT 1
         FROM "workflows" w, jsonb_array_elements(w."definition" -> 'steps') s
        WHERE w."projectId" = $1 AND w."deletedAt" IS NULL AND s ->> 'requestTemplateId' = $2
        LIMIT 1`,
      [projectId, templateId],
    );
    return found.length > 0;
  }

  /** Ver el puerto: para un flujo, `active` es «no eliminado» y `archived` mira su `status`. */
  async listWorkflows(projectId: string, state: LifecycleState = "active"): Promise<WorkflowRow[]> {
    const query = this.workflows
      .createQueryBuilder("workflow")
      .where("workflow.projectId = :projectId", { projectId })
      .orderBy("workflow.name", "ASC");
    if (state === "deleted") query.andWhere(`workflow."deletedAt" IS NOT NULL`);
    else query.andWhere(`workflow."deletedAt" IS NULL`);
    if (state === "archived") query.andWhere("workflow.status = :archived", { archived: "archived" });
    return (await query.getMany()).map(toWorkflow);
  }
  async findWorkflow(projectId: string, workflowId: string): Promise<WorkflowRow | null> {
    const row = await this.workflows.findOne({ where: { id: workflowId, projectId } });
    return row ? toWorkflow(row) : null;
  }
  async findWorkflowByName(projectId: string, name: string): Promise<WorkflowRow | null> {
    const row = await this.workflows
      .createQueryBuilder("workflow")
      .where("workflow.projectId = :projectId", { projectId })
      .andWhere("workflow.name = :name", { name })
      .andWhere(`workflow."deletedAt" IS NULL`)
      .getOne();
    return row ? toWorkflow(row) : null;
  }
  async saveWorkflow(row: WorkflowRow): Promise<void> {
    await this.workflows.save(this.workflows.create(row));
  }
  async deleteWorkflow(projectId: string, workflowId: string): Promise<void> {
    await this.workflows.delete({ id: workflowId, projectId });
  }

  async isWorkflowReferenced(projectId: string, workflowId: string): Promise<boolean> {
    // `?` is the containment operator over the `jsonb` array of ids, so the check is one indexless
    // scan of a table with a handful of rows rather than every suite loaded into memory.
    const found = await this.suites
      .createQueryBuilder("suite")
      .where("suite.projectId = :projectId", { projectId })
      .andWhere(`suite."workflowIds" ? :workflowId`, { workflowId })
      // Una suite eliminada no ejecuta nada: si contara, bloquearía el borrado del flujo para
      // siempre por una lista que ya nadie mira.
      .andWhere(`suite."deletedAt" IS NULL`)
      .getCount();
    return found > 0;
  }

  async listDatasets(projectId: string, state: LifecycleState = "active"): Promise<DatasetRow[]> {
    const rows = await this.datasets
      .createQueryBuilder("dataset")
      .where("dataset.projectId = :projectId", { projectId })
      .andWhere(lifecycleSql("dataset", state))
      .orderBy("dataset.name", "ASC")
      .getMany();
    return rows.map((row) => ({ ...row }));
  }
  async findDataset(projectId: string, datasetId: string): Promise<DatasetRow | null> {
    const row = await this.datasets.findOne({ where: { id: datasetId, projectId } });
    return row ? { ...row } : null;
  }
  async findDatasetByName(workflowId: string, name: string): Promise<DatasetRow | null> {
    const row = await this.datasets
      .createQueryBuilder("dataset")
      .where(`dataset."workflowId" = :workflowId`, { workflowId })
      .andWhere("dataset.name = :name", { name })
      .andWhere(`dataset."deletedAt" IS NULL`)
      .getOne();
    return row ? { ...row } : null;
  }
  async saveDataset(row: DatasetRow): Promise<void> {
    await this.datasets.save(row);
  }
  async deleteDataset(projectId: string, datasetId: string): Promise<void> {
    await this.datasets.delete({ id: datasetId, projectId });
  }

  async listSuites(projectId: string, state: LifecycleState = "active"): Promise<SuiteRow[]> {
    const rows = await this.suites
      .createQueryBuilder("suite")
      .where("suite.projectId = :projectId", { projectId })
      .andWhere(lifecycleSql("suite", state))
      .orderBy("suite.name", "ASC")
      .getMany();
    return rows.map((row) => ({ ...row }));
  }
  async findSuite(projectId: string, suiteId: string): Promise<SuiteRow | null> {
    const row = await this.suites.findOne({ where: { id: suiteId, projectId } });
    return row ? { ...row } : null;
  }
  async findSuiteByName(projectId: string, name: string): Promise<SuiteRow | null> {
    const row = await this.suites
      .createQueryBuilder("suite")
      .where("suite.projectId = :projectId", { projectId })
      .andWhere("suite.name = :name", { name })
      .andWhere(`suite."deletedAt" IS NULL`)
      .getOne();
    return row ? { ...row } : null;
  }
  async saveSuite(row: SuiteRow): Promise<void> {
    await this.suites.save(row);
  }
  async deleteSuite(projectId: string, suiteId: string): Promise<void> {
    await this.suites.delete({ id: suiteId, projectId });
  }
}
