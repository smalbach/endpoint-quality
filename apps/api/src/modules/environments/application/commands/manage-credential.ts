import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import type { CredentialKind, CredentialRole } from "../../domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "../../domain/ports";
import { ownedEnvironment } from "./manage-environment";

export class UpsertCredentialCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
    readonly input: {
      name: string;
      role: CredentialRole;
      kind: CredentialKind;
      headerName?: string | null;
      secret: string;
      scopes?: string[];
    },
  ) {}
}

export class DeleteCredentialCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly environmentId: string,
    readonly role: CredentialRole,
  ) {}
}

/**
 * Stores a credential for a target, encrypted.
 *
 * Encrypted and not hashed, because unlike a password this has to be replayed on every request
 * the runner makes. AES-256-GCM so a tampered ciphertext fails to decrypt rather than decrypting
 * to garbage that then goes out as an `Authorization` header.
 *
 * One credential per role per environment, upserted: the generator asks for "the insufficient
 * one", and two rows answering to that would make which token a 403 case sends depend on row
 * order.
 */
@CommandHandler(UpsertCredentialCommand)
export class UpsertCredentialHandler implements ICommandHandler<UpsertCredentialCommand, { credentialId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpsertCredentialCommand) {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    if (!command.input.secret)
      throw new InvalidInputError("Falta el secreto", [{ field: "secret", detail: "Requerido" }]);
    if (command.input.kind === "api_key" && !command.input.headerName) {
      // Bearer and Basic imply `Authorization`; an API key is whatever the target calls it, and
      // guessing `X-API-Key` for a target that expects something else produces a 401 that looks
      // like a finding about the endpoint.
      throw new InvalidInputError("Una API key necesita el nombre de su cabecera", [
        { field: "headerName", detail: "Requerido para kind api_key" },
      ]);
    }

    const now = this.clock.now();
    const existing = await this.environments.findCredential(environment.id, command.input.role);
    const credential = {
      id: existing?.id ?? randomUUID(),
      environmentId: environment.id,
      name: command.input.name.trim() || command.input.role,
      role: command.input.role,
      kind: command.input.kind,
      headerName: command.input.headerName ?? null,
      secretCiphertext: this.cipher.encrypt(command.input.secret),
      scopes: command.input.scopes ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.environments.saveCredential(credential);
    return { credentialId: credential.id };
  }
}

@CommandHandler(DeleteCredentialCommand)
export class DeleteCredentialHandler implements ICommandHandler<DeleteCredentialCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
  ) {}

  async execute(command: DeleteCredentialCommand): Promise<void> {
    const environment = await ownedEnvironment(
      this.projects,
      this.environments,
      command.organizationId,
      command.projectId,
      command.environmentId,
    );
    // Idempotent: deleting a credential that is already gone is the same outcome the caller
    // wanted, and reporting 404 for it only invites a retry loop.
    await this.environments.removeCredential(environment.id, command.role);
  }
}
