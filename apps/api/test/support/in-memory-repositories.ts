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
import type { Cookie } from "@eq/runner-core";
import type { ApiToken, RefreshToken, User } from "@/modules/auth/domain/model";
import type {
  ApiTokenRepositoryPort,
  RefreshTokenRepositoryPort,
  UserRepositoryPort,
} from "@/modules/auth/domain/ports";
import type { Invitation, Membership, Organization } from "@/modules/iam/domain/model";
import type {
  InvitationRepositoryPort,
  MembershipRepositoryPort,
  OrganizationRepositoryPort,
} from "@/modules/iam/domain/ports";
import type { Project } from "@/modules/projects/domain/model";
import type { ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import type { SpecOperation, SpecSource, SpecVersion, SpecVersionSummary } from "@/modules/specs/domain/model";
import type { SpecRepositoryPort } from "@/modules/specs/domain/ports";
import type { Credential, CredentialRole, Environment } from "@/modules/environments/domain/model";
import type {
  CookieJarRepositoryPort,
  EnvironmentRepositoryPort,
  SessionTokenRepositoryPort,
} from "@/modules/environments/domain/ports";
import type { SessionToken } from "@/modules/environments/domain/session-token";
import type { PermissionChange, Role, RolePermission, RoleRule } from "@/modules/roles/domain/model";
import type { RoleRepositoryPort } from "@/modules/roles/domain/ports";
import type { SecurityRun } from "@/modules/security-runs/domain/model";
import type { SecurityRunRepositoryPort } from "@/modules/security-runs/domain/ports";
import type { PerformancePlanRow, PerformanceRun } from "@/modules/performance/domain/model";
import type { PerformancePlanRepositoryPort, PerformanceRunRepositoryPort } from "@/modules/performance/domain/ports";
import type { CodeConnector, CodeScan } from "@/modules/code-scan/domain/model";
import type { CodeConnectorRepositoryPort, CodeScanRepositoryPort } from "@/modules/code-scan/domain/ports";
import type { ConfigRepositoryPort, ConfigRow } from "@/modules/config/domain/ports";
import type { ConfigSection } from "@eq/runner-core";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "@/modules/workflows/domain/model";
import type { WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import type { CaseStatus, Run, RunCase, RunStatus, RunStep, RunTotals } from "@/modules/runs/domain/model";
import type { RunRepositoryPort } from "@/modules/runs/domain/ports";

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

export class InMemoryProjectRepository implements ProjectRepositoryPort {
  readonly rows = new Map<string, Project>();

  async findById(id: string): Promise<Project | null> {
    const project = this.rows.get(id);
    return project && !project.deletedAt ? project : null;
  }
  async findBySlug(organizationId: string, slug: string): Promise<Project | null> {
    return (
      [...this.rows.values()].find((project) => project.organizationId === organizationId && project.slug === slug) ??
      null
    );
  }
  async listForOrganization(organizationId: string, includeArchived: boolean): Promise<Project[]> {
    return [...this.rows.values()].filter(
      (project) =>
        project.organizationId === organizationId && !project.deletedAt && (includeArchived || !project.archivedAt),
    );
  }
  async save(project: Project): Promise<void> {
    this.rows.set(project.id, { ...project });
  }
}

export class InMemorySpecRepository implements SpecRepositoryPort {
  readonly versions = new Map<string, SpecVersion>();
  readonly operations = new Map<string, SpecOperation[]>();
  readonly sources = new Map<string, SpecSource>();

  async findVersionById(id: string): Promise<SpecVersion | null> {
    return this.versions.get(id) ?? null;
  }
  async findVersionByHash(projectId: string, hash: string): Promise<SpecVersion | null> {
    return (
      [...this.versions.values()].find((version) => version.projectId === projectId && version.hash === hash) ?? null
    );
  }
  async listVersions(projectId: string): Promise<SpecVersionSummary[]> {
    return (
      [...this.versions.values()]
        .filter((version) => version.projectId === projectId)
        .sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime())
        // `raw` is dropped here too, so a test that asserts the listing never ships the document
        // is checking the same contract the SQL repository implements with a `select`.
        .map(({ raw, ...summary }) => summary)
    );
  }
  async saveVersion(version: SpecVersion, operations: SpecOperation[]): Promise<void> {
    this.versions.set(version.id, { ...version });
    this.operations.set(
      version.id,
      operations.map((operation) => ({ ...operation })),
    );
  }
  async listOperations(specVersionId: string): Promise<SpecOperation[]> {
    return [...(this.operations.get(specVersionId) ?? [])].sort((a, b) => a.position - b.position);
  }
  async saveSource(source: SpecSource): Promise<void> {
    this.sources.set(source.id, { ...source });
  }
  async findSourceByLocation(projectId: string, kind: string, location: string): Promise<SpecSource | null> {
    return (
      [...this.sources.values()].find(
        (source) => source.projectId === projectId && source.kind === kind && source.location === location,
      ) ?? null
    );
  }
  async findLatestSource(projectId: string): Promise<SpecSource | null> {
    return (
      [...this.sources.values()]
        .filter((source) => source.projectId === projectId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
    );
  }
  async deleteVersion(id: string): Promise<void> {
    this.versions.delete(id);
    this.operations.delete(id);
  }
}

export class InMemoryEnvironmentRepository implements EnvironmentRepositoryPort {
  readonly rows = new Map<string, Environment>();
  readonly credentials = new Map<string, Credential>();
  private key(environmentId: string, role: CredentialRole) {
    return `${environmentId}:${role}`;
  }

  async findById(id: string): Promise<Environment | null> {
    return this.rows.get(id) ?? null;
  }
  async findByName(projectId: string, name: string): Promise<Environment | null> {
    return (
      [...this.rows.values()].find((environment) => environment.projectId === projectId && environment.name === name) ??
      null
    );
  }
  async listForProject(projectId: string): Promise<Environment[]> {
    return [...this.rows.values()].filter((environment) => environment.projectId === projectId);
  }
  async save(environment: Environment): Promise<void> {
    this.rows.set(environment.id, { ...environment });
  }
  async remove(id: string): Promise<void> {
    this.rows.delete(id);
    // The cascade the migration declares, honoured here too: a fake that leaves the credentials
    // behind would let a test pass that the database would fail.
    for (const [key, credential] of this.credentials) if (credential.environmentId === id) this.credentials.delete(key);
  }

  async listCredentials(environmentId: string): Promise<Credential[]> {
    return [...this.credentials.values()].filter((credential) => credential.environmentId === environmentId);
  }
  async findCredential(environmentId: string, role: CredentialRole): Promise<Credential | null> {
    return this.credentials.get(this.key(environmentId, role)) ?? null;
  }
  async saveCredential(credential: Credential): Promise<void> {
    // Keyed by (environment, role) rather than by id, which is the unique index the migration
    // declares: a map keyed by id would happily hold two `primary` credentials.
    this.credentials.set(this.key(credential.environmentId, credential.role), { ...credential });
  }
  async removeCredential(environmentId: string, role: CredentialRole): Promise<void> {
    this.credentials.delete(this.key(environmentId, role));
  }
}

export class InMemoryConfigRepository implements ConfigRepositoryPort {
  readonly rows = new Map<string, ConfigRow>();
  private key(projectId: string, section: ConfigSection) {
    return `${projectId}:${section}`;
  }

  async listSections(projectId: string): Promise<ConfigRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.section.localeCompare(b.section));
  }
  async findSection(projectId: string, section: ConfigSection): Promise<ConfigRow | null> {
    return this.rows.get(this.key(projectId, section)) ?? null;
  }
  async saveSection(row: ConfigRow): Promise<void> {
    this.rows.set(this.key(row.projectId, row.section), { ...row });
  }
  async deleteSection(projectId: string, section: ConfigSection): Promise<void> {
    this.rows.delete(this.key(projectId, section));
  }
}

