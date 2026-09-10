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
  /** The request body's JSON Schema, dereferenced at import. Null for operations that take no
   * body, take one that is not JSON, or were imported before this column existed — all three
   * mean the same thing to the engine: nothing to derive a payload from. */
  @Column({ type: "jsonb", nullable: true }) requestSchema: unknown;
  /** The document order, so "contrato" ordering survives a round trip through the database
   * instead of depending on whatever order Postgres returns rows in. */
  @Column({ type: "int" }) position: number;
}


/**
 * Where a project's contract is exercised: a base URL, and the credentials to present there.
 *
 * `writesAllowed` is the flag that keeps a production target from being written to by a matrix
 * that includes POSTs and DELETEs. It is enforced in the engine rather than in the UI, because a
 * run can be launched from CI with no UI in sight.
 */
@Entity({ name: "environments" })
export class EnvironmentEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 80 }) name: string;
  @Column({ type: "text" }) baseUrl: string;
  /** Where the live OpenAPI document is served, when it is not `${baseUrl}/openapi.json`. The
   * schema assertion reads it during a run. */
  @Column({ type: "text", nullable: true }) specUrl: string | null;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) variables: Record<string, string>;
  @Column({ type: "boolean", default: false }) writesAllowed: boolean;
  /** Whether the target actually enforces authorization. Against one that grants every scope to
   * everyone, the 401/403 cases fail for a reason that has nothing to do with the endpoint. */
  @Column({ type: "boolean", default: false }) authEnforced: boolean;
  @Column({ type: "timestamptz" }) createdAt: Date;
}

/**
 * A credential the runner presents to a target.
 *
 * `role` is what generalizes the coupled dashboard's three hard-coded fields (`token`,
 * `readToken`, `apiKey`) into something a project defines: `primary` is the working credential,
 * `insufficient` is the one that authenticates but falls short of the scope — that is the 403 —
 * and `alternate` is a scheme the operation does not declare, which is a 401 and not a 403.
 *
 * The secret is AES-256-GCM ciphertext and is never returned by any query. The column name says
 * so, because a column called `secret` invites somebody to select it.
 */
@Entity({ name: "environment_credentials" })
export class EnvironmentCredentialEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") environmentId: string;
  @Column({ type: "varchar", length: 80 }) name: string;
  @Column({ type: "varchar", length: 20 }) role: string;
  @Column({ type: "varchar", length: 40 }) kind: string;
  /** The header the credential travels in, for the kinds that need naming — `X-API-Key` and
   * friends. Bearer and Basic imply `Authorization`. */
  @Column({ type: "varchar", length: 80, nullable: true }) headerName: string | null;
  @Column({ type: "text" }) secretCiphertext: string;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) scopes: string[];
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
}

/**
 * One document per configuration section.
 *
 * Documents rather than a table per concept, which is a departure from the plan's sketch and a
 * deliberate one: order is data — budget rules and conditional scenarios are matched first-hit —
 * and an array says that better than a `position` column. A section is also written as one unit,
 * so a half-applied edit is not a state that can exist. What Postgres cannot enforce here, the
 * zod schemas in `@eq/runner-core` do on every write.
 */
@Entity({ name: "project_config" })
export class ProjectConfigEntity {
  @PrimaryColumn("uuid") projectId: string;
  @PrimaryColumn({ type: "varchar", length: 40 }) section: string;
  @Column({ type: "jsonb" }) data: unknown;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}


/**
 * One execution of a matrix.
 *
 * Persisted, which is capability the coupled dashboard did not have: there the result lived in
 * `useState` and died on refresh. With rows there is history, trend, and an answer to "was this
 * green last Tuesday" — for no extra work beyond storing it.
 */
@Entity({ name: "runs" })
export class RunEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "uuid", nullable: true }) environmentId: string | null;
  /** The snapshot the run asserted against. A run is only interpretable next to the contract it
   * was measured on, so the version is recorded rather than looked up later. */
  @Column("uuid") specVersionId: string;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "jsonb" }) plan: unknown;
  @Column({ type: "jsonb" }) totals: unknown;
  @Column({ type: "varchar", length: 20 }) triggeredByKind: string;
  @Column("uuid") triggeredBy: string;
  @Column({ type: "timestamptz" }) startedAt: Date;
  @Column({ type: "timestamptz", nullable: true }) finishedAt: Date | null;
  @Column({ type: "text", nullable: true }) error: string | null;
}

/** One scenario of one operation, within a run. */
@Entity({ name: "run_cases" })
export class RunCaseEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") runId: string;
  @Column({ type: "varchar", length: 200 }) operationId: string;
  @Column({ type: "varchar", length: 200 }) scenarioId: string;
  @Column({ type: "varchar", length: 10 }) method: string;
  @Column({ type: "text" }) path: string;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "int" }) position: number;
  @Column({ type: "int", nullable: true }) durationMs: number | null;
  @Column({ type: "timestamptz", nullable: true }) startedAt: Date | null;
  @Column({ type: "timestamptz", nullable: true }) finishedAt: Date | null;
}

/**
 * One HTTP request inside a case, with what was sent, what came back and every assertion.
 *
 * The table that grows. A `create-read` case is three of these and each holds a full response
 * body, so retention is a policy and not an afterthought: `RETENTION_BODIES_DAYS` empties the
 * three payload columns and stamps `prunedAt`, `RETENTION_RUNS_DAYS` removes the run entirely.
 * The verdict outlives the payload on purpose — an assertion list and a label are a few hundred
 * bytes and are what makes a run from March still answer «was this green, and what failed».
 *
 * Credentials are masked before the row is written, never on the way out: a redaction applied at
 * read time is one query away from being forgotten.
 */
@Entity({ name: "run_steps" })
export class RunStepEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") runCaseId: string;
  @Column({ type: "int" }) index: number;
  @Column({ type: "varchar", length: 20 }) purpose: string;
  @Column({ type: "varchar", length: 200 }) label: string;
  @Column({ type: "jsonb", nullable: true }) request: unknown;
  @Column({ type: "jsonb", nullable: true }) expected: unknown;
  @Column({ type: "jsonb", nullable: true }) actual: unknown;
  @Column({ type: "jsonb" }) assertions: unknown;
  @Column({ type: "jsonb", nullable: true }) latency: unknown;
  @Column({ type: "boolean" }) ok: boolean;
  @Column({ type: "int" }) durationMs: number;
  /** When the three payload columns were emptied by a retention sweep. Null means they were never
   * swept, which is not the same fact as a body that was never there. */
  @Column({ type: "timestamptz", nullable: true }) prunedAt: Date | null;
}

export const ENTITIES = [
  UserEntity, OrganizationEntity, MembershipEntity, InvitationEntity, RefreshTokenEntity, ApiTokenEntity,
  ProjectEntity, SpecSourceEntity, SpecVersionEntity, SpecOperationEntity,
  EnvironmentEntity, EnvironmentCredentialEntity, ProjectConfigEntity,
  RunEntity, RunCaseEntity, RunStepEntity,
];
