"use strict";
/**
 * Tenancy: who owns a project, and what each member is allowed to do to it.
 *
 * `organizationId` is on every resource from the first migration and not added later. Bolting
 * multi-tenancy onto a single-tenant schema is a data migration with a real chance of leaking
 * one customer's runs into another's; putting the column there from the start is one column.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLES = void 0;
exports.atLeast = atLeast;
exports.slugify = slugify;
exports.wouldOrphanOrganization = wouldOrphanOrganization;
/**
 * Roles, ordered. The ladder is what makes the guard a comparison instead of a table of
 * exceptions, and the boundaries are drawn where the *risk* changes, not where the CRUD verbs do:
 *
 * - `viewer` reads projects and runs;
 * - `editor` edits the matrix and launches read-only runs;
 * - `admin` manages environments and credentials, and launches runs that write to a target —
 *   the two capabilities that can damage something outside this system;
 * - `owner` additionally disposes of the organization itself.
 */
exports.ROLES = ["viewer", "editor", "admin", "owner"];
const RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
function atLeast(role, required) {
    return RANK[role] >= RANK[required];
}
/** URL-safe, stable, and unique per organization. Accents are folded rather than dropped so
 * "Cañón" and "Canon" do not collide silently into different slugs that look the same. */
function slugify(name) {
    return name
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "org";
}
/**
 * The last owner cannot be demoted or removed.
 *
 * Not a nicety: an organization with no owner has no one who can add one, so the projects,
 * environments and stored credentials inside it become unreachable by anybody. The check lives
 * in the domain because both the "change role" and the "remove member" paths need it and they
 * are different handlers.
 */
function wouldOrphanOrganization(memberships, userId, nextRole) {
    const owners = memberships.filter((membership) => membership.role === "owner");
    const isOnlyOwner = owners.length === 1 && owners[0].userId === userId;
    return isOnlyOwner && nextRole !== "owner";
}
//# sourceMappingURL=model.js.map