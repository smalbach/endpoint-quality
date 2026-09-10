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

/**
 * Who the caller is, for **either kind of principal**.
 *
 * `GET /auth/me` answers for a person and refuses a service token, correctly: a token does not
 * have a name or an email and pretending otherwise would put a fictional user in an audit trail.
 * But every route below `/orgs/:organizationId/...` needs an organization id, and a token had no
 * way to find out its own — so a CI job could hold a perfectly good credential and still not know
 * where to point it. The answer was "pass the id on the command line too", which is a second
 * secret-adjacent value to copy, keep in sync, and get wrong.
 *
 * A token belongs to exactly one organization, so there is nothing to choose here and nothing to
 * get wrong by choosing. A user gets the same shape with their memberships, so one client can
 * boot from one call whichever credential it holds.
 */
export class GetAuthContextQuery implements IQuery {
  constructor(readonly principal: { kind: "user"; userId: string } | { kind: "api-token"; organizationId: string; tokenId: string }) {}
}

export type AuthContextView = {
  principal: "user" | "api-token";
  /** Present only for a person. A token has no user behind it by design. */
  user: { id: string; email: string; name: string } | null;
  organizations: { id: string; name: string; slug: string; role: Role }[];
};

@QueryHandler(GetAuthContextQuery)
export class GetAuthContextHandler implements IQueryHandler<GetAuthContextQuery, AuthContextView> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepositoryPort,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepositoryPort,
  ) {}

  async execute(query: GetAuthContextQuery): Promise<AuthContextView> {
    if (query.principal.kind === "api-token") {
      const organization = await this.organizations.findById(query.principal.organizationId);
      if (!organization) throw new NotFoundError("La organización del token no existe", "organization-not-found");
      // `editor` because that is what `OrgRoleGuard` grants a service token — reported rather
      // than implied, so a client can tell before it tries that this credential will not, say,
      // invite a member.
      return { principal: "api-token", user: null, organizations: [{ id: organization.id, name: organization.name, slug: organization.slug, role: "editor" }] };
    }
    const user = await this.users.findById(query.principal.userId);
    if (!user) throw new NotFoundError("El usuario no existe", "user-not-found");
    const memberships = await this.memberships.listForUser(user.id);
    const organizations = await Promise.all(
      memberships.map(async (membership) => {
        const organization = await this.organizations.findById(membership.organizationId);
        return organization ? { id: organization.id, name: organization.name, slug: organization.slug, role: membership.role } : null;
      }),
    );
    return {
      principal: "user",
      user: { id: user.id, email: user.email, name: user.name },
      organizations: organizations.filter((organization): organization is NonNullable<typeof organization> => organization !== null),
    };
  }
}
