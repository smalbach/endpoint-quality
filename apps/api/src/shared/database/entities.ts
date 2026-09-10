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
import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "users" })
export class UserEntity {
  @PrimaryColumn("uuid") id: string;
  /** Stored lower-cased, and unique on that form: two accounts differing only in capitalisation
   * are one account to every person who ever types one of them. */
  @Index({ unique: true }) @Column({ type: "varchar", length: 320 }) email: string;
  @Column({ type: "varchar", length: 200 }) name: string;
  @Column({ type: "varchar", length: 400 }) passwordDigest: string;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
}

@Entity({ name: "organizations" })
export class OrganizationEntity {
  @PrimaryColumn("uuid") id: string;
  @Column({ type: "varchar", length: 200 }) name: string;
  @Index({ unique: true }) @Column({ type: "varchar", length: 80 }) slug: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
}

@Entity({ name: "memberships" })
export class MembershipEntity {
  @PrimaryColumn("uuid") organizationId: string;
  @PrimaryColumn("uuid") userId: string;
  @Column({ type: "varchar", length: 20 }) role: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
}

@Entity({ name: "invitations" })
export class InvitationEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") organizationId: string;
  @Column({ type: "varchar", length: 320 }) email: string;
  @Column({ type: "varchar", length: 20 }) role: string;
  @Index({ unique: true }) @Column({ type: "varchar", length: 64 }) tokenHash: string;
  @Column("uuid") invitedBy: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) expiresAt: Date;
  @Column({ type: "timestamptz", nullable: true }) acceptedAt: Date | null;
  @Column({ type: "timestamptz", nullable: true }) revokedAt: Date | null;
}

/**
 * One row per refresh token ever issued, spent ones included.
 *
 * Spent tokens are kept and marked rather than deleted: reuse detection needs to tell "this
 * token was already used" apart from "this token never existed", and a deleted row cannot.
 */
@Entity({ name: "refresh_tokens" })
export class RefreshTokenEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") userId: string;
  /** Every rotation of one login shares this. Revoking a compromised chain is one statement
   * against this column, which is what closing the window on a stolen token requires. */
  @Index() @Column("uuid") sessionId: string;
  @Index({ unique: true }) @Column({ type: "varchar", length: 64 }) tokenHash: string;
  @Column({ type: "timestamptz" }) expiresAt: Date;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz", nullable: true }) usedAt: Date | null;
  @Column({ type: "timestamptz", nullable: true }) revokedAt: Date | null;
  @Column({ type: "varchar", length: 64, nullable: true }) replacedByHash: string | null;
}

@Entity({ name: "api_tokens" })
export class ApiTokenEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") organizationId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Index({ unique: true }) @Column({ type: "varchar", length: 64 }) tokenHash: string;
  /** Six characters and an ellipsis, so two tokens can be told apart in a list without either
   * being recoverable. The plaintext is shown exactly once, when it is created. */
  @Column({ type: "varchar", length: 20 }) preview: string;
  @Column("uuid") createdBy: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz", nullable: true }) lastUsedAt: Date | null;
  @Column({ type: "timestamptz", nullable: true }) revokedAt: Date | null;
}

export const ENTITIES = [UserEntity, OrganizationEntity, MembershipEntity, InvitationEntity, RefreshTokenEntity, ApiTokenEntity];
