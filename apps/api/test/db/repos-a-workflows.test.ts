/**
 * The workflows adapter against a real Postgres (an isolated schema): the four tables it owns, each
 * scoped by project, ordered by name, with the jsonb defaults the entity declares, and the two
 * «is this referenced» questions asked in SQL over the documents.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  RequestTemplateEntity,
  WorkflowDatasetEntity,
  WorkflowEntity,
  WorkflowSuiteEntity,
} from "@/shared/database/entities";
import { TypeOrmWorkflowRepository } from "@/modules/workflows/infrastructure/persistence/typeorm-workflow.repository";
import type { DatasetRow, RequestTemplateRow, SuiteRow, WorkflowRow } from "@/modules/workflows/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import { countRows, insertProject } from "@test/support/repos-seed";

const at = (iso: string) => new Date(iso);
const stamp = { createdAt: at("2026-01-01T00:00:00Z"), updatedAt: at("2026-01-02T00:00:00Z") };

describe("TypeOrmWorkflowRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  const repo = () =>
    new TypeOrmWorkflowRepository(
      db.dataSource.getRepository(RequestTemplateEntity),
      db.dataSource.getRepository(WorkflowEntity),
      db.dataSource.getRepository(WorkflowDatasetEntity),
      db.dataSource.getRepository(WorkflowSuiteEntity),
    );
  const template = (projectId: string, overrides: Partial<RequestTemplateRow> = {}): RequestTemplateRow =>
    ({
      id: randomUUID(),
      projectId,
      name: `tpl-${randomUUID().slice(0, 6)}`,
      operationId: "getThing",
      description: null,
      expectedStatus: 200,
      parameters: { id: "1" },
      disabledParameters: { debug: "true" },
      headers: { "x-tenant": "a" },
      disabledHeaders: {},
      body: { type: "json", json: { a: 1 } },
      auth: "default",
      ...stamp,
      updatedBy: randomUUID(),
      ...overrides,
    }) as RequestTemplateRow;
  const workflow = (projectId: string, overrides: Partial<WorkflowRow> = {}): WorkflowRow => ({
    id: randomUUID(),
    projectId,
    name: `wf-${randomUUID().slice(0, 6)}`,
    description: "a flow",
    status: "draft",
    definition: { steps: [] } as never,
    ...stamp,
    updatedBy: randomUUID(),
    deletedAt: null,
    ...overrides,
  });
  const dataset = (projectId: string, workflowId: string, overrides: Partial<DatasetRow> = {}): DatasetRow => ({
    id: randomUUID(),
    projectId,
    workflowId,
    name: `ds-${randomUUID().slice(0, 6)}`,
    rows: [{ sku: "A" }, { sku: "B" }],
    ...stamp,
    updatedBy: randomUUID(),
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  });
  const suite = (projectId: string, overrides: Partial<SuiteRow> = {}): SuiteRow => ({
    id: randomUUID(),
    projectId,
    name: `suite-${randomUUID().slice(0, 6)}`,
    description: null,
    workflowIds: [],
    ...stamp,
    updatedBy: randomUUID(),
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  });

  describe("templates", () => {
    test("save/find by id and by name round-trip, scoped to the project", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const t = template(pid);
      await repo().saveTemplate(t);
      assert.deepEqual(await repo().findTemplate(pid, t.id), t);
      assert.deepEqual(await repo().findTemplateByName(pid, t.name), t);
      assert.equal(await repo().findTemplate(other, t.id), null);
      assert.equal(await repo().findTemplateByName(other, t.name), null);
    });

    test("the jsonb columns the row leaves out take the entity's defaults", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const id = randomUUID();
      await repo().saveTemplate({
        id,
        projectId: pid,
        name: "bare",
        operationId: "op",
        description: null,
        expectedStatus: 204,
        ...stamp,
        updatedBy: randomUUID(),
      } as unknown as RequestTemplateRow);
      const found = await repo().findTemplate(pid, id);
      assert.deepEqual(found?.parameters, {});
      assert.deepEqual(found?.headers, {});
      assert.deepEqual(found?.disabledParameters, {});
      assert.deepEqual(found?.disabledHeaders, {});
      assert.deepEqual(found?.body, { type: "none" });
      assert.equal(found?.auth, "default");
    });

    test("listTemplates is by name; deleteTemplate is scoped to the project; names are unique", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const b = template(pid, { name: "b" });
      const a = template(pid, { name: "a" });
      await repo().saveTemplate(b);
      await repo().saveTemplate(a);
      await repo().saveTemplate(template(other, { name: "0" }));
      assert.deepEqual(
        (await repo().listTemplates(pid)).map((t) => t.name),
        ["a", "b"],
      );

      await repo().deleteTemplate(other, a.id);
      assert.notEqual(await repo().findTemplate(pid, a.id), null);
      await repo().deleteTemplate(pid, a.id);
      assert.equal(await repo().findTemplate(pid, a.id), null);

      await assert.rejects(repo().saveTemplate(template(pid, { name: "b" })), /duplicate|unique/i);
    });

    test("isTemplateReferenced looks inside this project's flow documents only", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const used = template(pid);
      const unused = template(pid);
      await repo().saveTemplate(used);
      await repo().saveTemplate(unused);
      await repo().saveWorkflow(
        workflow(pid, {
          definition: { steps: [{ id: "s1", requestTemplateId: used.id }, { id: "s2", kind: "delay" }] } as never,
        }),
      );
      await repo().saveWorkflow(
        workflow(other, { definition: { steps: [{ id: "s1", requestTemplateId: unused.id }] } as never }),
      );
      assert.equal(await repo().isTemplateReferenced(pid, used.id), true);
      assert.equal(await repo().isTemplateReferenced(pid, unused.id), false);
      assert.equal(await repo().isTemplateReferenced(other, used.id), false);
    });
  });

  describe("workflows", () => {
    test("save/find by id and name round-trip; not found is null; listed by name", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const w = workflow(pid, { name: "zeta", definition: { steps: [{ id: "a" }] } as never });
      const w2 = workflow(pid, { name: "alpha", status: "archived", description: null });
      await repo().saveWorkflow(w);
      await repo().saveWorkflow(w2);
      await repo().saveWorkflow(workflow(other));
      assert.deepEqual(await repo().findWorkflow(pid, w.id), w);
      assert.deepEqual(await repo().findWorkflowByName(pid, "alpha"), w2);
      assert.equal(await repo().findWorkflow(other, w.id), null);
      assert.equal(await repo().findWorkflowByName(pid, "nope"), null);
      assert.deepEqual(
        (await repo().listWorkflows(pid)).map((x) => x.name),
        ["alpha", "zeta"],
      );
    });

    test("a workflow saved without status or definition gets «ready» and an empty graph", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const id = randomUUID();
      await repo().saveWorkflow({ id, projectId: pid, name: "bare", description: null, ...stamp, updatedBy: randomUUID() } as unknown as WorkflowRow);
      const found = await repo().findWorkflow(pid, id);
      assert.equal(found?.status, "ready");
      assert.deepEqual(found?.definition, { steps: [] });
    });

    test("deleteWorkflow is scoped, and takes its datasets with it", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const w = workflow(pid);
      await repo().saveWorkflow(w);
      const d = dataset(pid, w.id);
      await repo().saveDataset(d);

      await repo().deleteWorkflow(other, w.id);
      assert.notEqual(await repo().findWorkflow(pid, w.id), null);
      await repo().deleteWorkflow(pid, w.id);
      assert.equal(await repo().findWorkflow(pid, w.id), null);
      assert.equal(await repo().findDataset(pid, d.id), null);
    });

    test("isWorkflowReferenced asks the suites of this project", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const used = workflow(pid);
      const unused = workflow(pid);
      await repo().saveWorkflow(used);
      await repo().saveWorkflow(unused);
      await repo().saveSuite(suite(pid, { workflowIds: [used.id] }));
      await repo().saveSuite(suite(other, { workflowIds: [unused.id] }));
      assert.equal(await repo().isWorkflowReferenced(pid, used.id), true);
      assert.equal(await repo().isWorkflowReferenced(pid, unused.id), false);
      assert.equal(await repo().isWorkflowReferenced(other, used.id), false);
    });
  });

  describe("datasets", () => {
    test("save/find round-trip; by name is per workflow; listed by name; delete is scoped", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const w = workflow(pid);
      const w2 = workflow(pid);
      await repo().saveWorkflow(w);
      await repo().saveWorkflow(w2);
      const b = dataset(pid, w.id, { name: "b" });
      const a = dataset(pid, w2.id, { name: "a" });
      await repo().saveDataset(b);
      await repo().saveDataset(a);

      assert.deepEqual(await repo().findDataset(pid, b.id), b);
      assert.equal(await repo().findDataset(other, b.id), null);
      assert.deepEqual(await repo().findDatasetByName(w.id, "b"), b);
      assert.equal(await repo().findDatasetByName(w2.id, "b"), null);
      assert.deepEqual(
        (await repo().listDatasets(pid)).map((d) => d.name),
        ["a", "b"],
      );
      assert.deepEqual(await repo().listDatasets(other), []);

      await repo().deleteDataset(other, b.id);
      assert.notEqual(await repo().findDataset(pid, b.id), null);
      await repo().deleteDataset(pid, b.id);
      assert.equal(await repo().findDataset(pid, b.id), null);
    });

    test("two datasets with one name in the same workflow collide; save of the same id updates", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const w = workflow(pid);
      await repo().saveWorkflow(w);
      const d = dataset(pid, w.id, { name: "same" });
      await repo().saveDataset(d);
      await repo().saveDataset({ ...d, rows: [{ sku: "Z" }] });
      assert.deepEqual((await repo().findDataset(pid, d.id))?.rows, [{ sku: "Z" }]);
      await assert.rejects(repo().saveDataset(dataset(pid, w.id, { name: "same" })), /duplicate|unique/i);
    });
  });

  describe("suites", () => {
    test("save/find by id and name round-trip; listed by name; delete is scoped", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const ids = [randomUUID(), randomUUID()];
      const s = suite(pid, { name: "smoke", workflowIds: ids, description: "before release" });
      const s2 = suite(pid, { name: "nightly" });
      await repo().saveSuite(s);
      await repo().saveSuite(s2);

      assert.deepEqual(await repo().findSuite(pid, s.id), s);
      assert.deepEqual(await repo().findSuiteByName(pid, "smoke"), s);
      assert.equal(await repo().findSuite(other, s.id), null);
      assert.equal(await repo().findSuiteByName(other, "smoke"), null);
      assert.deepEqual(
        (await repo().listSuites(pid)).map((x) => x.name),
        ["nightly", "smoke"],
      );

      await repo().deleteSuite(other, s.id);
      assert.notEqual(await repo().findSuite(pid, s.id), null);
      await repo().deleteSuite(pid, s.id);
      assert.equal(await repo().findSuite(pid, s.id), null);
      await assert.rejects(repo().saveSuite(suite(pid, { name: "nightly" })), /duplicate|unique/i);
    });
  });

  test("everything goes with the project (cascade)", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const w = workflow(pid);
    await repo().saveWorkflow(w);
    await repo().saveTemplate(template(pid));
    await repo().saveDataset(dataset(pid, w.id));
    await repo().saveSuite(suite(pid, { workflowIds: [w.id] }));
    await db.dataSource.query(`DELETE FROM "projects" WHERE "id" = $1`, [pid]);
    for (const table of ["workflows", "request_templates", "workflow_datasets", "workflow_suites"])
      assert.equal(await countRows(db.dataSource, table, `"projectId" = $1`, [pid]), 0, table);
  });
});
