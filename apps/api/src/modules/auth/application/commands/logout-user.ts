import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { REFRESH_TOKEN_REPOSITORY, type RefreshTokenRepositoryPort } from "../../domain/ports";

export class LogoutUserCommand implements ICommand {
  constructor(
    readonly refreshToken: string | undefined,
    readonly everywhere: boolean,
    readonly userId: string,
  ) {}
}

/**
 * Ends a session, or every session the user has.
 *
 * Logging out revokes the **whole session** rather than the single token presented: the point of
 * the button is that the credential in this browser stops working, and revoking one link of a
 * rotation chain leaves the rest of the chain valid.
 *
 * A logout with no token, or with one that does not resolve, still answers success. There is
 * nothing for the caller to do about it and nothing to learn from it — telling them their token
 * was already unknown is an oracle with no upside.
 */
@CommandHandler(LogoutUserCommand)
export class LogoutUserHandler implements ICommandHandler<LogoutUserCommand, void> {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: LogoutUserCommand): Promise<void> {
    const now = this.clock.now();
    if (command.everywhere) {
      await this.refreshTokens.revokeAllForUser(command.userId, now);
      return;
    }
    if (!command.refreshToken) return;
    const stored = await this.refreshTokens.findByHash(hashOpaqueToken(command.refreshToken));
    if (stored && stored.userId === command.userId) await this.refreshTokens.revokeSession(stored.sessionId, now);
  }
}
