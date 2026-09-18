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
import type { RequestBody } from "@eq/runner-core";

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
  @Column({ type: "integer", default: 0 }) failedLoginAttempts: number;
  @Column({ type: "timestamptz", nullable: true }) lockedUntil: Date | null;
}

/** A «forgot my password» link. Only its hash is kept, and using one spends every other. */
@Entity({ name: "password_reset_tokens" })
export class PasswordResetTokenEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") userId: string;
  @Index({ unique: true }) @Column({ type: "varchar", length: 64 }) tokenHash: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) expiresAt: Date;
  @Column({ type: "timestamptz", nullable: true }) usedAt: Date | null;
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
  /** The environment every screen starts from. Null only while the project has none. */
  @Column({ type: "uuid", nullable: true }) activeEnvironmentId: string | null;
  @Column({ type: "varchar", length: 2000, default: "" }) baseUrl: string;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) tags: string[];
  /** `none`, `bearer`, `basic` or `api_key`. */
  @Column({ type: "varchar", length: 20, default: "none" }) authType: string;
  /** The half of the login that is not secret, and the names of the secrets that exist. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) authSettings: Record<string, unknown>;
  /** The token, password, key and login body, as one AES-256-GCM payload. Never returned. */
  @Column({ type: "text", nullable: true }) authSecretCiphertext: string | null;
  /** Deleted for everybody; the runs stay. */
  @Column({ type: "timestamptz", nullable: true }) deletedAt: Date | null;
}

/**
 * Una bifurcación: su original, y la última foto que los dos tuvieron en común.
 *
 * Una fila por bifurcación, con la bifurcación como clave: un proyecto sale de un solo original.
 * `base` y `lineage` son `jsonb` porque se escriben enteros en cada sincronización y solo se leen
 * enteros para comparar. La foto no lleva secretos —ver `fork-snapshot.ts`—.
 */
@Entity({ name: "project_forks" })
export class ProjectForkEntity {
  @PrimaryColumn("uuid") forkProjectId: string;
  @Index() @Column("uuid") parentProjectId: string;
  @Index() @Column("uuid") organizationId: string;
  @Column("uuid") createdBy: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) syncedAt: Date;
  @Column({ type: "int", default: 1 }) version: number;
  @Column({ type: "jsonb" }) base: Record<string, unknown>;
  @Column({ type: "jsonb" }) lineage: Record<string, unknown>;
}

/** Una solicitud de fusión de una bifurcación en su original. Ver `ForkMergeRequests1700000033000`. */
@Entity({ name: "fork_merge_requests" })
export class ForkMergeRequestEntity {
  @PrimaryColumn("uuid") id: string;
  @Column("uuid") organizationId: string;
  @Column("uuid") forkProjectId: string;
  @Column("uuid") parentProjectId: string;
  @Column({ type: "varchar", length: 200 }) title: string;
  @Column({ type: "text", default: "" }) description: string;
  @Column({ type: "varchar", length: 12 }) status: string;
  @Column("uuid") createdBy: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column({ type: "jsonb" }) diff: unknown[];
  @Column({ type: "int" }) diffVersion: number;
  @Column({ type: "uuid", nullable: true }) decidedBy: string | null;
  @Column({ type: "timestamptz", nullable: true }) decidedAt: Date | null;
  @Column({ type: "int", nullable: true }) mergedVersion: number | null;
}

