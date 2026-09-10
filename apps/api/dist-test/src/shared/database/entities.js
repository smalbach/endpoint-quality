"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITIES = exports.SpecOperationEntity = exports.SpecVersionEntity = exports.SpecSourceEntity = exports.ProjectEntity = exports.ApiTokenEntity = exports.RefreshTokenEntity = exports.InvitationEntity = exports.MembershipEntity = exports.OrganizationEntity = exports.UserEntity = void 0;
/**
 * The tables, as TypeORM entities.
 *
 * They live in `shared/database` rather than inside each module because TypeORM needs one
 * registry of entities and one migration history, and splitting that across modules buys
 * tidiness at the cost of a relation graph nobody can see at once. The *domain* stays clean:
 * these classes are never imported by a handler, only by the repositories that adapt them.
 *
 * Two conventions worth stating:
 *
 * - **`organizationId` is on every tenant-owned row from the first migration.** Adding it later
 *   is a data migration with a real chance of mixing two customers' data.
 * - **Secrets are stored as hashes or ciphertext and named accordingly.** A column called
 *   `token` invites somebody to return it; `tokenHash` does not.
 */
const typeorm_1 = require("typeorm");
let UserEntity = class UserEntity {
    id;
    /** Stored lower-cased, and unique on that form: two accounts differing only in capitalisation
     * are one account to every person who ever types one of them. */
    email;
    name;
    passwordDigest;
    status;
    createdAt;
};
exports.UserEntity = UserEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], UserEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)({ unique: true }),
    (0, typeorm_1.Column)({ type: "varchar", length: 320 }),
    __metadata("design:type", String)
], UserEntity.prototype, "email", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 200 }),
    __metadata("design:type", String)
], UserEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 400 }),
    __metadata("design:type", String)
], UserEntity.prototype, "passwordDigest", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], UserEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], UserEntity.prototype, "createdAt", void 0);
exports.UserEntity = UserEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "users" })
], UserEntity);
let OrganizationEntity = class OrganizationEntity {
    id;
    name;
    slug;
    createdAt;
};
exports.OrganizationEntity = OrganizationEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], OrganizationEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 200 }),
    __metadata("design:type", String)
], OrganizationEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Index)({ unique: true }),
    (0, typeorm_1.Column)({ type: "varchar", length: 80 }),
    __metadata("design:type", String)
], OrganizationEntity.prototype, "slug", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], OrganizationEntity.prototype, "createdAt", void 0);
exports.OrganizationEntity = OrganizationEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "organizations" })
], OrganizationEntity);
let MembershipEntity = class MembershipEntity {
    organizationId;
    userId;
    role;
    createdAt;
};
exports.MembershipEntity = MembershipEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], MembershipEntity.prototype, "organizationId", void 0);
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], MembershipEntity.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], MembershipEntity.prototype, "role", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], MembershipEntity.prototype, "createdAt", void 0);
exports.MembershipEntity = MembershipEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "memberships" })
], MembershipEntity);
let InvitationEntity = class InvitationEntity {
    id;
    organizationId;
    email;
    role;
    tokenHash;
    invitedBy;
    createdAt;
    expiresAt;
    acceptedAt;
    revokedAt;
};
exports.InvitationEntity = InvitationEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], InvitationEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], InvitationEntity.prototype, "organizationId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 320 }),
    __metadata("design:type", String)
], InvitationEntity.prototype, "email", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], InvitationEntity.prototype, "role", void 0);
__decorate([
    (0, typeorm_1.Index)({ unique: true }),
    (0, typeorm_1.Column)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], InvitationEntity.prototype, "tokenHash", void 0);
__decorate([
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], InvitationEntity.prototype, "invitedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], InvitationEntity.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], InvitationEntity.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], InvitationEntity.prototype, "acceptedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], InvitationEntity.prototype, "revokedAt", void 0);
exports.InvitationEntity = InvitationEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "invitations" })
], InvitationEntity);
/**
 * One row per refresh token ever issued, spent ones included.
 *
 * Spent tokens are kept and marked rather than deleted: reuse detection needs to tell "this
 * token was already used" apart from "this token never existed", and a deleted row cannot.
 */
