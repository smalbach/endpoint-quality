import type { MemberOf, MembersViewOf, PendingInvitationOf } from "@eq/contracts";

import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { USER_REPOSITORY, type UserRepositoryPort } from "@/modules/auth/domain/ports";
import { INVITATION_REPOSITORY, MEMBERSHIP_REPOSITORY, type InvitationRepositoryPort, type MembershipRepositoryPort } from "../../domain/ports";

export class ListMembersQuery implements IQuery {
  constructor(readonly organizationId: string) {}
}

export type MemberView = MemberOf<Date>;
export type PendingInvitationView = PendingInvitationOf<Date>;
export type MembersView = MembersViewOf<Date>;

@QueryHandler(ListMembersQuery)
export class ListMembersHandler implements IQueryHandler<ListMembersQuery, MembersView> {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(query: ListMembersQuery): Promise<MembersView> {
    const memberships = await this.memberships.listForOrganization(query.organizationId);
    const members = await Promise.all(
      memberships.map(async (membership) => {
        const user = await this.users.findById(membership.userId);
        return user ? { userId: user.id, email: user.email, name: user.name, role: membership.role, since: membership.createdAt } : null;
      }),
    );
    const invitations = (await this.invitations.listForOrganization(query.organizationId))
      .filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt)
      // The token hash never leaves the repository: this view is what the members page renders,
      // and a pending invitation is a live credential until it is accepted.
      .map((invitation) => ({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt }));

    return { members: members.filter((member): member is MemberView => member !== null), invitations };
  }
}