/** Una línea del hilo de una solicitud: un comentario o una decisión. Solo crece. */
@Entity({ name: "fork_merge_request_events" })
export class ForkMergeRequestEventEntity {
  @PrimaryColumn("uuid") id: string;
  @Column("uuid") requestId: string;
  @Column("uuid") organizationId: string;
  @Column("uuid") authorId: string;
  @Column({ type: "varchar", length: 12 }) kind: string;
  @Column({ type: "text", default: "" }) body: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
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
  /** `{ initial, current, sensitive }` per name. A sensitive one holds ciphertext in both values;
   * nothing here is ever read straight into a run, `resolveVariables` is. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) variables: Record<
    string,
    { initial: string; current: string; sensitive: boolean }
  >;
  /** Switched off: kept so that turning one back on is a click and not a retype, and separate so
   * that `variables` never needs filtering before it reaches the engine. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) disabledVariables: Record<
    string,
    { initial: string; current: string; sensitive: boolean }
  >;
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
  /** Whose problem it is: `network`, `config`, `server`, `status`, `contract`, `check`, `flow` or
   * `latency`. Null while it passed, was skipped, or has not run. A column and not something
   * derived at read time, because it is what a list of forty red rows is sorted and counted by. */
  @Column({ type: "varchar", length: 20, nullable: true }) failure: string | null;
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

/**
 * A reusable request: one operation, with the parameters, payload, credential and expected status
 * somebody decided are worth sending again.
 *
 * A row and not a document inside a workflow, because reuse is the whole point: several flows name
 * the same template, editing it has to reach all of them, and «delete this one» has to be a
 * question the database can answer.
 */
@Entity({ name: "request_templates" })
export class RequestTemplateEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "varchar", length: 200 }) operationId: string;
  @Column({ type: "text", nullable: true }) description: string | null;
  @Column({ type: "int" }) expectedStatus: number;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) parameters: Record<string, string>;
  /** Switched off, and kept: a second map beside the first, the way an environment stores its
   * disabled variables. A name is in one or the other, never in both. */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) disabledParameters: Record<string, string>;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) headers: Record<string, string>;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) disabledHeaders: Record<string, string>;
  /** `{ type: "none" }` and a `json` body of `{}` are different: no payload at all, versus an
   * empty one somebody chose to send. Not nullable — «none» is a value, and two ways to say it is
   * how the two end up meaning something slightly different. */
  @Column({ type: "jsonb", default: () => `'{"type":"none"}'::jsonb` }) body: RequestBody;
  @Column({ type: "varchar", length: 20, default: "default" }) auth: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}

/**
 * A directed flow over those requests, stored as one document.
 *
 * The steps, their edges and their canvas coordinates are `definition` and not three tables on
 * purpose: the unit of change is the whole graph. Saving nodes and edges separately can produce
 * «node deleted, edge still pointing at it», which is a state that must not exist — and the
 * property worth enforcing, that the graph has no cycle, is not one Postgres can enforce anyway.
 * The zod schema in `@eq/runner-core` does it on every write.
 */
@Entity({ name: "workflows" })
export class WorkflowEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "text", nullable: true }) description: string | null;
  /** draft / ready / archived. A short varchar and not an enum type: the set lives in the domain
   * and a Postgres enum would be a second copy that a migration has to alter to add a value. */
  @Column({ type: "varchar", length: 16, default: "ready" }) status: string;
  @Column({ type: "jsonb", default: () => `'{"steps":[]}'::jsonb` }) definition: { steps: unknown[] };
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}

/**
 * A table of values a flow is run once per row of.
 *
 * Rows in a `jsonb` array rather than a table of cells: the unit of change is the whole table —
 * somebody pastes a CSV and replaces it — and a cell has no identity anybody refers to. Attached
 * to one flow because a dataset's columns only mean anything next to the steps that spend them:
 * the same `{{dataset.sku}}` in another flow would be a coincidence, not reuse.
 */
@Entity({ name: "workflow_datasets" })
export class WorkflowDatasetEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Index() @Column("uuid") workflowId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  /** Name to value, per row. Text only: a variable is what goes into a URL or a body. */
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) rows: Record<string, string>[];
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}

/**
 * An ordered list of flows run as one.
 *
 * The list is a `jsonb` array and not a join table for the same reason `definition` is one
 * document: what changes is the order, all of it at once, and a join table with a sort column
 * makes «reorder» a set of updates that can half-apply. What it costs is the cascade — deleting a
 * flow a suite names is a 409 here rather than a silent removal — which is the answer this product
 * gives everywhere else a reference exists.
 */
@Entity({ name: "workflow_suites" })
export class WorkflowSuiteEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "text", nullable: true }) description: string | null;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) workflowIds: string[];
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}

