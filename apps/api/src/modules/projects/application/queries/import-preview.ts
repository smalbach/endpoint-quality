import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { ImportPreviewView } from "@eq/contracts";

import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { ownedProject } from "../commands/update-project";

export class GetImportPreviewQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sourceProjectId: string,
  ) {}
}

/**
 * What another project of the organization has to copy, listed so the target can choose.
 *
 * Both projects are resolved through `ownedProject`, so this is not a way to read a project the
 * caller is not a member of — a source in another organization is a 404, like everywhere here.
 */
@QueryHandler(GetImportPreviewQuery)
export class GetImportPreviewHandler implements IQueryHandler<GetImportPreviewQuery, ImportPreviewView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(query: GetImportPreviewQuery): Promise<ImportPreviewView> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    await ownedProject(this.projects, query.organizationId, query.sourceProjectId);
    const [endpoints, workflows, environments] = await Promise.all([
      this.endpoints.listAll(query.sourceProjectId),
      this.workflows.listWorkflows(query.sourceProjectId),
      this.environments.listForProject(query.sourceProjectId),
    ]);
    return {
      endpoints: endpoints.map((endpoint) => ({ id: endpoint.id, method: endpoint.method, path: endpoint.path })),
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        steps: workflow.definition.steps.length,
      })),
      environments: environments.map((environment) => ({ id: environment.id, name: environment.name })),
    };
  }
}
