import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, EventBus, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PASSWORD_HASHER, type PasswordHasherPort } from "@/shared/crypto/password-hasher";
import { CreateOrganizationCommand } from "@/modules/iam/application/commands/create-organization";
import { normalizeEmail, type User } from "../../domain/model";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../domain/ports";
import { UserRegisteredEvent } from "../events/user-registered.event";
import { assertStrongPassword } from "../../domain/password-policy";

export class RegisterUserCommand implements ICommand {
  constructor(
    readonly email: string,
    readonly password: string,
    readonly name: string,
    /** The name of the organization created alongside the account. Absent means one named after
     * the person, which is what a first sign-up almost always wants. */
    readonly organizationName?: string,
  ) {}
}

export type RegisterUserResult = { userId: string; organizationId: string };

/**
 * Creates the account **and** the organization that owns everything it will go on to create.
 *
 * The organization is not optional and not deferred: every project, environment and run hangs
 * off one, so a user without an organization is an account that cannot do anything, and a UI
 * that has to handle that state is a state that exists only because registration skipped a step.
 *
 * It is created by dispatching `CreateOrganizationCommand` and awaiting it, rather than by
 * publishing an event the `iam` module reacts to. The event would be the more fashionable
 * choice and the wrong one here: `EventBus.publish` does not await its handlers, so the client
 * could log in and ask for its organizations before the handler that creates one has run.
 * Ordering matters, so this is a command.
 */
@CommandHandler(RegisterUserCommand)
export class RegisterUserHandler implements ICommandHandler<RegisterUserCommand, RegisterUserResult> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly commandBus: CommandBus,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: RegisterUserCommand): Promise<RegisterUserResult> {
    const email = normalizeEmail(command.email);
    if (!email.includes("@"))
      throw new InvalidInputError("El correo no es válido", [
        { field: "email", detail: "Debe ser una dirección de correo" },
      ]);
    assertStrongPassword(command.password, "password");

    if (await this.users.findByEmail(email)) {
      // This does leak that the address is registered, and it is the right trade here: the
      // alternative is silently not creating an account and telling the person it worked. The
      // enumeration surface that matters — login — does not leak, and that is where it counts.
      throw new ConflictError("Ese correo ya tiene una cuenta", "email-taken");
    }

    const now = this.clock.now();
    const user: User = {
      id: randomUUID(),
      email,
      name: command.name.trim() || email.split("@")[0],
      passwordDigest: await this.passwords.hash(command.password),
      status: "active",
      createdAt: now,
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    await this.users.save(user);

    const { organizationId } = await this.commandBus.execute<CreateOrganizationCommand, { organizationId: string }>(
      new CreateOrganizationCommand(command.organizationName?.trim() || `${user.name}`, user.id),
    );

    this.eventBus.publish(new UserRegisteredEvent(user.id, user.email, organizationId, now));
    return { userId: user.id, organizationId };
  }
}
