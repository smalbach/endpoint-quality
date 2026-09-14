import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";
import { ownedEnvironment } from "./manage-environment";

export class ActivateEnvironmentCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
  ) {}
}

/**
 * Which environment the project works against.
 *
 * The project's, not the person's: the analyzer had one active environment per project and the
 * button in the bar says which one, so two people looking at it see the same answer. A run still
 * names its environment explicitly; this decides what every screen starts from.
 */
@CommandHandler(ActivateEnvironmentCommand)
export class ActivateEnvironmentHandler implements ICommandHandler<ActivateEnvironmentCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(command: ActivateEnvironmentCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    const project = await this.projects.findById(environment.projectId);
    if (project && project.activeEnvironmentId !== environment.id)
      await this.projects.save({ ...project, activeEnvironmentId: environment.id });
  }
}
