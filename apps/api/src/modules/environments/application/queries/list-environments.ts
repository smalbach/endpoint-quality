import type { EnvironmentSummaryOf } from "@eq/contracts";

import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { maskVariables, type CredentialRole, type Environment } from "../../domain/model";
import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";

export class ListEnvironmentsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Qué lista se pide: los que se usan, los archivados o los eliminados. */
    readonly state: LifecycleState = "active",
  ) {}
}

export type EnvironmentView = Environment &
  EnvironmentSummaryOf<Date> & {
    /** `scopes` is on the wire too and the browser does not read it yet; the contract declares
     * what a client can rely on, not everything the row happens to carry. */
    credentials: {
      id: string;
      name: string;
      role: CredentialRole;
      kind: string;
      headerName: string | null;
      scopes: string[];
      updatedAt: Date;
    }[];
  };

@QueryHandler(ListEnvironmentsQuery)
export class ListEnvironmentsHandler implements IQueryHandler<ListEnvironmentsQuery, EnvironmentView[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(query: ListEnvironmentsQuery): Promise<EnvironmentView[]> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const environments = await this.environments.listForProject(project.id, query.state);
    return Promise.all(
      environments.map(async (environment) => ({
        ...environment,
        active: environment.id === project.activeEnvironmentId,
        // Masked here rather than in the repository, because the repository is also what the run
        // orchestrator reads through, and a run needs the real value. One of the two callers has
        // to say which it wants; the one answering a browser is this one.
        variables: maskVariables(environment.variables),
        disabledVariables: maskVariables(environment.disabledVariables),
        credentials: (await this.environments.listCredentials(environment.id)).map((credential) => ({
          id: credential.id,
          name: credential.name,
          role: credential.role,
          kind: credential.kind,
          headerName: credential.headerName,
          scopes: credential.scopes,
          updatedAt: credential.updatedAt,
          // `secretCiphertext` is absent by construction rather than deleted afterwards: a view
          // that has to remember to strip a field is a view that will one day forget.
        })),
      })),
    );
  }
}