let RefreshTokenEntity = class RefreshTokenEntity {
    id;
    userId;
    /** Every rotation of one login shares this. Revoking a compromised chain is one statement
     * against this column, which is what closing the window on a stolen token requires. */
    sessionId;
    tokenHash;
    expiresAt;
    createdAt;
    usedAt;
    revokedAt;
    replacedByHash;
};
exports.RefreshTokenEntity = RefreshTokenEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], RefreshTokenEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], RefreshTokenEntity.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], RefreshTokenEntity.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Index)({ unique: true }),
    (0, typeorm_1.Column)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], RefreshTokenEntity.prototype, "tokenHash", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], RefreshTokenEntity.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], RefreshTokenEntity.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], RefreshTokenEntity.prototype, "usedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], RefreshTokenEntity.prototype, "revokedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 64, nullable: true }),
    __metadata("design:type", Object)
], RefreshTokenEntity.prototype, "replacedByHash", void 0);
exports.RefreshTokenEntity = RefreshTokenEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "refresh_tokens" })
], RefreshTokenEntity);
let ApiTokenEntity = class ApiTokenEntity {
    id;
    organizationId;
    name;
    tokenHash;
    /** Six characters and an ellipsis, so two tokens can be told apart in a list without either
     * being recoverable. The plaintext is shown exactly once, when it is created. */
    preview;
    createdBy;
    createdAt;
    lastUsedAt;
    revokedAt;
};
exports.ApiTokenEntity = ApiTokenEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "organizationId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 120 }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Index)({ unique: true }),
    (0, typeorm_1.Column)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "tokenHash", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "preview", void 0);
__decorate([
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], ApiTokenEntity.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], ApiTokenEntity.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], ApiTokenEntity.prototype, "lastUsedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], ApiTokenEntity.prototype, "revokedAt", void 0);
exports.ApiTokenEntity = ApiTokenEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "api_tokens" })
], ApiTokenEntity);
/**
 * A project: one contract, its environments, and everything configured around them.
 *
 * `archivedAt` rather than a delete. A project owns runs, and runs are the evidence somebody
 * produced on a date — deleting the project to tidy a list would destroy the history that made
 * the tool worth having.
 */
let ProjectEntity = class ProjectEntity {
    id;
    organizationId;
    name;
    /** Unique **per organization**, not globally: two customers may both have a project called
     * `catalog`, and forcing a global namespace would leak that the other one exists. */
    slug;
    description;
    createdBy;
    createdAt;
    archivedAt;
    /** The version the runs use. Null until the first import succeeds. */
    activeSpecVersionId;
};
exports.ProjectEntity = ProjectEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], ProjectEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], ProjectEntity.prototype, "organizationId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 200 }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 80 }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "slug", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text", default: "" }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], ProjectEntity.prototype, "createdBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], ProjectEntity.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz", nullable: true }),
    __metadata("design:type", Object)
], ProjectEntity.prototype, "archivedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "uuid", nullable: true }),
    __metadata("design:type", Object)
], ProjectEntity.prototype, "activeSpecVersionId", void 0);
exports.ProjectEntity = ProjectEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "projects" })
], ProjectEntity);
/** Where a contract comes from, so a re-import needs no arguments and a drift check can run on
 * a schedule. */
