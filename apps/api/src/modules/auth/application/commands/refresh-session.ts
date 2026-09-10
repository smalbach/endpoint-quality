import { Inject, Logger } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { UnauthenticatedError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { ENV, type Env } from "@/shared/config/env";
import { ACCESS_TOKEN_SERVICE, type AccessTokenServicePort } from "../../domain/access-token";
import { isActive, verifyRefreshToken } from "../../domain/model";
import {
  REFRESH_TOKEN_REPOSITORY,
  USER_REPOSITORY,
  type RefreshTokenRepositoryPort,
  type UserRepositoryPort,
} from "../../domain/ports";
import { issueSession, type SessionTokens } from "./login-user";

export class RefreshSessionCommand implements ICommand {
  constructor(readonly refreshToken: string) {}
}

/**
 * Rotates a refresh token, and closes the session if the old one comes back.
 *
 * **Rotation on its own does not stop a stolen token.** The thief refreshes, gets a valid new
 * pair, and keeps going; the theft only surfaces when the legitimate user next refreshes and
 * presents a token that was already spent. So the spent tokens are *kept*, marked `usedAt`, and
 * presenting one again is treated as proof that two parties hold the chain.
 *
 * When that happens the entire session is revoked — not the one token. Revoking the presented
 * token alone leaves whichever party currently holds the newest one still logged in, and there
 * is no way to tell from here which of the two that is. Ending the session logs out both and
 * costs the legitimate user one login; leaving it open costs them the account.
 *
 * Deleting spent rows instead of marking them would erase the signal entirely: a token that is
 * gone is indistinguishable from one that never existed, and reuse would look like a typo.
 */
@CommandHandler(RefreshSessionCommand)
export class RefreshSessionHandler implements ICommandHandler<RefreshSessionCommand, SessionTokens> {
  private readonly logger = new Logger(RefreshSessionHandler.name);

  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenServicePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<SessionTokens> {
    const now = this.clock.now();
    const stored = await this.refreshTokens.findByHash(hashOpaqueToken(command.refreshToken));
    if (!stored) throw new UnauthenticatedError("La sesión no es válida");

    const verdict = verifyRefreshToken(stored, now);
    if (!verdict.usable) {
      if (verdict.reason === "reused") {
        await this.refreshTokens.revokeSession(stored.sessionId, now);
        this.logger.warn(
          `Reuso de refresh token detectado; sesión ${stored.sessionId} revocada para el usuario ${stored.userId}`,
        );
      }
      throw new UnauthenticatedError("La sesión no es válida");
    }

    const user = await this.users.findById(stored.userId);
    // A disabled account keeps a valid refresh token until it expires. Checking the user here is
    // what makes disabling take effect on the next rotation instead of up to thirty days later.
    if (!user || !isActive(user)) {
      await this.refreshTokens.revokeSession(stored.sessionId, now);
      throw new UnauthenticatedError("La sesión no es válida");
    }

    const issued = await issueSession({
      userId: user.id,
      email: user.email,
      // The new token joins the same session: that chain is what reuse detection walks.
      sessionId: stored.sessionId,
      now,
      ttlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
      accessTokens: this.accessTokens,
      refreshTokens: this.refreshTokens,
    });

    await this.refreshTokens.markUsed(stored.id, now, hashOpaqueToken(issued.refreshToken));
    return issued;
  }
}
