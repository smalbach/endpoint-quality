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


/**
 * A project: one contract, its environments, and everything configured around them.
 *
 * `archivedAt` rather than a delete. A project owns runs, and runs are the evidence somebody
 * produced on a date — deleting the project to tidy a list would destroy the history that made
 * the tool worth having.
 */
@Entity({ name: "projects" })
export class ProjectEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") organizationId: string;
  @Column({ type: "varchar", length: 200 }) name: string;
  /** Unique **per organization**, not globally: two customers may both have a project called
   * `catalog`, and forcing a global namespace would leak that the other one exists. */
  @Column({ type: "varchar", length: 80 }) slug: string;
  @Column({ type: "text", default: "" }) description: string;
  @Column("uuid") createdBy: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz", nullable: true }) archivedAt: Date | null;
  /** The version the runs use. Null until the first import succeeds. */
  @Column({ type: "uuid", nullable: true }) activeSpecVersionId: string | null;
}

/** Where a contract comes from, so a re-import needs no arguments and a drift check can run on
 * a schedule. */
@Entity({ name: "spec_sources" })
export class SpecSourceEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  /** `url`, `upload` or `inline`. */
  @Column({ type: "varchar", length: 20 }) kind: string;
  @Column({ type: "text", default: "" }) location: string;
  /** Credentials for a contract behind auth, encrypted. Never returned by any query. */
  @Column({ type: "text", nullable: true }) headersCiphertext: string | null;
  @Column({ type: "timestamptz" }) createdAt: Date;
}

/**
 * One import, frozen.
 *
 * The raw document is kept, not just the operations parsed out of it: schema validation during a
 * run reads the document itself, and a contract that changes under a running matrix is the exact
 * failure this tool exists to detect — it cannot also be its mode of operation.
 */
@Entity({ name: "spec_versions" })
export class SpecVersionEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "uuid", nullable: true }) sourceId: string | null;
  /** SHA-256 of the raw bytes. Two imports of an unchanged document share it, which is how a
   * scheduled drift check stays cheap. */
  @Index() @Column({ type: "varchar", length: 64 }) hash: string;
  @Column({ type: "text" }) raw: string;
  @Column({ type: "varchar", length: 20 }) format: string;
  @Column({ type: "varchar", length: 20 }) openapiVersion: string;
  @Column({ type: "varchar", length: 200 }) title: string;
  @Column({ type: "varchar", length: 50 }) contractVersion: string;
  @Column({ type: "int" }) operationCount: number;
  @Column({ type: "jsonb" }) problems: unknown;
  @Column("uuid") importedBy: string;
  @Column({ type: "timestamptz" }) importedAt: Date;
}

/**
 * The flattened operation table of one imported version.
 *
 * Rows rather than a JSON blob on the version, because the operation list is queried, filtered
 * by tag and joined against per-operation configuration. It replaces the generated
 * `contract-operations.ts` that used to be compiled into the dashboard's bundle.
 */
@Entity({ name: "spec_operations" })
export class SpecOperationEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") specVersionId: string;
  @Column({ type: "varchar", length: 200 }) operationId: string;
  @Column({ type: "varchar", length: 10 }) method: string;
  @Column({ type: "text" }) path: string;
  @Column({ type: "text", default: "" }) summary: string;
  @Column({ type: "varchar", length: 120, default: "" }) tag: string;
  @Column({ type: "jsonb" }) statuses: number[];
  @Column({ type: "jsonb" }) parameters: string[];
  @Column({ type: "jsonb" }) security: string[];
  @Column({ type: "boolean", default: false }) derivedId: boolean;
  /** The document order, so "contrato" ordering survives a round trip through the database
   * instead of depending on whatever order Postgres returns rows in. */
  @Column({ type: "int" }) position: number;
}

export const ENTITIES = [UserEntity, OrganizationEntity, MembershipEntity, InvitationEntity, RefreshTokenEntity, ApiTokenEntity, ProjectEntity, SpecSourceEntity, SpecVersionEntity, SpecOperationEntity];