/**
 * An endpoint of a project, written, imported or taken from the contract.
 *
 * The request parts are `jsonb` rows because they are edited and saved as one form, and the unique
 * index is partial — only live rows count — so deleting `GET /x` leaves room for a new one.
 */
@Entity({ name: "endpoints" })
@Index("UQ_endpoints_live_method_path", ["projectId", "method", "path"], { unique: true, where: `"deletedAt" IS NULL` })
@Index("IDX_endpoints_projectId_status", ["projectId", "status"])
export class EndpointEntity {
  @PrimaryColumn("uuid") id: string;
  @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 10 }) method: string;
  @Column({ type: "varchar", length: 500 }) path: string;
  @Column({ type: "text", default: "" }) description: string;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) pathParameters: unknown[];
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) query: unknown[];
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) headers: unknown[];
  @Column({ type: "jsonb" }) body: unknown;
  @Column({ type: "boolean", default: false }) requiresAuth: boolean;
  /** Cuál: los mismos tipos que Postman. Los secretos nunca literales — solo `{{variables}}`. */
  @Column({ type: "jsonb", default: () => `'{"type":"inherit","params":{}}'::jsonb` }) auth: unknown;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) tags: string[];
  @Column({ type: "varchar", length: 20, default: "active" }) status: string;
  @Column({ type: "varchar", length: 20, default: "manual" }) origin: string;
  @Column({ type: "varchar", length: 200, nullable: true }) operationId: string | null;
  @Column({ type: "int", default: 0 }) orderIndex: number;
  @Column({ type: "text", default: "" }) preRequestScript: string;
  @Column({ type: "text", default: "" }) postResponseScript: string;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
  @Column({ type: "timestamptz", nullable: true }) deletedAt: Date | null;
}

/**
 * The token one person captured in one project: from the project's login, or set by a script.
 * Encrypted, and never returned — the claims are, because they already travel in clear inside it.
 */
@Entity({ name: "session_tokens" })
export class SessionTokenEntity {
  @PrimaryColumn("uuid") actorId: string;
  @PrimaryColumn("uuid") projectId: string;
  @Column({ type: "text" }) tokenCiphertext: string;
  @Column({ type: "jsonb", nullable: true }) claims: Record<string, unknown> | null;
  @Column({ type: "timestamptz", nullable: true }) expiresAt: Date | null;
  @Column({ type: "timestamptz" }) capturedAt: Date;
  @Column({ type: "varchar", length: 20 }) source: string;
}

/**
 * Una cookie que una persona tiene guardada de un proyecto.
 *
 * La clave es la que identifica una cookie en la RFC 6265: dominio, ruta y nombre. El valor va
 * cifrado porque una cookie de sesión es una credencial.
 */
@Entity({ name: "request_cookies" })
@Index("IDX_request_cookies_actor_project", ["actorId", "projectId"])
export class RequestCookieEntity {
  @PrimaryColumn("uuid") actorId: string;
  @PrimaryColumn("uuid") projectId: string;
  @PrimaryColumn({ type: "varchar", length: 255 }) domain: string;
  @PrimaryColumn({ type: "varchar", length: 255 }) path: string;
  @PrimaryColumn({ type: "varchar", length: 256 }) name: string;
  @Column({ type: "text" }) valueCiphertext: string;
  @Column({ type: "timestamptz", nullable: true }) expiresAt: Date | null;
  @Column({ type: "boolean", default: false }) secure: boolean;
  @Column({ type: "boolean", default: false }) httpOnly: boolean;
  @Column({ type: "varchar", length: 10, nullable: true }) sameSite: string | null;
  @Column({ type: "boolean", default: true }) hostOnly: boolean;
  @Column({ type: "timestamptz" }) createdAt: Date;
}

/**
 * Un ejemplo guardado de un endpoint: el par petición/respuesta, con los secretos ya fuera.
 *
 * Del proyecto y no de la persona, al contrario que el tarro de cookies: un ejemplo es
 * documentación, y documentación que solo ve quien la guardó no documenta nada.
 */