let SpecSourceEntity = class SpecSourceEntity {
    id;
    projectId;
    /** `url`, `upload` or `inline`. */
    kind;
    location;
    /** Credentials for a contract behind auth, encrypted. Never returned by any query. */
    headersCiphertext;
    createdAt;
};
exports.SpecSourceEntity = SpecSourceEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], SpecSourceEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], SpecSourceEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], SpecSourceEntity.prototype, "kind", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text", default: "" }),
    __metadata("design:type", String)
], SpecSourceEntity.prototype, "location", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text", nullable: true }),
    __metadata("design:type", Object)
], SpecSourceEntity.prototype, "headersCiphertext", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], SpecSourceEntity.prototype, "createdAt", void 0);
exports.SpecSourceEntity = SpecSourceEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "spec_sources" })
], SpecSourceEntity);
/**
 * One import, frozen.
 *
 * The raw document is kept, not just the operations parsed out of it: schema validation during a
 * run reads the document itself, and a contract that changes under a running matrix is the exact
 * failure this tool exists to detect — it cannot also be its mode of operation.
 */
let SpecVersionEntity = class SpecVersionEntity {
    id;
    projectId;
    sourceId;
    /** SHA-256 of the raw bytes. Two imports of an unchanged document share it, which is how a
     * scheduled drift check stays cheap. */
    hash;
    raw;
    format;
    openapiVersion;
    title;
    contractVersion;
    operationCount;
    problems;
    importedBy;
    importedAt;
};
exports.SpecVersionEntity = SpecVersionEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "uuid", nullable: true }),
    __metadata("design:type", Object)
], SpecVersionEntity.prototype, "sourceId", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: "varchar", length: 64 }),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "hash", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text" }),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "raw", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "format", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 20 }),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "openapiVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 200 }),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 50 }),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "contractVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "int" }),
    __metadata("design:type", Number)
], SpecVersionEntity.prototype, "operationCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "jsonb" }),
    __metadata("design:type", Object)
], SpecVersionEntity.prototype, "problems", void 0);
__decorate([
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], SpecVersionEntity.prototype, "importedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "timestamptz" }),
    __metadata("design:type", Date)
], SpecVersionEntity.prototype, "importedAt", void 0);
exports.SpecVersionEntity = SpecVersionEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "spec_versions" })
], SpecVersionEntity);
/**
 * The flattened operation table of one imported version.
 *
 * Rows rather than a JSON blob on the version, because the operation list is queried, filtered
 * by tag and joined against per-operation configuration. It replaces the generated
 * `contract-operations.ts` that used to be compiled into the dashboard's bundle.
 */
let SpecOperationEntity = class SpecOperationEntity {
    id;
    specVersionId;
    operationId;
    method;
    path;
    summary;
    tag;
    statuses;
    parameters;
    security;
    derivedId;
    /** The document order, so "contrato" ordering survives a round trip through the database
     * instead of depending on whatever order Postgres returns rows in. */
    position;
};
exports.SpecOperationEntity = SpecOperationEntity;
__decorate([
    (0, typeorm_1.PrimaryColumn)("uuid"),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)("uuid"),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "specVersionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 200 }),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "operationId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 10 }),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "method", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text" }),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "path", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text", default: "" }),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "summary", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 120, default: "" }),
    __metadata("design:type", String)
], SpecOperationEntity.prototype, "tag", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "jsonb" }),
    __metadata("design:type", Array)
], SpecOperationEntity.prototype, "statuses", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "jsonb" }),
    __metadata("design:type", Array)
], SpecOperationEntity.prototype, "parameters", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "jsonb" }),
    __metadata("design:type", Array)
], SpecOperationEntity.prototype, "security", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "boolean", default: false }),
    __metadata("design:type", Boolean)
], SpecOperationEntity.prototype, "derivedId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "int" }),
    __metadata("design:type", Number)
], SpecOperationEntity.prototype, "position", void 0);
exports.SpecOperationEntity = SpecOperationEntity = __decorate([
    (0, typeorm_1.Entity)({ name: "spec_operations" })
], SpecOperationEntity);
exports.ENTITIES = [UserEntity, OrganizationEntity, MembershipEntity, InvitationEntity, RefreshTokenEntity, ApiTokenEntity, ProjectEntity, SpecSourceEntity, SpecVersionEntity, SpecOperationEntity];
//# sourceMappingURL=entities.js.map