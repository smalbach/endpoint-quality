import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { diffOperations, type SpecDrift } from "@eq/spec-import";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "../../domain/ports";
import { ImportSpecVersionCommand, type ImportSpecVersionResult, type SpecSourceInput } from "./import-spec-version";

export class CheckSpecDriftCommand implements ICommand {
  constructor(readonly organizationId: string, readonly projectId: string, readonly source: SpecSourceInput, readonly checkedBy: string) {}
}

export type SpecDriftResult = SpecDrift & {
  unchanged: boolean;
  activeVersionId: string;
  candidateVersionId: string;
};

/**
 * Fetches the contract again and reports what moved, **without activating anything**.
 *
 * This is the capability the coupled dashboard structurally could not have: its operation table
 * was compiled into the bundle, so "the contract changed" and "the contract is fine" produced
 * identical output — a green matrix. A drift detector that cannot detect its own drift is the
 * worst possible version of the tool, and this command is the answer to that.
 *
 * It imports the new document as an inactive version so the diff is against something durable
 * and the operator can activate it deliberately once they have read what changed.
 */
@CommandHandler(CheckSpecDriftCommand)
export class CheckSpecDriftHandler implements ICommandHandler<CheckSpecDriftCommand, SpecDriftResult> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    private readonly commandBus: CommandBus,
  ) {}

  async execute(command: CheckSpecDriftCommand): Promise<SpecDriftResult> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    if (!project.activeSpecVersionId) throw new ConflictError("El proyecto no tiene contrato activo con el que comparar", "no-active-spec");

    const active = await this.specs.findVersionById(project.activeSpecVersionId);
    if (!active) throw new NotFoundError("La versión activa no existe", "spec-version-not-found");

    const imported = await this.commandBus.execute<ImportSpecVersionCommand, ImportSpecVersionResult>(
      new ImportSpecVersionCommand(command.organizationId, project.id, command.source, command.checkedBy, false),
    );

    if (imported.specVersionId === active.id) {
      return { changes: [], breaking: [], uncovered: [], unchanged: true, activeVersionId: active.id, candidateVersionId: active.id };
    }

    const [before, after] = await Promise.all([this.specs.listOperations(active.id), this.specs.listOperations(imported.specVersionId)]);
    return { ...diffOperations(before, after), unchanged: false, activeVersionId: active.id, candidateVersionId: imported.specVersionId };
  }
}