@Entity({ name: "endpoint_examples" })
@Index("IDX_endpoint_examples_endpoint", ["projectId", "endpointId", "orderIndex"])
@Index("UQ_endpoint_examples_name", ["endpointId", "name"], { unique: true })
export class EndpointExampleEntity {
  @PrimaryColumn("uuid") id: string;
  @Column("uuid") projectId: string;
  @Column("uuid") endpointId: string;
  @Column({ type: "varchar", length: 200 }) name: string;
  @Column({ type: "jsonb" }) request: unknown;
  @Column({ type: "jsonb" }) response: unknown;
  @Column({ type: "varchar", length: 20, default: "manual" }) origin: string;
  @Column({ type: "int", default: 0 }) orderIndex: number;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") createdBy: string;
}

/**
 * Un servidor de mocks: una URL pública que contesta con los ejemplos guardados del proyecto.
 *
 * `publicId` es único en toda la instalación y no solo en el proyecto: es lo que llega en la URL, y
 * se resuelve sin saber todavía de quién es. De la clave se guarda el hash, como en los tokens.
 */
@Entity({ name: "mock_servers" })
export class MockServerEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "varchar", length: 64, unique: true }) publicId: string;
  @Column({ type: "varchar", length: 20 }) visibility: string;
  @Column({ type: "varchar", length: 64, nullable: true }) apiKeyHash: string | null;
  @Column({ type: "varchar", length: 20, default: "" }) apiKeyPreview: string;
  @Column({ type: "jsonb" }) delay: unknown;
  @Column({ type: "boolean", default: true }) enabled: boolean;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") createdBy: string;
}

/**
 * Una llamada que un mock contestó: la bitácora de su URL pública.
 *
 * **Sin cabeceras, sin cuerpo y sin la cadena de consulta.** La petición es de un tercero y lleva
 * sus credenciales dentro —el `Bearer` de un usuario real, la contraseña del login que se prueba, un
 * `?token=`—, así que de ella solo se guarda lo que hace útil la pantalla: cuándo, qué se pidió, qué
 * se contestó y con qué. El razonamiento entero está en `mocks/domain/mock-call.ts`.
 */
@Entity({ name: "mock_calls" })
export class MockCallEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") mockServerId: string;
  @Column({ type: "timestamptz" }) at: Date;
  @Column({ type: "varchar", length: 16 }) method: string;
  @Column({ type: "varchar", length: 300 }) path: string;
  @Column({ type: "int" }) status: number;
  @Column({ type: "uuid", nullable: true }) exampleId: string | null;
  @Column({ type: "varchar", length: 120, default: "" }) exampleName: string;
  /** El código del «no» que ya decide el dominio: `mock-no-route`, `mock-wrong-method`… */
  @Column({ type: "varchar", length: 40, default: "" }) missCode: string;
  @Column({ type: "int", default: 0 }) durationMs: number;
}

/**
 * Una documentación publicada de un proyecto: la URL que la enseña a quien no tiene cuenta aquí.
 *
 * Casi la misma fila que un mock, y eso dice lo que es: una superficie pública de un proyecto, con
 * su identificador opaco y su clave opcional. `publicId` es único en toda la instalación porque es
 * lo único que llega en la URL.
 */
@Entity({ name: "doc_sites" })
export class DocSiteEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "varchar", length: 64, unique: true }) publicId: string;
  @Column({ type: "varchar", length: 20 }) visibility: string;
  @Column({ type: "varchar", length: 64, nullable: true }) apiKeyHash: string | null;
  @Column({ type: "varchar", length: 20, default: "" }) apiKeyPreview: string;
  /** Escrita a mano al publicar, nunca leída de un entorno: un entorno lleva secretos dentro. */
  @Column({ type: "varchar", length: 300, default: "" }) baseUrl: string;
  @Column({ type: "text", default: "" }) intro: string;
  @Column({ type: "boolean", default: false }) includeExamples: boolean;
  @Column({ type: "boolean", default: true }) enabled: boolean;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") createdBy: string;
}

