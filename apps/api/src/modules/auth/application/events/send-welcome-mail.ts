import { Inject, Logger } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";

import { ENV, type Env } from "@/shared/config/env";
import { MAILER, welcomeMail, type MailerPort } from "@/shared/mail/mailer";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../domain/ports";
import { UserRegisteredEvent } from "./user-registered.event";

/**
 * The welcome mail, after the account exists.
 *
 * An event handler and not a line in the registration command: a mail provider that is down must
 * not turn a successful sign-up into a 500, and the person must not wait on it either.
 */
@EventsHandler(UserRegisteredEvent)
export class SendWelcomeMailHandler implements IEventHandler<UserRegisteredEvent> {
  private readonly logger = new Logger("WelcomeMail");

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async handle(event: UserRegisteredEvent): Promise<void> {
    try {
      const user = await this.users.findById(event.userId);
      await this.mailer.send({
        to: event.email,
        ...welcomeMail({ name: user?.name ?? event.email, link: `${this.env.APP_URL.replace(/\/+$/, "")}/login` }),
      });
    } catch (error) {
      this.logger.error(`No se pudo enviar el correo de bienvenida: ${error instanceof Error ? error.message : error}`);
    }
  }
}
