import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ForbiddenError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { USER_REPOSITORY, type UserRepositoryPort } from "@/modules/auth/domain/ports";
import { normalizeEmail } from "@/modules/auth/domain/model";
import {
  INVITATION_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  type InvitationRepositoryPort,
  type MembershipRepositoryPort,
} from "../../domain/ports";

export class AcceptInvitationCommand implements ICommand {
  constructor(
    readonly token: string,
    readonly userId: string,
  ) {}
}

/**
 * Joins the signed-in user to the organization the invitation names.
 *
 * The invitation is bound to the **address it was sent to**, and the check is here rather than
 * in the UI. Otherwise an invitation link is a bearer token for a role: anyone it is forwarded
 * to, deliberately or by a mail rule, can accept it with their own account.
 *
 * An existing member is answered idempotently instead of with a conflict — the second click on
 * the same link is the most likely way this endpoint is ever called twice.
 */
@CommandHandler(AcceptInvitationCommand)
export class AcceptInvitationHandler implements ICommandHandler<AcceptInvitationCommand, { organizationId: string }> {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepositoryPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: AcceptInvitationCommand) {
    const now = this.clock.now();
    const invitation = await this.invitations.findByHash(hashOpaqueToken(command.token));
    if (!invitation || invitation.revokedAt || invitation.acceptedAt)
      throw new NotFoundError("La invitación no es válida", "invitation-invalid");
    if (invitation.expiresAt.getTime() <= now.getTime())
      throw new NotFoundError("La invitación ha caducado", "invitation-expired");

    const user = await this.users.findById(command.userId);
    if (!user) throw new NotFoundError("El usuario no existe", "user-not-found");
    if (normalizeEmail(user.email) !== invitation.email) {
      throw new ForbiddenError("Esta invitación es para otra dirección de correo", "invitation-wrong-recipient");
    }

    const existing = await this.memberships.find(invitation.organizationId, user.id);
    if (!existing)
      await this.memberships.save({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        createdAt: now,
      });
    await this.invitations.save({ ...invitation, acceptedAt: now });

    return { organizationId: invitation.organizationId };
  }
}