/**
 * Un monitor: una corrida guardada que se lanza sola.
 *
 * `nextRunAt` es la columna que hace todo: por ella se busca lo vencido, ella se adelanta al
 * reclamarlo, y nula es lo que apaga el monitor de verdad.
 */
@Entity({ name: "monitors" })
export class MonitorEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "boolean", default: true }) enabled: boolean;
  @Column({ type: "jsonb" }) schedule: unknown;
  @Column({ type: "jsonb" }) plan: unknown;
  @Column({ type: "jsonb", nullable: true }) alert: unknown;
  @Column({ type: "timestamptz", nullable: true }) nextRunAt: Date | null;
  @Column({ type: "timestamptz", nullable: true }) lastRunAt: Date | null;
  @Column({ type: "varchar", length: 20, nullable: true }) lastOutcome: string | null;
  @Column({ type: "int", default: 0 }) consecutiveFailures: number;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") createdBy: string;
}

/**
 * Una vuelta de un monitor.
 *
 * `runId` no tiene clave ajena a propósito: la retención borra corridas viejas, y el historial del
 * monitor tiene que sobrevivir a eso — es lo único que dice desde cuándo algo va mal.
 */
@Entity({ name: "monitor_executions" })
export class MonitorExecutionEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") monitorId: string;
  @Column("uuid") projectId: string;
  @Index() @Column({ type: "uuid", nullable: true }) runId: string | null;
  @Column({ type: "varchar", length: 20 }) outcome: string;
  @Column({ type: "timestamptz" }) startedAt: Date;
  @Column({ type: "timestamptz", nullable: true }) finishedAt: Date | null;
  @Column({ type: "jsonb", nullable: true }) totals: unknown;
  @Column({ type: "text", default: "" }) note: string;
}

/**
 * Un canal: lo que un proyecto prueba cuando no es una petición. Hoy un WebSocket.
 *
 * Tabla hermana de `endpoints` y no una columna en ella. El motivo entero está en la migración
 * `1700000028000-Channels`: los siete lectores de `endpoints` fallan abiertos, y aparte siguen
 * significando lo que significan sin que nadie tenga que acordarse de filtrar.
 */
@Entity({ name: "channel_endpoints" })
export class ChannelEndpointEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 10 }) protocol: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "varchar", length: 2000 }) url: string;
  @Column({ type: "jsonb", default: () => "'[]'" }) subprotocols: unknown;
  @Column({ type: "jsonb", default: () => "'[]'" }) headers: unknown;
  @Column({ type: "jsonb", nullable: true }) auth: unknown;
  @Column({ type: "jsonb" }) limits: unknown;
  @Column({ type: "jsonb", default: () => "'{}'" }) expectations: unknown;
  /** Las tramas guardadas para no reteclear la de auth en cada sesión. */
  @Column({ type: "jsonb", default: () => "'[]'" }) messages: unknown;
  /** Solo en un canal MQTT: broker, sesión y suscripciones. Ver `1700000029000-ChannelMqtt`. */
  @Column({ type: "jsonb", nullable: true }) mqtt: unknown;
  /** Servicio, método, mensaje y plazo de un canal gRPC. `null` en los demás protocolos. */
  @Column({ type: "jsonb", nullable: true }) grpc: unknown;
  @Column({ type: "int", default: 0 }) orderIndex: number;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column({ type: "uuid", nullable: true }) updatedBy: string | null;
  @Column({ type: "timestamptz", nullable: true }) deletedAt: Date | null;
}

/**
 * Una conversación con un canal. Una fila y no un objeto en memoria, porque cerrar la pestaña no
 * puede matarla: quien recarga vuelve a esta fila. `ownerInstance` y `heartbeatAt` son lo que dice
 * si el proceso que tiene el socket sigue vivo.
 */
