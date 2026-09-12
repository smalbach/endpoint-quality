import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { PASSWORD_HASHER, type PasswordHasherPort } from "@/shared/crypto/password-hasher";
import {
  REFRESH_TOKEN_REPOSITORY,
  USER_REPOSITORY,
  type RefreshTokenRepositoryPort,
  type UserRepositoryPort,
} from "../../domain/ports";
import {
  PASSWORD_RESET_REPOSITORY,
  resetTokenUsable,
  type PasswordResetRepositoryPort,
} from "../../domain/password-reset";
import { assertStrongPassword } from "../../domain/password-policy";

export class ResetPasswordCommand implements ICommand {
  constructor(
    readonly token: string,
    readonly newPassword: string,
  ) {}
}

/**
 * Sets a new password from a link, and closes everything the old one opened.
 *
 * - Every outstanding link of the user is spent, not only this one.
 * - Every session is revoked: a reset is what somebody does when they think another person has
 *   the password, and leaving that person's session alive would undo the reason for the reset.
 * - The lockout is lifted, because being locked out is the other reason people end up here.
 *
 * A token that does not exist, was used or expired all answer the same: which of the three it was
 * is of no use to the person holding it and of some use to somebody guessing.
 */
@CommandHandler(ResetPasswordCommand)
export class ResetPasswordHandler implements ICommandHandler<ResetPasswordCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly resets: PasswordResetRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<void> {
    const now = this.clock.now();
    const stored = await this.resets.findByHash(hashOpaqueToken(command.token));
    const user = stored && resetTokenUsable(stored, now) ? await this.users.findById(stored.userId) : null;
    if (!stored || !user) {
      throw new InvalidInputError(
        "El enlace no es válido o ha caducado",
        [{ field: "token", detail: "Pide un enlace nuevo desde «¿Olvidaste tu contraseña?»" }],
        "reset-token-invalid",
      );
    }
    // Checked after the token, so a weak password does not burn a good link and a bad link does
    // not get as far as saying what the password rules are.
    assertStrongPassword(command.newPassword, "newPassword");

    await this.users.save({
      ...user,
      passwordDigest: await this.passwords.hash(command.newPassword),
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    await this.resets.spendAllForUser(user.id, now);
    await this.refreshTokens.revokeAllForUser(user.id, now);
  }
}
