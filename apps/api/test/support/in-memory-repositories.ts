/**
 * The ports, backed by maps.
 *
 * These exist so the rules can be tested without a database — not because the database is slow,
 * but because a test that needs Postgres to prove "an admin cannot promote themselves to owner"
 * has buried a rule inside infrastructure. If a rule cannot be checked here, it is in the wrong
 * layer.
 *
 * They implement the ports honestly, including the parts that are easy to fake wrongly:
 * `revokeSession` closes every unrevoked token of a session, and `findByHash` matches on the
 * hash and not on the plaintext.
 */
import type { ApiToken, RefreshToken, User } from "@/modules/auth/domain/model";
import type { ApiTokenRepositoryPort, RefreshTokenRepositoryPort, UserRepositoryPort } from "@/modules/auth/domain/ports";
import type { Invitation, Membership, Organization } from "@/modules/iam/domain/model";
import type { InvitationRepositoryPort, MembershipRepositoryPort, OrganizationRepositoryPort } from "@/modules/iam/domain/ports";

export class InMemoryUserRepository implements UserRepositoryPort {
  readonly rows = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    return this.rows.get(id) ?? null;
  }
  async findByEmail(email: string): Promise<User | null> {
    const wanted = email.toLowerCase();
    return [...this.rows.values()].find((user) => user.email.toLowerCase() === wanted) ?? null;
  }
  async save(user: User): Promise<void> {
    this.rows.set(user.id, { ...user });
  }
}

export class InMemoryRefreshTokenRepository implements RefreshTokenRepositoryPort {
  readonly rows = new Map<string, RefreshToken>();

  async findByHash(hash: string): Promise<RefreshToken | null> {
    return [...this.rows.values()].find((token) => token.tokenHash === hash) ?? null;
  }
  async save(token: RefreshToken): Promise<void> {
    this.rows.set(token.id, { ...token });
  }
  async markUsed(id: string, at: Date, replacedByHash: string): Promise<void> {
    const token = this.rows.get(id);
    if (token) this.rows.set(id, { ...token, usedAt: at, replacedByHash });
  }
  async revokeSession(sessionId: string, at: Date): Promise<void> {
    for (const [id, token] of this.rows) {
      if (token.sessionId === sessionId && !token.revokedAt) this.rows.set(id, { ...token, revokedAt: at });
    }
  }
  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    for (const [id, token] of this.rows) {
      if (token.userId === userId && !token.revokedAt) this.rows.set(id, { ...token, revokedAt: at });
    }
  }
}

export class InMemoryApiTokenRepository implements ApiTokenRepositoryPort {
  readonly rows = new Map<string, ApiToken>();

  async findByHash(hash: string): Promise<ApiToken | null> {
    return [...this.rows.values()].find((token) => token.tokenHash === hash) ?? null;
  }
  async findById(id: string): Promise<ApiToken | null> {
    return this.rows.get(id) ?? null;
  }
  async listForOrganization(organizationId: string): Promise<ApiToken[]> {
    return [...this.rows.values()].filter((token) => token.organizationId === organizationId);
  }
  async save(token: ApiToken): Promise<void> {
    this.rows.set(token.id, { ...token });
  }
  async touch(id: string, at: Date): Promise<void> {
    const token = this.rows.get(id);
    if (token) this.rows.set(id, { ...token, lastUsedAt: at });
  }
}

export class InMemoryOrganizationRepository implements OrganizationRepositoryPort {
  readonly rows = new Map<string, Organization>();

  async findById(id: string): Promise<Organization | null> {
    return this.rows.get(id) ?? null;
  }
  async findBySlug(slug: string): Promise<Organization | null> {
    return [...this.rows.values()].find((organization) => organization.slug === slug) ?? null;
  }
  async save(organization: Organization): Promise<void> {
    this.rows.set(organization.id, { ...organization });
  }
}

export class InMemoryMembershipRepository implements MembershipRepositoryPort {
  readonly rows = new Map<string, Membership>();
  private key(organizationId: string, userId: string) {
    return `${organizationId}:${userId}`;
  }

  async find(organizationId: string, userId: string): Promise<Membership | null> {
    return this.rows.get(this.key(organizationId, userId)) ?? null;
  }
  async listForUser(userId: string): Promise<Membership[]> {
    return [...this.rows.values()].filter((membership) => membership.userId === userId);
  }
  async listForOrganization(organizationId: string): Promise<Membership[]> {
    return [...this.rows.values()].filter((membership) => membership.organizationId === organizationId);
  }
  async save(membership: Membership): Promise<void> {
    this.rows.set(this.key(membership.organizationId, membership.userId), { ...membership });
  }
  async remove(organizationId: string, userId: string): Promise<void> {
    this.rows.delete(this.key(organizationId, userId));
  }
}

export class InMemoryInvitationRepository implements InvitationRepositoryPort {
  readonly rows = new Map<string, Invitation>();

  async findByHash(hash: string): Promise<Invitation | null> {
    return [...this.rows.values()].find((invitation) => invitation.tokenHash === hash) ?? null;
  }
  async findPending(organizationId: string, email: string): Promise<Invitation | null> {
    return (
      [...this.rows.values()].find(
        (invitation) =>
          invitation.organizationId === organizationId &&
          invitation.email.toLowerCase() === email.toLowerCase() &&
          !invitation.acceptedAt &&
          !invitation.revokedAt,
      ) ?? null
    );
  }
  async listForOrganization(organizationId: string): Promise<Invitation[]> {
    return [...this.rows.values()].filter((invitation) => invitation.organizationId === organizationId);
  }
  async save(invitation: Invitation): Promise<void> {
    this.rows.set(invitation.id, { ...invitation });
  }
}