export class InMemoryRunRepository implements RunRepositoryPort {
  readonly runs = new Map<string, Run>();
  readonly cases = new Map<string, RunCase>();
  readonly steps = new Map<string, RunStep>();

  async findById(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null;
  }
  async listForProject(projectId: string, limit: number): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }
  async save(run: Run): Promise<void> {
    this.runs.set(run.id, { ...run });
  }
  async saveCases(cases: RunCase[]): Promise<void> {
    for (const runCase of cases) await this.saveCase(runCase);
  }
  async listCases(runId: string): Promise<RunCase[]> {
    return [...this.cases.values()]
      .filter((runCase) => runCase.runId === runId)
      .sort((a, b) => a.position - b.position);
  }
  async findCase(id: string): Promise<RunCase | null> {
    return this.cases.get(id) ?? null;
  }
  async saveCase(runCase: RunCase): Promise<void> {
    // `ux_run_cases_run_position`, which the real table has and this fake did not. It was not an
    // oversight worth shrugging at: a step that loops writes one case per element, the obvious
    // implementation gives them all the position of the step, and every fast test passed while
    // Postgres refused the second element — the run died with a constraint name in `error` and no
    // test anywhere had a chance to say so.
    const clash = [...this.cases.values()].find(
      (other) => other.runId === runCase.runId && other.position === runCase.position && other.id !== runCase.id,
    );
    if (clash) {
      throw new Error(
        `duplicate key value violates unique constraint "ux_run_cases_run_position" (posición ${runCase.position})`,
      );
    }
    this.cases.set(runCase.id, { ...runCase });
  }
  async saveSteps(steps: RunStep[]): Promise<void> {
    for (const step of steps) this.steps.set(step.id, { ...step });
  }
  async deleteSteps(runCaseId: string): Promise<void> {
    for (const [id, step] of this.steps) if (step.runCaseId === runCaseId) this.steps.delete(id);
  }
  async listSteps(runCaseId: string): Promise<RunStep[]> {
    return [...this.steps.values()].filter((step) => step.runCaseId === runCaseId).sort((a, b) => a.index - b.index);
  }
  /** Ordered by the case's position and then the step index, as the SQL one is: the report is
   * read top to bottom and a fake that returned insertion order would hide a wrong ORDER BY. */
  async listStepsForRun(runId: string): Promise<RunStep[]> {
    const cases = await this.listCases(runId);
    return cases.flatMap((runCase) =>
      [...this.steps.values()].filter((step) => step.runCaseId === runCase.id).sort((a, b) => a.index - b.index),
    );
  }

  /** Counted from the case rows, exactly as the SQL repository does. A fake that kept its own
   * counter would let a test pass that the real one fails. */
  async recomputeTotals(runId: string): Promise<RunTotals> {
    const cases = await this.listCases(runId);
    const by = (status: CaseStatus) => cases.filter((runCase) => runCase.status === status).length;
    const totals: RunTotals = {
      cases: cases.length,
      passed: by("passed"),
      failed: by("failed"),
      skipped: by("skipped"),
      completed: by("passed") + by("failed") + by("skipped"),
    };
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, totals });
    return totals;
  }

  async updateStatus(runId: string, status: RunStatus, at: Date, error?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const finished = ["passed", "failed", "cancelled", "error"].includes(status);
    this.runs.set(runId, { ...run, status, ...(finished ? { finishedAt: at } : {}), ...(error ? { error } : {}) });
  }

  /** Skips rows already emptied and runs still going, as the SQL one does. A fake that swept
   * everything every time would hide the `prunedAt IS NULL` guard that makes the sweep converge. */
  async pruneStepBodies(before: Date): Promise<number> {
    const stale = new Set(
      [...this.cases.values()]
        .filter((runCase) => {
          const run = this.runs.get(runCase.runId);
          return run?.finishedAt && run.finishedAt < before;
        })
        .map((runCase) => runCase.id),
    );
    let affected = 0;
    for (const [id, step] of this.steps) {
      if (!stale.has(step.runCaseId) || step.prunedAt) continue;
      this.steps.set(id, { ...step, request: null, expected: null, actual: null, prunedAt: new Date() });
      affected += 1;
    }
    return affected;
  }

  /** The cases and steps go with the run, as the foreign keys make them go in SQL. */
  async deleteRunsBefore(before: Date): Promise<number> {
    const doomed = [...this.runs.values()].filter((run) => run.finishedAt && run.finishedAt < before);
    for (const run of doomed) {
      for (const runCase of [...this.cases.values()].filter((entry) => entry.runId === run.id)) {
        for (const [id, step] of this.steps) if (step.runCaseId === runCase.id) this.steps.delete(id);
        this.cases.delete(runCase.id);
      }
      this.runs.delete(run.id);
    }
    return doomed.length;
  }
}

