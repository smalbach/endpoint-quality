import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "../../domain/ports";

export class ActivateSpecVersionCommand implements ICommand {
  constructor(readonly organizationId: string, readonly projectId: string, readonly specVersionId: string) {}
}

/**
 * Points the project at a different snapshot.
 *
 * Rolling back to a previous contract is the reason this is a separate command: when v1.9 turns
 * the matrix red, the first question is whether the API broke or the contract moved, and
 * switching the active version answers it in one click instead of a re-import.
 */
@CommandHandler(ActivateSpecVersionCommand)
export class ActivateSpecVersionHandler implements ICommandHandler<ActivateSpecVersionCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
  ) {}

  async execute(command: ActivateSpecVersionCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const version = await this.specs.findVersionById(command.specVersionId);
    // Belongs-to-this-project is part of the existence check: a version id from another
    // customer's project must be a 404 here, not a 403 that confirms it is real.
    if (!version || version.projectId !== project.id) throw new NotFoundError("La versión no existe", "spec-version-not-found");
    await this.projects.save({ ...project, activeSpecVersionId: version.id });
  }
}
