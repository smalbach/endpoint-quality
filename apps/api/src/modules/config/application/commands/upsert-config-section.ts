import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { isConfigSection, safeParseSection, type ConfigSection } from "@eq/runner-core";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "../../domain/ports";

export class UpsertConfigSectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly section: string,
    readonly data: unknown,
    readonly updatedBy: string,
  ) {}
}

export class ResetConfigSectionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly section: string,
  ) {}
}

/**
 * Writes one section, whole, after validating it.
 *
 * The section is the unit of change on purpose: a half-applied edit — new budget rules saved,
 * their order not — is not a state that can exist. Postgres cannot check the shape of a JSONB
 * document, so the zod schema in `@eq/runner-core` does, and it lives beside the type it
 * describes rather than here, where it would drift.
 *
 * Validation failures come back as 422 with a **field path**, because "invalid config" over a
 * document with forty keys is not something anybody can act on.
 */
@CommandHandler(UpsertConfigSectionCommand)
export class UpsertConfigSectionHandler implements ICommandHandler<UpsertConfigSectionCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpsertConfigSectionCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const section = assertSection(command.section);

    const verdict = safeParseSection(section, command.data);
    if (!verdict.ok)
      throw new InvalidInputError(`La sección ${section} no es válida`, verdict.issues, "config-invalid");

    await this.config.saveSection({
      projectId: project.id,
      section,
      data: command.data,
      updatedAt: this.clock.now(),
      updatedBy: command.updatedBy,
    });
  }
}

/** Removes a section so the project falls back to the engine's defaults. Deleting the row is the
 * only honest way to say "unset": writing the defaults into it would look like a decision. */
@CommandHandler(ResetConfigSectionCommand)
export class ResetConfigSectionHandler implements ICommandHandler<ResetConfigSectionCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
  ) {}

  async execute(command: ResetConfigSectionCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    await this.config.deleteSection(project.id, assertSection(command.section));
  }
}

function assertSection(value: string): ConfigSection {
  if (!isConfigSection(value)) {
    throw new InvalidInputError(
      "Sección de configuración desconocida",
      [{ field: "section", detail: `"${value}" no es una sección válida` }],
      "config-section-unknown",
    );
  }
  return value;
}