/**
 * Reusable requests and flows, with the two guarantees the SQL gives.
 *
 * `(projectId, name)` is unique, and a read that names a project cannot reach another one's row —
 * a fake keyed only by id would let a test pass that Postgres, and the repository, would fail.
 */
export class InMemoryWorkflowRepository implements WorkflowRepositoryPort {
  private readonly templates = new Map<string, RequestTemplateRow>();
  private readonly workflows = new Map<string, WorkflowRow>();
  private readonly datasets = new Map<string, DatasetRow>();
  private readonly suites = new Map<string, SuiteRow>();

  async listTemplates(projectId: string): Promise<RequestTemplateRow[]> {
    return [...this.templates.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async findTemplate(projectId: string, templateId: string): Promise<RequestTemplateRow | null> {
    const row = this.templates.get(templateId);
    return row && row.projectId === projectId ? row : null;
  }
  async findTemplateByName(projectId: string, name: string): Promise<RequestTemplateRow | null> {
    return [...this.templates.values()].find((row) => row.projectId === projectId && row.name === name) ?? null;
  }
  async saveTemplate(row: RequestTemplateRow): Promise<void> {
    this.templates.set(row.id, { ...row });
  }
  async deleteTemplate(projectId: string, templateId: string): Promise<void> {
    const row = this.templates.get(templateId);
    if (row?.projectId === projectId) this.templates.delete(templateId);
  }
  async isTemplateReferenced(projectId: string, templateId: string): Promise<boolean> {
    return [...this.workflows.values()].some(
      (workflow) =>
        workflow.projectId === projectId &&
        workflow.definition.steps.some((step) => step.requestTemplateId === templateId),
    );
  }

  async listWorkflows(projectId: string): Promise<WorkflowRow[]> {
    return [...this.workflows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async findWorkflow(projectId: string, workflowId: string): Promise<WorkflowRow | null> {
    const row = this.workflows.get(workflowId);
    return row && row.projectId === projectId ? row : null;
  }
  async findWorkflowByName(projectId: string, name: string): Promise<WorkflowRow | null> {
    return [...this.workflows.values()].find((row) => row.projectId === projectId && row.name === name) ?? null;
  }
  async saveWorkflow(row: WorkflowRow): Promise<void> {
    this.workflows.set(row.id, { ...row, definition: { steps: [...row.definition.steps] } });
  }
  async deleteWorkflow(projectId: string, workflowId: string): Promise<void> {
    const row = this.workflows.get(workflowId);
    if (row?.projectId === projectId) {
      this.workflows.delete(workflowId);
      // The cascade the migration gives the real table: a dataset for a flow that no longer
      // exists is rows nothing can ever spend.
      for (const [id, dataset] of this.datasets) if (dataset.workflowId === workflowId) this.datasets.delete(id);
    }
  }
  async isWorkflowReferenced(projectId: string, workflowId: string): Promise<boolean> {
    return [...this.suites.values()].some(
      (suite) => suite.projectId === projectId && suite.workflowIds.includes(workflowId),
    );
  }

  async listDatasets(projectId: string): Promise<DatasetRow[]> {
    return [...this.datasets.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async findDataset(projectId: string, datasetId: string): Promise<DatasetRow | null> {
    const row = this.datasets.get(datasetId);
    return row && row.projectId === projectId ? row : null;
  }
  async findDatasetByName(workflowId: string, name: string): Promise<DatasetRow | null> {
    return [...this.datasets.values()].find((row) => row.workflowId === workflowId && row.name === name) ?? null;
  }
  async saveDataset(row: DatasetRow): Promise<void> {
    this.datasets.set(row.id, { ...row, rows: row.rows.map((entry) => ({ ...entry })) });
  }
  async deleteDataset(projectId: string, datasetId: string): Promise<void> {
    const row = this.datasets.get(datasetId);
    if (row?.projectId === projectId) this.datasets.delete(datasetId);
  }

  async listSuites(projectId: string): Promise<SuiteRow[]> {
    return [...this.suites.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async findSuite(projectId: string, suiteId: string): Promise<SuiteRow | null> {
    const row = this.suites.get(suiteId);
    return row && row.projectId === projectId ? row : null;
  }
  async findSuiteByName(projectId: string, name: string): Promise<SuiteRow | null> {
    return [...this.suites.values()].find((row) => row.projectId === projectId && row.name === name) ?? null;
  }
  async saveSuite(row: SuiteRow): Promise<void> {
    this.suites.set(row.id, { ...row, workflowIds: [...row.workflowIds] });
  }
  async deleteSuite(projectId: string, suiteId: string): Promise<void> {
    const row = this.suites.get(suiteId);
    if (row?.projectId === projectId) this.suites.delete(suiteId);
  }
}

export class InMemorySessionTokenRepository implements SessionTokenRepositoryPort {
  readonly rows = new Map<string, SessionToken>();
  async find(actorId: string, projectId: string): Promise<SessionToken | null> {
    return this.rows.get(`${actorId}:${projectId}`) ?? null;
  }
  async save(token: SessionToken): Promise<void> {
    this.rows.set(`${token.actorId}:${token.projectId}`, { ...token });
  }
  async remove(actorId: string, projectId: string): Promise<void> {
    this.rows.delete(`${actorId}:${projectId}`);
  }
}

/**
 * El tarro de cookies, en memoria.
 *
 * Guarda por la misma clave que la tabla —dominio, ruta y nombre— porque si no, una prueba en la
 * que el servidor renueva la cookie de `/admin` machacaría la de `/` aquí y no en producción, y la
 * prueba pasaría mintiendo.
 */
export class InMemoryCookieJarRepository implements CookieJarRepositoryPort {
  readonly rows = new Map<string, Cookie>();

  private key(actorId: string, projectId: string, cookie: Pick<Cookie, "domain" | "path" | "name">): string {
    return [actorId, projectId, cookie.domain, cookie.path, cookie.name].join("|");
  }

  async list(actorId: string, projectId: string): Promise<Cookie[]> {
    const prefix = `${actorId}|${projectId}|`;
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, cookie]) => ({ ...cookie }));
  }
  async save(actorId: string, projectId: string, jar: Cookie[]): Promise<void> {
    for (const cookie of jar) this.rows.set(this.key(actorId, projectId, cookie), { ...cookie });
  }
  async remove(
    actorId: string,
    projectId: string,
    keys: Pick<Cookie, "domain" | "path" | "name">[],
  ): Promise<void> {
    for (const key of keys) this.rows.delete(this.key(actorId, projectId, key));
  }
  async clear(actorId: string, projectId: string): Promise<void> {
    const prefix = `${actorId}|${projectId}|`;
    for (const key of [...this.rows.keys()]) if (key.startsWith(prefix)) this.rows.delete(key);
  }
  async purgeExpired(actorId: string, projectId: string, now: Date): Promise<void> {
    const prefix = `${actorId}|${projectId}|`;
    for (const [key, cookie] of [...this.rows.entries()]) {
      if (key.startsWith(prefix) && cookie.expiresAt !== null && cookie.expiresAt <= now.getTime()) {
        this.rows.delete(key);
      }
    }
  }
}

export class InMemoryRoleRepository implements RoleRepositoryPort {
  readonly roles = new Map<string, Role>();
  readonly permissions = new Map<string, RolePermission>();
  readonly rules = new Map<string, RoleRule>();

  async list(projectId: string): Promise<Role[]> {
    return [...this.roles.values()]
      .filter((role) => role.projectId === projectId)
      .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  }
  async findById(projectId: string, id: string): Promise<Role | null> {
    const role = this.roles.get(id);
    return role && role.projectId === projectId ? { ...role } : null;
  }
  async save(role: Role): Promise<void> {
    // The unique index of the migration, honoured: a fake that stored two «admin» would hide the 409.
    for (const other of this.roles.values())
      if (other.projectId === role.projectId && other.name === role.name && other.id !== role.id)
        throw new Error("duplicate key value violates unique constraint ux_project_roles_name");
    this.roles.set(role.id, { ...role });
  }
  async remove(projectId: string, id: string): Promise<void> {
    if (this.roles.get(id)?.projectId !== projectId) return;
    this.roles.delete(id);
    for (const [key, cell] of this.permissions) if (cell.roleId === id) this.permissions.delete(key);
    for (const [key, rule] of this.rules)
      if (rule.sourceRoleId === id || rule.targetRoleId === id) this.rules.delete(key);
  }
  async listPermissions(projectId: string, filter: { roleId?: string; endpointId?: string } = {}) {
    const ids = new Set((await this.list(projectId)).map((role) => role.id));
    return [...this.permissions.values()].filter(
      (cell) =>
        ids.has(cell.roleId) &&
        (!filter.roleId || cell.roleId === filter.roleId) &&
        (!filter.endpointId || cell.endpointId === filter.endpointId),
    );
  }
  async applyPermissions(changes: PermissionChange[]): Promise<void> {
    for (const change of changes) {
      const key = `${change.roleId}:${change.endpointId}`;
      if (change.access === "undecided") this.permissions.delete(key);
      else
        this.permissions.set(key, {
          roleId: change.roleId,
          endpointId: change.endpointId,
          access: change.access,
          dataScope: change.dataScope,
        });
    }
  }
  async listRules(projectId: string): Promise<RoleRule[]> {
    return [...this.rules.values()].filter((rule) => rule.projectId === projectId);
  }
  async replaceRules(projectId: string, rules: RoleRule[]): Promise<void> {
    for (const [key, rule] of this.rules) if (rule.projectId === projectId) this.rules.delete(key);
    for (const rule of rules) this.rules.set(`${rule.sourceRoleId}:${rule.targetRoleId}`, { ...rule });
  }
}

export class InMemorySecurityRunRepository implements SecurityRunRepositoryPort {
  readonly rows = new Map<string, SecurityRun>();
  async listForProject(projectId: string, limit: number): Promise<SecurityRun[]> {
    return [...this.rows.values()]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
      .map((run) => structuredClone(run));
  }
  async findById(id: string): Promise<SecurityRun | null> {
    const run = this.rows.get(id);
    return run ? structuredClone(run) : null;
  }
  async findByShareToken(shareToken: string): Promise<SecurityRun | null> {
    return (
      [...this.rows.values()].map((run) => structuredClone(run)).find((run) => run.shareToken === shareToken) ?? null
    );
  }
  async save(run: SecurityRun): Promise<void> {
    this.rows.set(run.id, structuredClone(run));
  }
  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class InMemoryPerformancePlanRepository implements PerformancePlanRepositoryPort {
  readonly rows = new Map<string, PerformancePlanRow>();
  async list(projectId: string): Promise<PerformancePlanRow[]> {
    return [...this.rows.values()]
      .filter((plan) => plan.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((plan) => structuredClone(plan));
  }
  async find(projectId: string, planId: string): Promise<PerformancePlanRow | null> {
    const plan = this.rows.get(planId);
    return plan && plan.projectId === projectId ? structuredClone(plan) : null;
  }
  async findByName(projectId: string, name: string): Promise<PerformancePlanRow | null> {
    return (
      [...this.rows.values()]
        .map((plan) => structuredClone(plan))
        .find((plan) => plan.projectId === projectId && plan.name === name) ?? null
    );
  }
  async save(row: PerformancePlanRow): Promise<void> {
    this.rows.set(row.id, structuredClone(row));
  }
  async delete(projectId: string, planId: string): Promise<void> {
    const plan = this.rows.get(planId);
    if (plan && plan.projectId === projectId) this.rows.delete(planId);
  }
}

export class InMemoryPerformanceRunRepository implements PerformanceRunRepositoryPort {
  readonly rows = new Map<string, PerformanceRun>();
  async list(projectId: string, planId?: string): Promise<PerformanceRun[]> {
    return [...this.rows.values()]
      .filter((run) => run.projectId === projectId && (planId ? run.planId === planId : true))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((run) => structuredClone(run));
  }
  async find(projectId: string, runId: string): Promise<PerformanceRun | null> {
    const run = this.rows.get(runId);
    return run && run.projectId === projectId ? structuredClone(run) : null;
  }
  async findById(runId: string): Promise<PerformanceRun | null> {
    const run = this.rows.get(runId);
    return run ? structuredClone(run) : null;
  }
  async save(run: PerformanceRun): Promise<void> {
    this.rows.set(run.id, structuredClone(run));
  }
  async delete(projectId: string, runId: string): Promise<void> {
    const run = this.rows.get(runId);
    if (run && run.projectId === projectId) this.rows.delete(runId);
  }
}

export class InMemoryCodeConnectorRepository implements CodeConnectorRepositoryPort {
  readonly rows = new Map<string, CodeConnector>();
  async find(projectId: string): Promise<CodeConnector | null> {
    return (
      [...this.rows.values()].map((row) => structuredClone(row)).find((row) => row.projectId === projectId) ?? null
    );
  }
  async save(connector: CodeConnector): Promise<void> {
    this.rows.set(connector.projectId, structuredClone(connector));
  }
  async delete(projectId: string): Promise<void> {
    this.rows.delete(projectId);
  }
}

export class InMemoryCodeScanRepository implements CodeScanRepositoryPort {
  readonly rows = new Map<string, CodeScan>();
  async list(projectId: string): Promise<CodeScan[]> {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => structuredClone(row));
  }
  async find(projectId: string, scanId: string): Promise<CodeScan | null> {
    const row = this.rows.get(scanId);
    return row && row.projectId === projectId ? structuredClone(row) : null;
  }
  async save(scan: CodeScan): Promise<void> {
    this.rows.set(scan.id, structuredClone(scan));
  }
  async delete(projectId: string, scanId: string): Promise<void> {
    const row = this.rows.get(scanId);
    if (row && row.projectId === projectId) this.rows.delete(scanId);
  }
}
