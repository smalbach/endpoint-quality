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
exports.ENTITIES = exports.ApiTokenEntity = exports.RefreshTokenEntity = exports.InvitationEntity = exports.MembershipEntity = exports.OrganizationEntity = exports.UserEntity = void 0;
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
exports.ENTITIES = [UserEntity, OrganizationEntity, MembershipEntity, InvitationEntity, RefreshTokenEntity, ApiTokenEntity];
//# sourceMappingURL=entities.js.map