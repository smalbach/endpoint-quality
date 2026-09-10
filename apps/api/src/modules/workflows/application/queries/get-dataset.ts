import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { DatasetRowsView } from "@eq/contracts";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";

/** The rows of one dataset, asked for on purpose — the list deliberately does not carry them. */
export class GetDatasetQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly datasetId: string,
  ) {}
}

@QueryHandler(GetDatasetQuery)
export class GetDatasetHandler implements IQueryHandler<GetDatasetQuery, DatasetRowsView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(query: GetDatasetQuery): Promise<DatasetRowsView> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const dataset = await this.workflows.findDataset(query.projectId, query.datasetId);
    if (!dataset) throw new NotFoundError("El conjunto de datos no existe", "dataset-not-found");
    return { id: dataset.id, name: dataset.name, rows: dataset.rows };
  }
}
