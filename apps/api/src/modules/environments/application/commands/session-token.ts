import { Inject } from "@nestjs/common";
import {
  CommandHandler,
  QueryHandler,
  type ICommand,
  type ICommandHandler,
  type IQuery,
  type IQueryHandler,
} from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { SESSION_TOKEN_REPOSITORY, type SessionTokenRepositoryPort } from "../../domain/ports";
import {
  decodeJwtClaims,
  expiryOf,
  viewSessionToken,
  type SessionTokenSource,
  type SessionTokenView,
} from "../../domain/session-token";

/** Stores a token somebody just obtained, replacing the one they had. */
export async function captureSessionToken(
  repository: SessionTokenRepositoryPort,
  cipher: SecretCipherPort,
  capture: { actorId: string; projectId: string; token: string; source: SessionTokenSource; now: Date },
): Promise<void> {
  const claims = decodeJwtClaims(capture.token);
  await repository.save({
    actorId: capture.actorId,
    projectId: capture.projectId,
    tokenCiphertext: cipher.encrypt(capture.token),
    claims,
    expiresAt: expiryOf(claims),
    capturedAt: capture.now,
    source: capture.source,
  });
}

export class GetSessionTokenQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
  ) {}
}

@QueryHandler(GetSessionTokenQuery)
export class GetSessionTokenHandler implements IQueryHandler<GetSessionTokenQuery, { token: SessionTokenView | null }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SESSION_TOKEN_REPOSITORY) private readonly tokens: SessionTokenRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(query: GetSessionTokenQuery): Promise<{ token: SessionTokenView | null }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const token = await this.tokens.find(query.actorId, project.id);
    // Wrapped, so «no token» is a body and not an empty 200 a client has to special-case.
    return {
      token: token ? viewSessionToken(token, this.cipher.decrypt(token.tokenCiphertext), this.clock.now()) : null,
    };
  }
}

export class ClearSessionTokenCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
  ) {}
}

@CommandHandler(ClearSessionTokenCommand)
export class ClearSessionTokenHandler implements ICommandHandler<ClearSessionTokenCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SESSION_TOKEN_REPOSITORY) private readonly tokens: SessionTokenRepositoryPort,
  ) {}

  async execute(command: ClearSessionTokenCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    await this.tokens.remove(command.actorId, project.id);
  }
}