@Entity({ name: "channel_sessions" })
export class ChannelSessionEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") channelId: string;
  @Column("uuid") projectId: string;
  @Column({ type: "uuid", nullable: true }) environmentId: string | null;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "jsonb", nullable: true }) handshake: unknown;
  @Column({ type: "jsonb" }) counters: unknown;
  @Column({ type: "jsonb", nullable: true }) verdict: unknown;
  @Column({ type: "varchar", length: 30, nullable: true }) stopReason: string | null;
  @Column({ type: "int", nullable: true }) closeCode: number | null;
  @Column({ type: "varchar", length: 64 }) ownerInstance: string;
  @Column({ type: "timestamptz" }) heartbeatAt: Date;
  @Column({ type: "timestamptz" }) openedAt: Date;
  @Column({ type: "timestamptz", nullable: true }) closedAt: Date | null;
  @Column("uuid") startedBy: string;
  @Column({ type: "timestamptz", nullable: true }) prunedAt: Date | null;
}

/** Un mensaje de una conversación, ya redactado. La clave es `(sessionId, seq)`: ver la migración. */
@Entity({ name: "channel_messages" })
export class ChannelMessageEntity {
  @PrimaryColumn("uuid") sessionId: string;
  @PrimaryColumn("int") seq: number;
  @Column({ type: "varchar", length: 10 }) direction: string;
  @Column({ type: "varchar", length: 10 }) kind: string;
  @Column({ type: "int" }) atMs: number;
  @Column({ type: "int" }) bytes: number;
  @Column({ type: "boolean", default: false }) truncated: boolean;
  @Column({ type: "text", default: "" }) body: string;
  /** Solo MQTT: el tema (ya tapado), la QoS y el `retain`. Nulos en un WebSocket. */
  @Column({ type: "text", nullable: true }) topic: string | null;
  @Column({ type: "smallint", nullable: true }) qos: number | null;
  @Column({ type: "boolean", nullable: true }) retain: boolean | null;
  /** Solo MQTT 5: las propiedades del mensaje (ya tapadas). Nulas en todo lo demás. */
  @Column({ type: "jsonb", nullable: true }) properties: Record<string, unknown> | null;
}

/**
 * Una sesión de captura: el proxy abierto para un proyecto, con su token y sus topes.
 *
 * Del token solo el hash, como de un token de API: se enseña una vez al abrir la sesión. El
 * razonamiento entero está en `captures/infrastructure/capture-proxy.ts`.
 */
@Entity({ name: "capture_sessions" })
export class CaptureSessionEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Index({ unique: true }) @Column({ type: "varchar", length: 64 }) tokenHash: string;
  @Column({ type: "jsonb" }) limits: unknown;
  @Column({ type: "int", default: 0 }) itemCount: number;
  @Column({ type: "timestamptz" }) startedAt: Date;
  @Column({ type: "timestamptz" }) expiresAt: Date;
  @Column({ type: "timestamptz", nullable: true }) stoppedAt: Date | null;
  @Column({ type: "varchar", length: 30, nullable: true }) stopReason: string | null;
  @Column("uuid") startedBy: string;
}

/** Una petición grabada por el proxy, **ya tapada**: ver `captures/domain/model.ts`. */
@Entity({ name: "capture_items" })
export class CaptureItemEntity {
  @PrimaryColumn("uuid") id: string;
  @Column("uuid") sessionId: string;
  @Column("uuid") projectId: string;
  @Column({ type: "int" }) seq: number;
  @Column({ type: "timestamptz" }) at: Date;
  @Column({ type: "varchar", length: 16 }) method: string;
  @Column({ type: "varchar", length: 4000 }) url: string;
  @Column({ type: "int", nullable: true }) status: number | null;
  @Column({ type: "boolean", default: false }) encrypted: boolean;
  @Column({ type: "jsonb" }) requestHeaders: Record<string, string>;
  @Column({ type: "text", default: "" }) requestBody: string;
  @Column({ type: "boolean", default: false }) requestBodyTruncated: boolean;
  @Column({ type: "jsonb" }) responseHeaders: Record<string, string>;
  @Column({ type: "text", default: "" }) responseBody: string;
  @Column({ type: "boolean", default: false }) responseBodyTruncated: boolean;
  @Column({ type: "varchar", length: 200, default: "" }) responseContentType: string;
  @Column({ type: "int", default: 0 }) durationMs: number;
  @Column({ type: "varchar", length: 500, nullable: true }) error: string | null;
}

