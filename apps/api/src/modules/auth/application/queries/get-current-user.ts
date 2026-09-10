import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import { MEMBERSHIP_REPOSITORY, ORGANIZATION_REPOSITORY, type MembershipRepositoryPort, type OrganizationRepositoryPort } from "@/modules/iam/domain/ports";
import type { Role } from "@/modules/iam/domain/model";
import { USER_REPOSITORY, type UserRepositoryPort } from "../../domain/ports";

export class GetCurrentUserQuery implements IQuery {
  constructor(readonly userId: string) {}
}

export type CurrentUserView = {
  id: string;
  email: string;
  name: string;
  organizations: { id: string; name: string; slug: string; role: Role }[];
};

/**
 * The read model the front end boots from: who you are and which organizations you can act in.
 *
 * A query and not a command, and it reads across two modules on purpose. The alternative —
 * duplicating memberships into the auth module so this handler stays inside one boundary — buys
 * a cleaner import graph and pays for it with two copies of the fact that decides every
 * authorization check in the system.
 */
@QueryHandler(GetCurrentUserQuery)
export class GetCurrentUserHandler implements IQueryHandler<GetCurrentUserQuery, CurrentUserView> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepositoryPort,
  ) {}

  async execute(query: GetCurrentUserQuery): Promise<CurrentUserView> {
    const user = await this.users.findById(query.userId);
    if (!user) throw new NotFoundError("El usuario no existe", "user-not-found");

    const memberships = await this.memberships.listForUser(user.id);
    const organizations = await Promise.all(
      memberships.map(async (membership) => {
        const organization = await this.organizations.findById(membership.organizationId);
        return organization ? { id: organization.id, name: organization.name, slug: organization.slug, role: membership.role } : null;
      }),
    );

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      organizations: organizations.filter((organization): organization is NonNullable<typeof organization> => organization !== null),
    };
  }
}
