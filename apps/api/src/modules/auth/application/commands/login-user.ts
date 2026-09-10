import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { UnauthenticatedError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PASSWORD_HASHER, type PasswordHasherPort } from "@/shared/crypto/password-hasher";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { ENV } from "@/shared/config/env";
import type { Env } from "@/shared/config/env";
import { ACCESS_TOKEN_SERVICE, type AccessTokenServicePort } from "../../domain/access-token";
import { isActive, normalizeEmail } from "../../domain/model";
import {
  REFRESH_TOKEN_REPOSITORY,
  USER_REPOSITORY,
  type RefreshTokenRepositoryPort,
  type UserRepositoryPort,
} from "../../domain/ports";

export class LoginUserCommand implements ICommand {
  constructor(
    readonly email: string,
    readonly password: string,
  ) {}
}

export type SessionTokens = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: Date;
};

/**
 * Exchanges an email and a password for a session.
 *
 * **Every failure answers the same thing and takes the same time.** An unknown email verifies
 * the password against a decoy digest before failing, so the response time does not say whether
 * the account exists; a disabled account fails with the identical message, so probing does not
 * reveal that either. The temptation is to return "esa cuenta está deshabilitada" because it is
 * more helpful — it is also a free list of valid addresses for anyone with a wordlist.
 */
@CommandHandler(LoginUserCommand)
export class LoginUserHandler implements ICommandHandler<LoginUserCommand, SessionTokens> {
  /** A digest of a password nobody holds, hashed once, so the unknown-email path spends the
   * same work as the known-email one. */
  private decoy: string | null = null;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenServicePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(command: LoginUserCommand): Promise<SessionTokens> {
    const user = await this.users.findByEmail(normalizeEmail(command.email));
    const digest = user?.passwordDigest ?? (await this.decoyDigest());
    const matches = await this.passwords.verify(command.password, digest);

    if (!user || !matches || !isActive(user)) throw new UnauthenticatedError();

    return issueSession({
      userId: user.id,
      email: user.email,
      sessionId: randomUUID(),
      now: this.clock.now(),
      ttlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
      accessTokens: this.accessTokens,
      refreshTokens: this.refreshTokens,
    });
  }

  private async decoyDigest(): Promise<string> {
    this.decoy ??= await this.passwords.hash(randomUUID());
    return this.decoy;
  }
}

/**
 * Mints one access/refresh pair and records the refresh side.
 *
 * Shared by login and by rotation so the two cannot drift — a refresh that stored its token with
 * a different expiry or under a different session than login does is a bug that only shows up on
 * the second day of a session.
 */
export async function issueSession(input: {
  userId: string;
  email: string;
  sessionId: string;
  now: Date;
  ttlDays: number;
  accessTokens: AccessTokenServicePort;
  refreshTokens: RefreshTokenRepositoryPort;
}): Promise<SessionTokens> {
  const refreshToken = generateOpaqueToken();
  const refreshExpiresAt = new Date(input.now.getTime() + input.ttlDays * 24 * 60 * 60 * 1000);

  await input.refreshTokens.save({
    id: randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    tokenHash: hashOpaqueToken(refreshToken),
    expiresAt: refreshExpiresAt,
    createdAt: input.now,
    usedAt: null,
    revokedAt: null,
    replacedByHash: null,
  });

  return {
    userId: input.userId,
    accessToken: await input.accessTokens.sign({ sub: input.userId, email: input.email }),
    refreshToken,
    expiresIn: input.accessTokens.ttlSeconds(),
    refreshExpiresAt,
  };
}
