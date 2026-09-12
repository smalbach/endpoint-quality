import { randomUUID } from "node:crypto";
import { Inject, Logger } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { MAILER, passwordResetMail, type MailerPort } from "@/shared/mail/mailer";
import { isActive, normalizeEmail } from "../../domain/model";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../domain/ports";
import {
  PASSWORD_RESET_REPOSITORY,
  PASSWORD_RESET_TTL_MS,
  type PasswordResetRepositoryPort,
} from "../../domain/password-reset";

export class RequestPasswordResetCommand implements ICommand {
  constructor(readonly email: string) {}
}

/**
 * Sends a reset link, **and answers the same thing whether or not the account exists**.
 *
 * The response is identical and so is its timing: the token is generated and hashed on both
 * paths, and the mail is sent after the answer has left rather than awaited. Awaiting it would put
 * a round trip to the mail provider in one branch and not in the other, and the difference is
 * measurable from outside — a list of valid addresses for anyone patient.
 */
@CommandHandler(RequestPasswordResetCommand)
export class RequestPasswordResetHandler implements ICommandHandler<RequestPasswordResetCommand, void> {
  private readonly logger = new Logger("PasswordReset");

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly resets: PasswordResetRepositoryPort,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(command: RequestPasswordResetCommand): Promise<void> {
    const user = await this.users.findByEmail(normalizeEmail(command.email));
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    if (!user || !isActive(user)) return;

    const now = this.clock.now();
    await this.resets.save({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      usedAt: null,
    });

    const link = `${this.env.APP_URL.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
    void this.mailer
      .send({
        to: user.email,
        ...passwordResetMail({ name: user.name, link, minutes: PASSWORD_RESET_TTL_MS / 60_000 }),
      })
      .catch((error: unknown) =>
        this.logger.error(
          `No se pudo enviar el correo de restablecer: ${error instanceof Error ? error.message : error}`,
        ),
      );
  }
}
