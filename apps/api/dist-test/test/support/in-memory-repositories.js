"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryInvitationRepository = exports.InMemoryMembershipRepository = exports.InMemoryOrganizationRepository = exports.InMemoryApiTokenRepository = exports.InMemoryRefreshTokenRepository = exports.InMemoryUserRepository = void 0;
class InMemoryUserRepository {
    rows = new Map();
    async findById(id) {
        return this.rows.get(id) ?? null;
    }
    async findByEmail(email) {
        const wanted = email.toLowerCase();
        return [...this.rows.values()].find((user) => user.email.toLowerCase() === wanted) ?? null;
    }
    async save(user) {
        this.rows.set(user.id, { ...user });
    }
}
exports.InMemoryUserRepository = InMemoryUserRepository;
class InMemoryRefreshTokenRepository {
    rows = new Map();
    async findByHash(hash) {
        return [...this.rows.values()].find((token) => token.tokenHash === hash) ?? null;
    }
    async save(token) {
        this.rows.set(token.id, { ...token });
    }
    async markUsed(id, at, replacedByHash) {
        const token = this.rows.get(id);
        if (token)
            this.rows.set(id, { ...token, usedAt: at, replacedByHash });
    }
    async revokeSession(sessionId, at) {
        for (const [id, token] of this.rows) {
            if (token.sessionId === sessionId && !token.revokedAt)
                this.rows.set(id, { ...token, revokedAt: at });
        }
    }
    async revokeAllForUser(userId, at) {
        for (const [id, token] of this.rows) {
            if (token.userId === userId && !token.revokedAt)
                this.rows.set(id, { ...token, revokedAt: at });
        }
    }
}
exports.InMemoryRefreshTokenRepository = InMemoryRefreshTokenRepository;
class InMemoryApiTokenRepository {
    rows = new Map();
    async findByHash(hash) {
        return [...this.rows.values()].find((token) => token.tokenHash === hash) ?? null;
    }
    async findById(id) {
        return this.rows.get(id) ?? null;
    }
    async listForOrganization(organizationId) {
        return [...this.rows.values()].filter((token) => token.organizationId === organizationId);
    }
    async save(token) {
        this.rows.set(token.id, { ...token });
    }
    async touch(id, at) {
        const token = this.rows.get(id);
        if (token)
            this.rows.set(id, { ...token, lastUsedAt: at });
    }
}
exports.InMemoryApiTokenRepository = InMemoryApiTokenRepository;
class InMemoryOrganizationRepository {
    rows = new Map();
    async findById(id) {
        return this.rows.get(id) ?? null;
    }
    async findBySlug(slug) {
        return [...this.rows.values()].find((organization) => organization.slug === slug) ?? null;
    }
    async save(organization) {
        this.rows.set(organization.id, { ...organization });
    }
}
exports.InMemoryOrganizationRepository = InMemoryOrganizationRepository;
class InMemoryMembershipRepository {
    rows = new Map();
    key(organizationId, userId) {
        return `${organizationId}:${userId}`;
    }
    async find(organizationId, userId) {
        return this.rows.get(this.key(organizationId, userId)) ?? null;
    }
    async listForUser(userId) {
        return [...this.rows.values()].filter((membership) => membership.userId === userId);
    }
    async listForOrganization(organizationId) {
        return [...this.rows.values()].filter((membership) => membership.organizationId === organizationId);
    }
    async save(membership) {
        this.rows.set(this.key(membership.organizationId, membership.userId), { ...membership });
    }
    async remove(organizationId, userId) {
        this.rows.delete(this.key(organizationId, userId));
    }
}
exports.InMemoryMembershipRepository = InMemoryMembershipRepository;
class InMemoryInvitationRepository {
    rows = new Map();
    async findByHash(hash) {
        return [...this.rows.values()].find((invitation) => invitation.tokenHash === hash) ?? null;
    }
    async findPending(organizationId, email) {
        return ([...this.rows.values()].find((invitation) => invitation.organizationId === organizationId &&
            invitation.email.toLowerCase() === email.toLowerCase() &&
            !invitation.acceptedAt &&
            !invitation.revokedAt) ?? null);
    }
    async listForOrganization(organizationId) {
        return [...this.rows.values()].filter((invitation) => invitation.organizationId === organizationId);
    }
    async save(invitation) {
        this.rows.set(invitation.id, { ...invitation });
    }
}
exports.InMemoryInvitationRepository = InMemoryInvitationRepository;
//# sourceMappingURL=in-memory-repositories.js.map