/** Un `.proto` de un canal gRPC: se guardan para que una corrida o un monitor no tengan que volver a subirlos. */
@Entity({ name: "channel_proto_files" })
export class ChannelProtoFileEntity {
  @PrimaryColumn("uuid") channelId: string;
  @PrimaryColumn({ type: "varchar", length: 300 }) path: string;
  @Column({ type: "text" }) content: string;
  @Column({ type: "int" }) bytes: number;
}

/** A role of the API a project tests. The `access` section is derived from these rows. */
@Entity({ name: "project_roles" })
export class RoleEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 20 }) name: string;
  @Column({ type: "text", default: "" }) description: string;
  @Column({ type: "varchar", length: 7 }) color: string;
  @Column({ type: "boolean", default: false }) sameRoleDataIsolation: boolean;
  @Column({ type: "int", default: 0 }) position: number;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
}

/** One decided cell: a role over an endpoint. No row is «sin decidir». */
@Entity({ name: "role_endpoint_permissions" })
export class RolePermissionEntity {
  @PrimaryColumn("uuid") roleId: string;
  @PrimaryColumn("uuid") endpointId: string;
  /** `allow` or `deny`. */
  @Column({ type: "varchar", length: 10 }) access: string;
  /** `all`, `own` or `none`. */
  @Column({ type: "varchar", length: 10, default: "all" }) dataScope: string;
}

/** Whether `target` may read, write and delete what `source` created. */
@Entity({ name: "role_rules" })
export class RoleRuleEntity {
  @PrimaryColumn("uuid") sourceRoleId: string;
  @PrimaryColumn("uuid") targetRoleId: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "boolean", default: false }) canRead: boolean;
  @Column({ type: "boolean", default: false }) canWrite: boolean;
  @Column({ type: "boolean", default: false }) canDelete: boolean;
}

/**
 * Una corrida de seguridad. Los hallazgos y las sondas van en jsonb; las credenciales no están:
 * se leen cifradas del entorno al ejecutar y no se persisten.
 */
@Entity({ name: "security_runs" })
export class SecurityRunEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column("uuid") environmentId: string;
  @Column({ type: "varchar", length: 120, default: "" }) label: string;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) rules: Record<string, boolean>;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) options: unknown;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) progress: unknown;
  @Column({ type: "int", nullable: true }) score: number | null;
  @Column({ type: "varchar", length: 20, nullable: true }) risk: string | null;
  @Column({ type: "jsonb", nullable: true }) summary: unknown;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) findings: unknown[];
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) probes: unknown[];
  @Column({ type: "jsonb", nullable: true }) ai: unknown;
  @Column({ type: "varchar", length: 10, default: "private" }) visibility: string;
  @Column({ type: "varchar", length: 36, nullable: true }) shareToken: string | null;
  @Column({ type: "varchar", length: 20 }) triggeredByKind: string;
  @Column("uuid") triggeredBy: string;
  @Column({ type: "timestamptz" }) startedAt: Date;
  @Column({ type: "timestamptz", nullable: true }) finishedAt: Date | null;
  @Column({ type: "text", nullable: true }) error: string | null;
}

/**
 * A saved load-testing plan: scenarios, load profile and thresholds as one `jsonb` document.
 *
 * A document and not three tables for the same reason a workflow is one: the unit of change is the
 * whole plan, and a scenario's weight means nothing apart from the scenarios it competes with.
 */
@Entity({ name: "performance_plans" })
export class PerformancePlanEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 120 }) name: string;
  @Column({ type: "text", nullable: true }) description: string | null;
  @Column({
    type: "jsonb",
    default: () => `'{"scenarios":[],"profile":{"type":"constant","vus":1,"durationS":30},"thresholds":{}}'::jsonb`,
  })
  definition: unknown;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}

