/**
 * The projects adapters against a real Postgres (an isolated schema): the deleted/archived filters,
 * the auth columns folded into one value, the fork write plan as one locked transaction, and the
 * partial unique index that turns a second pending merge request into a 409.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  ForkMergeRequestEntity,
  ForkMergeRequestEventEntity,
  ProjectEntity,
  ProjectForkEntity,
} from "@/shared/database/entities";
import { TypeOrmProjectRepository } from "@/modules/projects/infrastructure/persistence/typeorm-project.repository";
import { TypeOrmProjectForkRepository } from "@/modules/projects/infrastructure/persistence/typeorm-project-fork.repository";
import { TypeOrmMergeRequestRepository } from "@/modules/projects/infrastructure/persistence/typeorm-merge-request.repository";
import type { Project } from "@/modules/projects/domain/model";
import { emptyLineage, type ForkWritePlan, type ProjectFork } from "@/modules/projects/domain/fork";
import { emptySnapshot } from "@/modules/projects/domain/fork-merge";
import type { ForkMergeRequest, MergeRequestEvent } from "@/modules/projects/domain/merge-request";
import { ConflictError } from "@/shared/errors/domain-error";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import {
  countRows,
  insertChannel,
  insertEndpoint,
  insertEnvironment,
  insertOrganization,
  insertProject,
  insertRole,
  insertRow,
  insertWorkflow,
} from "@test/support/repos-seed";

const at = (iso: string) => new Date(iso);

describe("projects persistence adapters", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  describe("TypeOrmProjectRepository", () => {
    const repo = () => new TypeOrmProjectRepository(db.dataSource.getRepository(ProjectEntity));
    const project = (organizationId: string, overrides: Partial<Project> = {}): Project => ({
      id: randomUUID(),
      organizationId,
      name: "Catalog",
      slug: `catalog-${randomUUID().slice(0, 6)}`,
      description: "desc",
      createdBy: randomUUID(),
      createdAt: at("2026-01-01T00:00:00Z"),
      archivedAt: null,
      activeSpecVersionId: null,
      activeEnvironmentId: null,
      baseUrl: "https://api.example.test",
      tags: ["a", "b"],
      auth: { type: "bearer", settings: { tokenSet: true } as never, secretCiphertext: "cipher" },
      deletedAt: null,
      ...overrides,
    });

    test("save splits auth into its columns and findById folds it back", async () => {
      const org = await insertOrganization(db.dataSource);
      const p = project(org);
      await repo().save(p);
      assert.deepEqual(await repo().findById(p.id), p);
      const [row] = await db.dataSource.query(
        `SELECT "authType", "authSettings", "authSecretCiphertext" FROM "projects" WHERE "id" = $1`,
        [p.id],
      );
      assert.deepEqual(row, { authType: "bearer", authSettings: { tokenSet: true }, authSecretCiphertext: "cipher" });
    });

    test("a deleted project is not found by id, but its slug still is", async () => {
      const org = await insertOrganization(db.dataSource);
      const p = project(org, { deletedAt: at("2026-02-01T00:00:00Z") });
      await repo().save(p);
      assert.equal(await repo().findById(p.id), null);
      assert.equal((await repo().findBySlug(org, p.slug))?.id, p.id);
    });

    test("findBySlug is per organization; unknown is null", async () => {
      const org = await insertOrganization(db.dataSource);
      const other = await insertOrganization(db.dataSource);
      const p = project(org);
      await repo().save(p);
      assert.equal(await repo().findBySlug(other, p.slug), null);
      assert.equal(await repo().findById(randomUUID()), null);
    });

    test("listForOrganization: newest first, archived only on request, deleted never", async () => {
      const org = await insertOrganization(db.dataSource);
      const other = await insertOrganization(db.dataSource);
      const live = project(org, { name: "live", createdAt: at("2026-01-01T00:00:00Z") });
      const archived = project(org, {
        name: "archived",
        createdAt: at("2026-02-01T00:00:00Z"),
        archivedAt: at("2026-03-01T00:00:00Z"),
      });
      const deleted = project(org, { name: "deleted", deletedAt: at("2026-03-01T00:00:00Z") });
      const foreign = project(other, { name: "foreign" });
      for (const p of [live, archived, deleted, foreign]) await repo().save(p);

      assert.deepEqual(
        (await repo().listForOrganization(org, false)).map((p) => p.name),
        ["live"],
      );
      assert.deepEqual(
        (await repo().listForOrganization(org, true)).map((p) => p.name),
        ["archived", "live"],
      );
    });

    test("the same slug twice in one organization is rejected", async () => {
      const org = await insertOrganization(db.dataSource);
      await repo().save(project(org, { slug: "same" }));
      await assert.rejects(repo().save(project(org, { slug: "same" })), /duplicate|unique/i);
    });
  });

  describe("TypeOrmMergeRequestRepository", () => {
    const repo = () =>
      new TypeOrmMergeRequestRepository(
        db.dataSource.getRepository(ForkMergeRequestEntity),
        db.dataSource.getRepository(ForkMergeRequestEventEntity),
      );
    const request = (
      ids: { organizationId: string; forkProjectId: string; parentProjectId: string },
      overrides: Partial<ForkMergeRequest> = {},
    ): ForkMergeRequest => ({
      id: randomUUID(),
      ...ids,
      title: "Merge me",
      description: "",
      status: "open",
      createdBy: randomUUID(),
      createdAt: at("2026-01-01T00:00:00Z"),
      updatedAt: at("2026-01-01T00:00:00Z"),
      diff: [{ kind: "endpoint", key: "GET /x", change: "added" } as never],
      diffVersion: 1,
      decidedBy: null,
      decidedAt: null,
      mergedVersion: null,
      ...overrides,
    });
    async function pair() {
      const organizationId = await insertOrganization(db.dataSource);
      const parent = await insertProject(db.dataSource, { organizationId });
      const fork = await insertProject(db.dataSource, { organizationId });
      return { organizationId, parentProjectId: parent.id, forkProjectId: fork.id };
    }

    test("save/findById round-trips, and is scoped to the organization", async () => {
      const ids = await pair();
      const r = request(ids);
      await repo().save(r);
      assert.deepEqual(await repo().findById(ids.organizationId, r.id), r);
      assert.equal(await repo().findById(randomUUID(), r.id), null);
      assert.equal(await repo().findById(ids.organizationId, randomUUID()), null);
    });

    test("a second pending request for the same fork is a ConflictError; a decided one is not", async () => {
      const ids = await pair();
      await repo().save(request(ids, { status: "declined" }));
      await repo().save(request(ids, { status: "open" }));
      await assert.rejects(repo().save(request(ids, { status: "approved" })), (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, "merge-request-pending");
        return true;
      });
    });

    test("any other database error is rethrown as it is", async () => {
      const ids = await pair();
      // `status` has a CHECK; a violation is not the unique index and must not be mapped to 409.
      await assert.rejects(repo().save(request(ids, { status: "bogus" as never })), (error: unknown) => {
        assert.ok(!(error instanceof ConflictError));
        assert.match(String((error as Error).message), /check constraint/i);
        return true;
      });
    });

    test("listForProject finds it from either side, newest first, scoped to the organization", async () => {
      const ids = await pair();
      const older = request(ids, { status: "closed", createdAt: at("2026-01-01T00:00:00Z") });
      const newer = request(ids, { status: "open", createdAt: at("2026-02-01T00:00:00Z") });
      await repo().save(older);
      await repo().save(newer);
      const other = await pair();
      await repo().save(request(other));

      assert.deepEqual(
        (await repo().listForProject(ids.organizationId, ids.parentProjectId)).map((r) => r.id),
        [newer.id, older.id],
      );
      assert.deepEqual(
        (await repo().listForProject(ids.organizationId, ids.forkProjectId)).map((r) => r.id),
        [newer.id, older.id],
      );
      assert.deepEqual(await repo().listForProject(other.organizationId, ids.parentProjectId), []);
    });

    test("events come back oldest first, only the request's own; they go with the request", async () => {
      const ids = await pair();
      const r = request(ids);
      const r2 = request(ids, { status: "closed" });
      await repo().save(r);
      await repo().save(r2);
      const event = (requestId: string, kind: MergeRequestEvent["kind"], iso: string): MergeRequestEvent => ({
        id: randomUUID(),
        requestId,
        organizationId: ids.organizationId,
        authorId: randomUUID(),
        kind,
        body: kind === "comment" ? "looks good" : "",
        createdAt: at(iso),
      });
      const second = event(r.id, "approved", "2026-01-03T00:00:00Z");
      const first = event(r.id, "comment", "2026-01-02T00:00:00Z");
      await repo().addEvent(second);
      await repo().addEvent(first);
      await repo().addEvent(event(r2.id, "closed", "2026-01-01T00:00:00Z"));

      assert.deepEqual(await repo().listEvents(r.id), [first, second]);
      await db.dataSource.query(`DELETE FROM "fork_merge_requests" WHERE "id" = $1`, [r.id]);
      assert.deepEqual(await repo().listEvents(r.id), []);
    });
  });

  describe("TypeOrmProjectForkRepository", () => {
    const repo = () => new TypeOrmProjectForkRepository(db.dataSource.getRepository(ProjectForkEntity));
    const fork = (
      ids: { organizationId: string; parentProjectId: string; forkProjectId: string },
      overrides: Partial<ProjectFork> = {},
    ): ProjectFork => ({
      ...ids,
      createdBy: randomUUID(),
      createdAt: at("2026-01-01T00:00:00Z"),
      syncedAt: at("2026-01-01T00:00:00Z"),
      version: 1,
      base: emptySnapshot(),
      lineage: emptyLineage(),
      ...overrides,
    });
    async function forked() {
      const organizationId = await insertOrganization(db.dataSource);
      const parent = await insertProject(db.dataSource, { organizationId });
      const child = await insertProject(db.dataSource, { organizationId });
      const ids = { organizationId, parentProjectId: parent.id, forkProjectId: child.id };
      const f = fork(ids);
      await repo().save(f);
      return { ids, fork: f };
    }
    const emptyPlan = (f: ProjectFork, overrides: Partial<ForkWritePlan> = {}): ForkWritePlan => ({
      targetProjectId: f.forkProjectId,
      endpoints: { save: [], remove: [] },
      templates: { save: [], remove: [] },
      workflows: { save: [], remove: [] },
      datasets: { save: [], remove: [] },
      suites: { save: [], remove: [] },
      channels: { save: [], remove: [], protos: [] },
      environments: { save: [], remove: [] },
      roles: { save: [], remove: [], permissions: { clear: [], save: [] }, rules: null },
      sections: { save: [], remove: [] },
      project: null,
      fork: { ...f, version: f.version + 1 },
      expectedVersion: f.version,
      at: at("2026-05-05T00:00:00Z"),
      ...overrides,
    });

    test("save/findByFork round-trips base and lineage; unknown fork is null", async () => {
      const { fork: f } = await forked();
      const lineage = { ...emptyLineage(), workflow: [{ parentId: randomUUID(), forkId: randomUUID() }] };
      await repo().save({ ...f, lineage });
      assert.deepEqual(await repo().findByFork(f.forkProjectId), { ...f, lineage });
      assert.equal(await repo().findByFork(randomUUID()), null);
    });

    test("listByParent returns only that parent's forks", async () => {
      const { ids, fork: f } = await forked();
      const second = await insertProject(db.dataSource, { organizationId: ids.organizationId });
      const f2 = fork({ ...ids, forkProjectId: second.id });
      await repo().save(f2);
      await forked(); // another parent
      const listed = await repo().listByParent(ids.parentProjectId);
      assert.deepEqual(listed.map((x) => x.forkProjectId).sort(), [f.forkProjectId, f2.forkProjectId].sort());
      assert.deepEqual(await repo().listByParent(randomUUID()), []);
    });

    test("apply with nothing to write only bumps the fork", async () => {
      const { fork: f } = await forked();
      await repo().apply(emptyPlan(f));
      assert.equal((await repo().findByFork(f.forkProjectId))?.version, 2);
    });

    test("apply refuses a stale version, and a fork that is gone, writing nothing", async () => {
      const { fork: f } = await forked();
      const env = randomUUID();
      const stale = emptyPlan(f, {
        expectedVersion: 7,
        environments: {
          save: [
            {
              id: env,
              projectId: f.forkProjectId,
              name: "never",
              baseUrl: "http://x",
              specUrl: null,
              variables: {},
              disabledVariables: {},
              writesAllowed: false,
              authEnforced: false,
              createdAt: new Date(),
              archivedAt: null,
              deletedAt: null,
            },
          ],
          remove: [],
        },
      });
      await assert.rejects(repo().apply(stale), (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(error.code, "fork-diff-stale");
        return true;
      });
      assert.equal(await countRows(db.dataSource, "environments", `"id" = $1`, [env]), 0);
      assert.equal((await repo().findByFork(f.forkProjectId))?.version, 1);

      const gone = emptyPlan({ ...f, forkProjectId: randomUUID() });
      await assert.rejects(repo().apply(gone), ConflictError);
    });

    test("apply removes, writes, replaces protos and rules, repoints the project and merges the request", async () => {
      const { ids, fork: f } = await forked();
      const pid = f.forkProjectId;
      const ds = db.dataSource;
      const now = at("2026-05-05T00:00:00Z");
      const user = randomUUID();

      // What is there before: one of each kind, to be removed.
      const oldEndpoint = await insertEndpoint(ds, pid, { method: "GET", path: "/old" });
      const oldWorkflow = await insertWorkflow(ds, pid, { name: "old-wf" });
      const keptWorkflow = await insertWorkflow(ds, pid, { name: "kept-wf" });
      const oldDataset = randomUUID();
      await insertRow(ds, "workflow_datasets", {
        id: oldDataset,
        projectId: pid,
        workflowId: keptWorkflow,
        name: "old-ds",
        createdAt: now,
        updatedAt: now,
        updatedBy: user,
      });
      const oldTemplate = randomUUID();
      await insertRow(ds, "request_templates", {
        id: oldTemplate,
        projectId: pid,
        name: "old-tpl",
        operationId: "op",
        expectedStatus: 200,
        createdAt: now,
        updatedAt: now,
        updatedBy: user,
      });
      const oldSuite = randomUUID();
      await insertRow(ds, "workflow_suites", {
        id: oldSuite,
        projectId: pid,
        name: "old-suite",
        createdAt: now,
        updatedAt: now,
        updatedBy: user,
      });
      const oldChannel = await insertChannel(ds, pid);
      const oldEnvironment = await insertEnvironment(ds, pid, { name: "old-env" });
      const oldRole = await insertRole(ds, pid, { name: "old-role" });
      const keptRole = await insertRole(ds, pid, { name: "kept-role" });
      const otherRole = await insertRole(ds, pid, { name: "other-role" });
      const permEndpoint = await insertEndpoint(ds, pid, { method: "POST", path: "/perm" });
      await insertRow(ds, "role_endpoint_permissions", { roleId: keptRole, endpointId: permEndpoint, access: "deny" });
      await insertRow(ds, "role_rules", {
        projectId: pid,
        sourceRoleId: keptRole,
        targetRoleId: oldRole,
        canRead: true,
      });
      await insertRow(ds, "project_config", {
        projectId: pid,
        section: "bodies",
        data: {},
        updatedAt: now,
        updatedBy: user,
      });
      const protoChannel = await insertChannel(ds, pid, { protocol: "grpc" });
      const emptiedChannel = await insertChannel(ds, pid, { protocol: "grpc" });
      for (const channelId of [protoChannel, emptiedChannel])
        await insertRow(ds, "channel_proto_files", { channelId, path: "old.proto", content: "x", bytes: 1 });
      // Another project's rows with the same ids-to-remove must survive: the plan is scoped.
      const other = await insertProject(ds, { organizationId: ids.organizationId });
      const foreignEnvironment = await insertEnvironment(ds, other.id);

      const newEnvironment = randomUUID();
      const newWorkflow = randomUUID();
      const newChannel = randomUUID();
      const newRole = randomUUID();
      const request: ForkMergeRequest = {
        id: randomUUID(),
        organizationId: ids.organizationId,
        forkProjectId: pid,
        parentProjectId: ids.parentProjectId,
        title: "t",
        description: "",
        status: "merged",
        createdBy: user,
        createdAt: now,
        updatedAt: now,
        diff: [],
        diffVersion: 1,
        decidedBy: user,
        decidedAt: now,
        mergedVersion: 2,
      };
      const event: MergeRequestEvent = {
        id: randomUUID(),
        requestId: request.id,
        organizationId: ids.organizationId,
        authorId: user,
        kind: "merged",
        body: "",
        createdAt: now,
      };

      const plan = emptyPlan(f, {
        endpoints: {
          save: [
            {
              id: randomUUID(),
              projectId: pid,
              method: "GET",
              path: "/old", // the removed one's method and path: freed first, then taken
              description: "",
              pathParameters: [],
              query: [],
              headers: [],
              body: { type: "none" } as never,
              requiresAuth: false,
              auth: { type: "inherit", params: {} } as never,
              tags: [],
              status: "active" as never,
              origin: "manual" as never,
              operationId: null,
              orderIndex: 0,
              preRequestScript: "",
              postResponseScript: "",
              createdAt: now,
              updatedAt: now,
              updatedBy: user,
              deletedAt: null,
            },
          ],
          remove: [oldEndpoint],
        },
        templates: {
          save: [
            {
              id: randomUUID(),
              projectId: pid,
              name: "new-tpl",
              operationId: "op",
              description: null,
              expectedStatus: 201,
              parameters: {},
              disabledParameters: {},
              headers: {},
              disabledHeaders: {},
              body: { type: "none" },
              auth: "default",
              createdAt: now,
              updatedAt: now,
              updatedBy: user,
            } as never,
          ],
          remove: [oldTemplate],
        },
        workflows: {
          save: [
            {
              id: newWorkflow,
              projectId: pid,
              name: "new-wf",
              description: null,
              status: "ready",
              definition: { steps: [] } as never,
              createdAt: now,
              updatedAt: now,
              updatedBy: user,
              deletedAt: null,
            },
          ],
          remove: [oldWorkflow],
        },
        datasets: {
          save: [
            {
              id: randomUUID(),
              projectId: pid,
              workflowId: newWorkflow,
              name: "new-ds",
              rows: [{ sku: "1" }],
              createdAt: now,
              updatedAt: now,
              updatedBy: user,
              archivedAt: null,
              deletedAt: null,
            },
          ],
          remove: [oldDataset],
        },
        suites: {
          save: [
            {
              id: randomUUID(),
              projectId: pid,
              name: "new-suite",
              description: null,
              workflowIds: [newWorkflow],
              createdAt: now,
              updatedAt: now,
              updatedBy: user,
              archivedAt: null,
              deletedAt: null,
            },
          ],
          remove: [oldSuite],
        },
        channels: {
          save: [
            {
              id: newChannel,
              projectId: pid,
              protocol: "ws",
              name: "new-ch",
              url: "ws://x",
              subprotocols: [],
              headers: [],
              auth: null,
              limits: {} as never,
              expectations: {} as never,
              messages: [],
              mqtt: null,
              grpc: null,
              socketio: null,
              orderIndex: 0,
              createdAt: now,
              updatedAt: now,
              updatedBy: user,
              archivedAt: null,
              deletedAt: null,
            },
          ],
          remove: [oldChannel],
          protos: [
            { channelId: protoChannel, files: [{ path: "svc/ñ.proto", content: "syntax = \"proto3\"; // ñ" }] },
            { channelId: emptiedChannel, files: [] },
          ],
        },
        environments: {
          save: [
            {
              id: newEnvironment,
              projectId: pid,
              name: "new-env",
              baseUrl: "http://new",
              specUrl: null,
              variables: {},
              disabledVariables: {},
              writesAllowed: true,
              authEnforced: false,
              createdAt: now,
              archivedAt: null,
              deletedAt: null,
            },
          ],
          remove: [oldEnvironment, foreignEnvironment],
        },
        roles: {
          save: [
            {
              id: newRole,
              projectId: pid,
              name: "new-role",
              description: "",
              color: "#abcdef",
              sameRoleDataIsolation: false,
              position: 3,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              deletedAt: null,
            },
          ],
          remove: [oldRole],
          permissions: {
            clear: [keptRole],
            save: [{ roleId: newRole, endpointId: permEndpoint, access: "allow", dataScope: "own" }],
          },
          rules: [
            { projectId: pid, sourceRoleId: newRole, targetRoleId: otherRole, canRead: true, canWrite: true, canDelete: false },
          ],
        },
        sections: {
          save: [{ projectId: pid, section: "scenarios", data: { a: 1 }, updatedAt: now, updatedBy: user }],
          remove: ["bodies"],
        },
        project: { id: pid, activeEnvironmentId: newEnvironment } as Project,
        mergeRequest: { request, event },
      });

      await repo().apply(plan);

      // Removed (endpoints and channels in soft, the rest for real) — only in the target project.
      const [endpoint] = await ds.query(`SELECT "deletedAt" FROM "endpoints" WHERE "id" = $1`, [oldEndpoint]);
      assert.deepEqual(endpoint.deletedAt, now);
      const [channel] = await ds.query(`SELECT "deletedAt" FROM "channel_endpoints" WHERE "id" = $1`, [oldChannel]);
      assert.deepEqual(channel.deletedAt, now);
      for (const [table, id] of [
        ["workflows", oldWorkflow],
        ["workflow_datasets", oldDataset],
        ["request_templates", oldTemplate],
        ["workflow_suites", oldSuite],
        ["environments", oldEnvironment],
        ["project_roles", oldRole],
      ] as const)
        assert.equal(await countRows(ds, table, `"id" = $1`, [id]), 0, `${table} not removed`);
      assert.equal(await countRows(ds, "environments", `"id" = $1`, [foreignEnvironment]), 1);
      assert.equal(await countRows(ds, "project_config", `"projectId" = $1 AND "section" = 'bodies'`, [pid]), 0);

      // Written.
      assert.equal(
        await countRows(ds, "endpoints", `"projectId" = $1 AND "path" = '/old' AND "deletedAt" IS NULL`, [pid]),
        1,
      );
      for (const [table, name] of [
        ["request_templates", "new-tpl"],
        ["workflows", "new-wf"],
        ["workflow_datasets", "new-ds"],
        ["workflow_suites", "new-suite"],
        ["channel_endpoints", "new-ch"],
        ["environments", "new-env"],
        ["project_roles", "new-role"],
      ] as const)
        assert.equal(await countRows(ds, table, `"projectId" = $1 AND "name" = $2`, [pid, name]), 1, `${table} missing`);
      const [section] = await ds.query(
        `SELECT "data" FROM "project_config" WHERE "projectId" = $1 AND "section" = 'scenarios'`,
        [pid],
      );
      assert.deepEqual(section.data, { a: 1 });

      // Protos replaced whole, with the byte count in UTF-8; an empty list empties the channel.
      const protos = await ds.query(
        `SELECT "channelId", "path", "bytes" FROM "channel_proto_files" WHERE "channelId" IN ($1, $2)`,
        [protoChannel, emptiedChannel],
      );
      assert.deepEqual(protos, [
        { channelId: protoChannel, path: "svc/ñ.proto", bytes: Buffer.byteLength("syntax = \"proto3\"; // ñ", "utf8") },
      ]);

      // Permissions: the cleared role lost its rows; the new one got its own.
      const perms = await ds.query(
        `SELECT "roleId", "access", "dataScope" FROM "role_endpoint_permissions" WHERE "endpointId" = $1`,
        [permEndpoint],
      );
      assert.deepEqual(perms, [{ roleId: newRole, access: "allow", dataScope: "own" }]);
      // Rules replaced whole.
      const rules = await ds.query(`SELECT "sourceRoleId", "targetRoleId", "canWrite" FROM "role_rules" WHERE "projectId" = $1`, [pid]);
      assert.deepEqual(rules, [{ sourceRoleId: newRole, targetRoleId: otherRole, canWrite: true }]);

      // The project now points at the new environment; the fork carries the new version.
      const [project] = await ds.query(`SELECT "activeEnvironmentId" FROM "projects" WHERE "id" = $1`, [pid]);
      assert.equal(project.activeEnvironmentId, newEnvironment);
      assert.equal((await repo().findByFork(pid))?.version, 2);

      // The merge request is merged in the same transaction, with its line in the thread.
      const [merged] = await ds.query(`SELECT "status", "mergedVersion" FROM "fork_merge_requests" WHERE "id" = $1`, [
        request.id,
      ]);
      assert.deepEqual(merged, { status: "merged", mergedVersion: 2 });
      assert.equal(await countRows(ds, "fork_merge_request_events", `"id" = $1`, [event.id]), 1);
    });

    test("apply with an empty rules list clears the project's rules", async () => {
      const { fork: f } = await forked();
      const pid = f.forkProjectId;
      const a = await insertRole(db.dataSource, pid);
      const b = await insertRole(db.dataSource, pid);
      await insertRow(db.dataSource, "role_rules", { projectId: pid, sourceRoleId: a, targetRoleId: b });
      await repo().apply(
        emptyPlan(f, { roles: { save: [], remove: [], permissions: { clear: [], save: [] }, rules: [] } }),
      );
      assert.equal(await countRows(db.dataSource, "role_rules", `"projectId" = $1`, [pid]), 0);
    });

    test("a failing write rolls the whole plan back", async () => {
      const { fork: f } = await forked();
      const pid = f.forkProjectId;
      const doomed = await insertEnvironment(db.dataSource, pid, { name: "doomed" });
      await insertWorkflow(db.dataSource, pid, { name: "taken" });
      const plan = emptyPlan(f, {
        environments: { save: [], remove: [doomed] },
        workflows: {
          save: [
            {
              id: randomUUID(),
              projectId: pid,
              name: "taken", // unique (projectId, name): the transaction fails here
              description: null,
              status: "ready",
              definition: { steps: [] } as never,
              createdAt: new Date(),
              updatedAt: new Date(),
              updatedBy: randomUUID(),
              deletedAt: null,
            },
          ],
          remove: [],
        },
      });
      await assert.rejects(repo().apply(plan), /duplicate|unique/i);
      assert.equal(await countRows(db.dataSource, "environments", `"id" = $1`, [doomed]), 1);
      assert.equal((await repo().findByFork(pid))?.version, 1);
    });
  });
});
