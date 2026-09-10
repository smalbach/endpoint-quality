import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError, UnauthenticatedError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PASSWORD_HASHER, type PasswordHasherPort } from "@/shared/crypto/password-hasher";
import {
  REFRESH_TOKEN_REPOSITORY,
  USER_REPOSITORY,
  type RefreshTokenRepositoryPort,
  type UserRepositoryPort,
} from "../../domain/ports";

export class ChangePasswordCommand implements ICommand {
  constructor(
    readonly userId: string,
    readonly currentPassword: string,
    readonly newPassword: string,
  ) {}
}

/**
 * Changes the password and **logs every session out**, including the one that asked.
 *
 * The reason a person changes a password is usually that they think someone else has it. A
 * change that leaves the attacker's session alive does the one thing the user was trying to
 * prevent. The cost is one re-login; the alternative is a false sense of having fixed it.
 */
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler implements ICommandHandler<ChangePasswordCommand, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ChangePasswordCommand): Promise<void> {
    const user = await this.users.findById(command.userId);
    if (!user) throw new UnauthenticatedError();
    if (!(await this.passwords.verify(command.currentPassword, user.passwordDigest))) {
      throw new UnauthenticatedError("La contraseña actual no es correcta");
    }
    if (command.newPassword.length < 12) {
      throw new InvalidInputError("La contraseña es demasiado corta", [
        { field: "newPassword", detail: "Debe tener al menos 12 caracteres" },
      ]);
    }
    await this.users.save({ ...user, passwordDigest: await this.passwords.hash(command.newPassword) });
    await this.refreshTokens.revokeAllForUser(user.id, this.clock.now());
  }
}