/**
 * One execution of a plan: the plan as it was, and the numbers it produced.
 *
 * The definition is snapshotted, not a foreign key: a run is a fact about a minute, and editing the
 * plan afterwards must not rewrite what a past run measured. Windows, per-endpoint stats and the
 * threshold results are `jsonb` for the same reason the security findings are — they are read as a
 * whole, per run, and never queried across runs.
 */
@Entity({ name: "performance_runs" })
export class PerformanceRunEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Index() @Column({ type: "uuid", nullable: true }) planId: string | null;
  @Column({ type: "varchar", length: 120, default: "" }) planName: string;
  @Column({ type: "uuid", nullable: true }) environmentId: string | null;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) definition: unknown;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) progress: unknown;
  @Column({ type: "jsonb", nullable: true }) summary: unknown;
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) windows: unknown[];
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) endpoints: unknown[];
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) thresholds: unknown[];
  @Column({ type: "timestamptz" }) startedAt: Date;
  @Column({ type: "timestamptz", nullable: true }) finishedAt: Date | null;
  @Column({ type: "text", nullable: true }) error: string | null;
}

/**
 * A project's connection to a source repository. One row per project (unique `projectId`).
 *
 * The token is ciphertext, like every target credential, and decrypted only in memory at scan time.
 */
@Entity({ name: "code_connectors" })
export class CodeConnectorEntity {
  @PrimaryColumn("uuid") id: string;
  @Index({ unique: true }) @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 20, default: "github" }) provider: string;
  @Column({ type: "varchar", length: 200 }) repo: string;
  @Column({ type: "varchar", length: 200, default: "main" }) branch: string;
  @Column({ type: "varchar", length: 300, default: "" }) basePath: string;
  @Column({ type: "varchar", length: 100, default: "" }) prefix: string;
  @Column({ type: "text", nullable: true }) tokenCiphertext: string | null;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column({ type: "timestamptz" }) updatedAt: Date;
  @Column("uuid") updatedBy: string;
}

/** One scan of the code: the routes it read, the diff against the project, and the impact. All three
 * are read as a whole per scan, so they are `jsonb` and not tables. */
@Entity({ name: "code_scans" })
export class CodeScanEntity {
  @PrimaryColumn("uuid") id: string;
  @Index() @Column("uuid") projectId: string;
  @Column({ type: "varchar", length: 20 }) source: string;
  @Column({ type: "varchar", length: 120, default: "" }) ref: string;
  @Column({ type: "varchar", length: 20 }) status: string;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) result: unknown;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) diff: unknown;
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) impact: unknown;
  @Column({ type: "text", nullable: true }) error: string | null;
  @Column({ type: "timestamptz" }) createdAt: Date;
  @Column("uuid") createdBy: string;
}

// The line breaks group these by module, which is information a formatter cannot know and
// one-per-line would lose.
// prettier-ignore
export const ENTITIES = [
  UserEntity, OrganizationEntity, MembershipEntity, InvitationEntity, RefreshTokenEntity, ApiTokenEntity,
  PasswordResetTokenEntity,
  ProjectEntity, ProjectForkEntity, ForkMergeRequestEntity, ForkMergeRequestEventEntity,
  SpecSourceEntity, SpecVersionEntity, SpecOperationEntity,
  EnvironmentEntity, EnvironmentCredentialEntity, SessionTokenEntity, RequestCookieEntity, ProjectConfigEntity,
  RequestTemplateEntity, WorkflowEntity, WorkflowDatasetEntity, WorkflowSuiteEntity,
  RunEntity, RunCaseEntity, RunStepEntity,
  EndpointEntity, EndpointExampleEntity,
  MockServerEntity, MockCallEntity,
  DocSiteEntity,
  MonitorEntity, MonitorExecutionEntity,
  ChannelEndpointEntity, ChannelSessionEntity, ChannelMessageEntity, ChannelProtoFileEntity,
  CaptureSessionEntity, CaptureItemEntity,
  RoleEntity, RolePermissionEntity, RoleRuleEntity,
  SecurityRunEntity,
  PerformancePlanEntity, PerformanceRunEntity,
  CodeConnectorEntity, CodeScanEntity,
];
