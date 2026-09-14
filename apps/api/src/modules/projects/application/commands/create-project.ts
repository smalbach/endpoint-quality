import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { InvalidInputError } from "@/shared/errors/domain-error";
import {
  normalizeTags,
  projectSettingsProblems,
  slugifyProject,
  type Project,
  type ProjectSettingsInput,
} from "../../domain/model";
import { NO_AUTH, storeProjectAuth } from "../../domain/project-auth";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";

export class CreateProjectCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly name: string,
    readonly description: string,
    readonly createdBy: string,
    readonly settings: ProjectSettingsInput = {},
  ) {}
}

@CommandHandler(CreateProjectCommand)
export class CreateProjectHandler implements ICommandHandler<
  CreateProjectCommand,
  { projectId: string; slug: string }
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
  ) {}

  async execute(command: CreateProjectCommand) {
    const problems = projectSettingsProblems(command.settings, NO_AUTH);
    if (problems.length) throw new InvalidInputError("La configuración del proyecto no es válida", problems);

    const project: Project = {
      id: randomUUID(),
      organizationId: command.organizationId,
      name: command.name.trim(),
      slug: await this.freeSlug(command.organizationId, slugifyProject(command.name)),
      description: command.description.trim(),
      createdBy: command.createdBy,
      createdAt: this.clock.now(),
      archivedAt: null,
      // No contract yet. The project exists first and the spec is imported into it, because
      // importing is a step that can fail — against an unreachable URL, or a document that does
      // not parse — and losing the project along with the failed import helps nobody.
      activeSpecVersionId: null,
      activeEnvironmentId: null,
      baseUrl: command.settings.baseUrl?.trim() ?? "",
      tags: normalizeTags(command.settings.tags ?? []),
      auth: command.settings.auth ? storeProjectAuth(command.settings.auth, NO_AUTH, this.cipher) : NO_AUTH,
      deletedAt: null,
    };
    await this.projects.save(project);
    return { projectId: project.id, slug: project.slug };
  }

  /** Uniqueness is per organization. The numeric suffix is sequential rather than random so the
   * second "Catalog" is `catalog-2` and not `catalog-8f21`. */
  private async freeSlug(organizationId: string, base: string): Promise<string> {
    if (!(await this.projects.findBySlug(organizationId, base))) return base;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!(await this.projects.findBySlug(organizationId, candidate))) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}
