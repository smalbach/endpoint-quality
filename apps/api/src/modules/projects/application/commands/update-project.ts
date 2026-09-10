import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";

export class UpdateProjectCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly changes: { name?: string; description?: string },
  ) {}
}

export class SetProjectArchivedCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly archived: boolean,
  ) {}
}

/** Loads a project and refuses to admit it exists to anyone outside its organization. The check
 * is folded into the 404 rather than answered with a 403, which would confirm the id is real. */
async function ownedProject(projects: ProjectRepositoryPort, organizationId: string, projectId: string) {
  const project = await projects.findById(projectId);
  if (!project || project.organizationId !== organizationId)
    throw new NotFoundError("El proyecto no existe", "project-not-found");
  return project;
}

@CommandHandler(UpdateProjectCommand)
export class UpdateProjectHandler implements ICommandHandler<UpdateProjectCommand, void> {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort) {}

  async execute(command: UpdateProjectCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    if (project.archivedAt) throw new ConflictError("El proyecto está archivado", "project-archived");
    // The slug is **not** recomputed from a new name: it is in URLs the team has bookmarked and
    // in whatever CI job launches their runs. Renaming a project should not break either.
    await this.projects.save({
      ...project,
      name: command.changes.name?.trim() || project.name,
      description: command.changes.description?.trim() ?? project.description,
    });
  }
}

@CommandHandler(SetProjectArchivedCommand)
export class SetProjectArchivedHandler implements ICommandHandler<SetProjectArchivedCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetProjectArchivedCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    await this.projects.save({ ...project, archivedAt: command.archived ? this.clock.now() : null });
  }
}

export { ownedProject };
