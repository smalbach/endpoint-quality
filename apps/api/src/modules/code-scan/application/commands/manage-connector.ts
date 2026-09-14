import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { CODE_CONNECTOR_REPOSITORY, type CodeConnectorRepositoryPort } from "../../domain/ports";

export type ConnectorInput = {
  repo?: string;
  branch?: string;
  basePath?: string;
  prefix?: string;
  /** Present to set or replace the token; absent leaves the stored one untouched; empty string
   * clears it. The token is never echoed back by any read. */
  token?: string | null;
};

export class SaveConnectorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: ConnectorInput,
    readonly actorId: string,
  ) {}
}
export class DeleteConnectorCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}

// owner/repo — the shape the GitHub API paths are built from.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

@CommandHandler(SaveConnectorCommand)
export class SaveConnectorHandler implements ICommandHandler<SaveConnectorCommand, { connectorId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_CONNECTOR_REPOSITORY) private readonly connectors: CodeConnectorRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SaveConnectorCommand): Promise<{ connectorId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const existing = await this.connectors.find(command.projectId);
    const repo = (command.input.repo ?? existing?.repo ?? "").trim();
    if (!REPO.test(repo))
      throw new InvalidInputError(
        "El repositorio es «owner/repo»",
        [{ field: "repo", detail: "owner/repo" }],
        "connector-invalid",
      );

    // The token is only rewritten when the field is present. Absent keeps what was stored; an empty
    // string is «forget it» — the way the environment editor treats a sensitive value.
    const tokenCiphertext =
      command.input.token === undefined
        ? (existing?.tokenCiphertext ?? null)
        : command.input.token
          ? this.cipher.encrypt(command.input.token)
          : null;

    const now = this.clock.now();
    const id = existing?.id ?? randomUUID();
    await this.connectors.save({
      id,
      projectId: command.projectId,
      provider: "github",
      repo,
      branch: (command.input.branch ?? existing?.branch ?? "main").trim() || "main",
      basePath: (command.input.basePath ?? existing?.basePath ?? "").trim(),
      prefix: (command.input.prefix ?? existing?.prefix ?? "").trim(),
      tokenCiphertext,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: command.actorId,
    });
    return { connectorId: id };
  }
}

@CommandHandler(DeleteConnectorCommand)
export class DeleteConnectorHandler implements ICommandHandler<DeleteConnectorCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CODE_CONNECTOR_REPOSITORY) private readonly connectors: CodeConnectorRepositoryPort,
  ) {}

  async execute(command: DeleteConnectorCommand): Promise<void> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    await this.connectors.delete(command.projectId);
  }
}
