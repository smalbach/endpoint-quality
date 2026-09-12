import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { ownedProject } from "./update-project";

export class DeleteProjectCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

/**
 * Deletes a project for everybody who can see it.
 *
 * A mark and not a row removed: from here on the project answers 404 to every route, as if it
 * never existed, while its runs stay in the database as the record of what they found. The
 * difference from archiving is who can reach it — an archived project is one click from coming
 * back, a deleted one is not offered anywhere.
 */
@CommandHandler(DeleteProjectCommand)
export class DeleteProjectHandler implements ICommandHandler<DeleteProjectCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeleteProjectCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    await this.projects.save({ ...project, deletedAt: this.clock.now() });
  }
}
