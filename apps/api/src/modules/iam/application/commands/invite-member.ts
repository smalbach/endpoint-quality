import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, ForbiddenError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { generateOpaqueToken, hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { atLeast, type Role } from "../../domain/model";
import {
  INVITATION_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  type InvitationRepositoryPort,
  type MembershipRepositoryPort,
} from "../../domain/ports";

export class InviteMemberCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly email: string,
    readonly role: Role,
    readonly invitedBy: string,
  ) {}
}

const INVITATION_TTL_DAYS = 7;

/**
 * Invites somebody, at a role the inviter is allowed to grant.
 *
 * **Nobody can invite above their own level.** Without that rule an `admin` invites a new
 * `owner`, and then either accepts the invitation themselves or asks the invitee for the link:
 * a one-step privilege escalation dressed as an ordinary feature.
 *
 * The token is returned so the caller can deliver it. Sending mail is not this handler's job and
 * is not P1's; what matters now is that only its hash is stored, so the invitation link cannot
 * be recovered from the database by an operator either.
 */
@CommandHandler(InviteMemberCommand)
export class InviteMemberHandler implements ICommandHandler<
  InviteMemberCommand,
  { invitationId: string; token: string; expiresAt: Date }
> {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepositoryPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: InviteMemberCommand) {
    const inviter = await this.memberships.find(command.organizationId, command.invitedBy);
    if (!inviter || !atLeast(inviter.role, "admin")) throw new ForbiddenError("No puedes invitar a esta organización");
    if (!atLeast(inviter.role, command.role))
      throw new ForbiddenError("No puedes invitar con un rol superior al tuyo", "role-escalation");

    const email = command.email.trim().toLowerCase();
    if (await this.invitations.findPending(command.organizationId, email)) {
      throw new ConflictError("Esa dirección ya tiene una invitación pendiente", "invitation-pending");
    }

    const now = this.clock.now();
    const token = generateOpaqueToken();
    const invitation = {
      id: randomUUID(),
      organizationId: command.organizationId,
      email,
      role: command.role,
      tokenHash: hashOpaqueToken(token),
      invitedBy: command.invitedBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      revokedAt: null,
    };
    await this.invitations.save(invitation);
    return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
  }
}
