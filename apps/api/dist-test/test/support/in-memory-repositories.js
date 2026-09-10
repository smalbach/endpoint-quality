"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryConfigRepository = exports.InMemoryEnvironmentRepository = exports.InMemorySpecRepository = exports.InMemoryProjectRepository = exports.InMemoryInvitationRepository = exports.InMemoryMembershipRepository = exports.InMemoryOrganizationRepository = exports.InMemoryApiTokenRepository = exports.InMemoryRefreshTokenRepository = exports.InMemoryUserRepository = void 0;
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
class InMemoryProjectRepository {
    rows = new Map();
    async findById(id) {
        return this.rows.get(id) ?? null;
    }
    async findBySlug(organizationId, slug) {
        return [...this.rows.values()].find((project) => project.organizationId === organizationId && project.slug === slug) ?? null;
    }
    async listForOrganization(organizationId, includeArchived) {
        return [...this.rows.values()].filter((project) => project.organizationId === organizationId && (includeArchived || !project.archivedAt));
    }
    async save(project) {
        this.rows.set(project.id, { ...project });
    }
}
exports.InMemoryProjectRepository = InMemoryProjectRepository;
class InMemorySpecRepository {
    versions = new Map();
    operations = new Map();
    sources = new Map();
    async findVersionById(id) {
        return this.versions.get(id) ?? null;
    }
    async findVersionByHash(projectId, hash) {
        return [...this.versions.values()].find((version) => version.projectId === projectId && version.hash === hash) ?? null;
    }
    async listVersions(projectId) {
        return [...this.versions.values()]
            .filter((version) => version.projectId === projectId)
            .sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime())
            // `raw` is dropped here too, so a test that asserts the listing never ships the document
            // is checking the same contract the SQL repository implements with a `select`.
            .map(({ raw, ...summary }) => summary);
    }
    async saveVersion(version, operations) {
        this.versions.set(version.id, { ...version });
        this.operations.set(version.id, operations.map((operation) => ({ ...operation })));
    }
    async listOperations(specVersionId) {
        return [...(this.operations.get(specVersionId) ?? [])].sort((a, b) => a.position - b.position);
    }
    async saveSource(source) {
        this.sources.set(source.id, { ...source });
    }
    async deleteVersion(id) {
        this.versions.delete(id);
        this.operations.delete(id);
    }
}
exports.InMemorySpecRepository = InMemorySpecRepository;
class InMemoryEnvironmentRepository {
    rows = new Map();
    credentials = new Map();
    key(environmentId, role) {
        return `${environmentId}:${role}`;
    }
    async findById(id) {
        return this.rows.get(id) ?? null;
    }
    async findByName(projectId, name) {
        return [...this.rows.values()].find((environment) => environment.projectId === projectId && environment.name === name) ?? null;
    }
    async listForProject(projectId) {
        return [...this.rows.values()].filter((environment) => environment.projectId === projectId);
    }
    async save(environment) {
        this.rows.set(environment.id, { ...environment });
    }
    async remove(id) {
        this.rows.delete(id);
        // The cascade the migration declares, honoured here too: a fake that leaves the credentials
        // behind would let a test pass that the database would fail.
        for (const [key, credential] of this.credentials)
            if (credential.environmentId === id)
                this.credentials.delete(key);
    }
    async listCredentials(environmentId) {
        return [...this.credentials.values()].filter((credential) => credential.environmentId === environmentId);
    }
    async findCredential(environmentId, role) {
        return this.credentials.get(this.key(environmentId, role)) ?? null;
    }
    async saveCredential(credential) {
        // Keyed by (environment, role) rather than by id, which is the unique index the migration
        // declares: a map keyed by id would happily hold two `primary` credentials.
        this.credentials.set(this.key(credential.environmentId, credential.role), { ...credential });
    }
    async removeCredential(environmentId, role) {
        this.credentials.delete(this.key(environmentId, role));
    }
}
exports.InMemoryEnvironmentRepository = InMemoryEnvironmentRepository;
class InMemoryConfigRepository {
    rows = new Map();
    key(projectId, section) {
        return `${projectId}:${section}`;
    }
    async listSections(projectId) {
        return [...this.rows.values()].filter((row) => row.projectId === projectId).sort((a, b) => a.section.localeCompare(b.section));
    }
    async findSection(projectId, section) {
        return this.rows.get(this.key(projectId, section)) ?? null;
    }
    async saveSection(row) {
        this.rows.set(this.key(row.projectId, row.section), { ...row });
    }
    async deleteSection(projectId, section) {
        this.rows.delete(this.key(projectId, section));
    }
}
exports.InMemoryConfigRepository = InMemoryConfigRepository;
//# sourceMappingURL=in-memory-repositories.js.map