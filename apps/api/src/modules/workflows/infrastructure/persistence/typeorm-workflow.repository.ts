import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { ScenarioAuth, WorkflowDocument } from "@eq/runner-core";

import { RequestTemplateEntity, WorkflowEntity } from "@/shared/database/entities";
import type { RequestTemplateRow, WorkflowRow } from "../../domain/model";
import type { WorkflowRepositoryPort } from "../../domain/ports";

/**
 * The one place where the `jsonb` columns become typed values.
 *
 * `definition` is `unknown` in the entity on purpose: the boundary with Postgres is where a cast
 * belongs, and doing it once here is what stops the rest of the code from believing a shape nobody
 * checked. What it holds was validated by the engine's schema on the way in.
 */
const toTemplate = (row: RequestTemplateEntity): RequestTemplateRow => ({
  ...row,
  auth: row.auth as ScenarioAuth,
});

const toWorkflow = (row: WorkflowEntity): WorkflowRow => ({
  ...row,
  definition: row.definition as WorkflowDocument,
});

@Injectable()
export class TypeOrmWorkflowRepository implements WorkflowRepositoryPort {
  constructor(
    @InjectRepository(RequestTemplateEntity) private readonly templates: Repository<RequestTemplateEntity>,
    @InjectRepository(WorkflowEntity) private readonly workflows: Repository<WorkflowEntity>,
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
    const found: unknown[] = await this.workflows.query(
      `SELECT 1
         FROM "workflows" w, jsonb_array_elements(w."definition" -> 'steps') s
        WHERE w."projectId" = $1 AND s ->> 'requestTemplateId' = $2
        LIMIT 1`,
      [projectId, templateId],
    );
    return found.length > 0;
  }

  async listWorkflows(projectId: string): Promise<WorkflowRow[]> {
    return (await this.workflows.find({ where: { projectId }, order: { name: "ASC" } })).map(toWorkflow);
  }
  async findWorkflow(projectId: string, workflowId: string): Promise<WorkflowRow | null> {
    const row = await this.workflows.findOne({ where: { id: workflowId, projectId } });
    return row ? toWorkflow(row) : null;
  }
  async findWorkflowByName(projectId: string, name: string): Promise<WorkflowRow | null> {
    const row = await this.workflows.findOne({ where: { projectId, name } });
    return row ? toWorkflow(row) : null;
  }
  async saveWorkflow(row: WorkflowRow): Promise<void> {
    await this.workflows.save(this.workflows.create(row));
  }
  async deleteWorkflow(projectId: string, workflowId: string): Promise<void> {
    await this.workflows.delete({ id: workflowId, projectId });
  }
}
