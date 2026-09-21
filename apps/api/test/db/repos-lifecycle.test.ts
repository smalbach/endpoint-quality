/**
 * Lo que el ciclo de vida solo se puede demostrar contra Postgres.
 *
 * Los dobles en memoria imitan los filtros, y por eso los comandos se prueban con ellos. Lo que no
 * imitan es el SQL: el `WHERE` de cada estado, el índice único **parcial** que deja libre el nombre
 * de lo eliminado, y las cascadas que se llevan lo de al lado solo en el borrado de verdad. Eso es
 * lo que hay aquí.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  ChannelEndpointEntity,
  ChannelMessageEntity,
  ChannelSessionEntity,
  DocSiteEntity,
  EndpointEntity,
  EnvironmentCredentialEntity,
  EnvironmentEntity,
  MockCallEntity,
  MockServerEntity,
  MonitorEntity,
  MonitorExecutionEntity,
  PerformancePlanEntity,
  RequestTemplateEntity,
  RoleEntity,
  RolePermissionEntity,
  RoleRuleEntity,
  WorkflowDatasetEntity,
  WorkflowEntity,
  WorkflowSuiteEntity,
} from "@/shared/database/entities";
import { TypeOrmChannelRepository } from "@/modules/channels/infrastructure/persistence/typeorm-channel.repository";
import { TypeOrmEnvironmentRepository } from "@/modules/environments/infrastructure/persistence/typeorm-environment.repository";
import { TypeOrmEndpointRepository } from "@/modules/endpoints/infrastructure/persistence/typeorm-endpoint.repository";
import { TypeOrmWorkflowRepository } from "@/modules/workflows/infrastructure/persistence/typeorm-workflow.repository";
import { TypeOrmRoleRepository } from "@/modules/roles/infrastructure/persistence/typeorm-role.repository";
import { TypeOrmPerformancePlanRepository } from "@/modules/performance/infrastructure/persistence/typeorm-performance.repository";
import { TypeOrmMockRepository } from "@/modules/mocks/infrastructure/persistence/typeorm-mock.repository";
import { TypeOrmDocSiteRepository } from "@/modules/docs/infrastructure/persistence/typeorm-doc-site.repository";
import { TypeOrmMonitorRepository } from "@/modules/monitors/infrastructure/persistence/typeorm-monitor.repository";
import type { Channel } from "@/modules/channels/domain/model";
import type { Environment } from "@/modules/environments/domain/model";
import type { Endpoint } from "@/modules/endpoints/domain/model";
import type { DatasetRow, SuiteRow, WorkflowRow } from "@/modules/workflows/domain/model";
import type { Role } from "@/modules/roles/domain/model";
import type { PerformancePlanRow } from "@/modules/performance/domain/model";
import type { MockServer } from "@/modules/mocks/domain/model";
import type { DocSite } from "@/modules/docs/domain/model";
import type { Monitor } from "@/modules/monitors/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, seedTenant, type Tenant } from "../support/repos-seed-b";

describe("el ciclo de vida contra Postgres", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
  });
  after(async () => db?.drop());

  const stamp = () => ({ createdAt: at(0), updatedAt: at(0), updatedBy: tenant.userId });

  /**
   * Los ids de esta prueba que salieron en la lista.
   *
   * El esquema es uno por fichero, así que las filas de una prueba siguen ahí en la siguiente:
   * comparar la lista entera haría que añadir una prueba rompiera otra. Lo que se afirma es que
   * **estos** salen, y los demás de esta prueba no.
   */
  const mine = (rows: { id: string }[], ids: string[]) => rows.map((row) => row.id).filter((id) => ids.includes(id));

  describe("canales", () => {
    const repo = () => new TypeOrmChannelRepository(db.dataSource.getRepository(ChannelEndpointEntity));
    const channel = (fields: Partial<Channel> = {}): Channel =>
      ({
        id: randomUUID(),
        projectId: tenant.projectId,
        protocol: "ws",
        name: `c-${randomUUID().slice(0, 6)}`,
        url: "wss://example.test/socket",
        subprotocols: [],
        headers: [],
        auth: null,
        limits: { maxMessages: 10 },
        expectations: {},
        messages: [],
        mqtt: null,
        grpc: null,
        socketio: null,
        orderIndex: 0,
        createdAt: at(0),
        updatedAt: at(0),
        updatedBy: null,
        archivedAt: null,
        deletedAt: null,
        ...fields,
      }) as unknown as Channel;

    test("cada estado tiene su lista, el tope cuenta los vivos, y por id solo se resuelve el vivo", async () => {
      const store = repo();
      const live = channel();
      const archived = channel({ archivedAt: at(10) });
      const deleted = channel({ deletedAt: at(20) });
      for (const row of [live, archived, deleted]) await store.save(row);

      const ids = [live.id, archived.id, deleted.id];
      assert.deepEqual(mine(await store.listByProject(tenant.projectId), ids), [live.id]);
      assert.deepEqual(mine(await store.listByProject(tenant.projectId, "archived"), ids), [archived.id]);
      assert.deepEqual(mine(await store.listByProject(tenant.projectId, "deleted"), ids), [deleted.id]);
      assert.equal(await store.countByProject(tenant.projectId), 1, "lo archivado y lo borrado no ocupan sitio");

      assert.ok(await store.findById(tenant.projectId, live.id));
      assert.equal(await store.findById(tenant.projectId, archived.id), null);
      assert.equal(await store.findById(tenant.projectId, deleted.id), null);
      // En cualquier estado, y solo dentro de su proyecto.
      assert.ok(await store.findAnyById(tenant.projectId, deleted.id));
      assert.equal(await store.findAnyById(tenant.otherProjectId, deleted.id), null);
    });

    test("el borrado de verdad se lleva sus sesiones y sus mensajes", async () => {
      const store = repo();
      const row = channel({ deletedAt: at(20) });
      await store.save(row);
      const sessionId = randomUUID();
      await db.dataSource.query(
        `INSERT INTO channel_sessions
           (id, "channelId", "projectId", status, counters, "ownerInstance", "openedAt", "heartbeatAt", "startedBy")
         VALUES ($1, $2, $3, 'closed', '{}'::jsonb, 'i', now(), now(), $4)`,
        [sessionId, row.id, tenant.projectId, tenant.userId],
      );
      // `channel_messages` tiene clave compuesta `(sessionId, seq)` y no `id`: ver la migración.
      await db.dataSource.query(
        `INSERT INTO channel_messages ("sessionId", seq, direction, "atMs", kind, body, bytes, truncated)
         VALUES ($1, 1, 'in', 0, 'text', '', 0, false)`,
        [sessionId],
      );

      assert.equal(await store.remove(tenant.projectId, row.id), true);
      assert.equal(await store.remove(tenant.projectId, row.id), false, "la segunda vez ya no hay fila");
      assert.equal(await db.dataSource.getRepository(ChannelSessionEntity).count({ where: { id: sessionId } }), 0);
      assert.equal(await db.dataSource.getRepository(ChannelMessageEntity).count({ where: { sessionId } }), 0);
    });
  });

  describe("entornos", () => {
    const repo = () =>
      new TypeOrmEnvironmentRepository(
        db.dataSource.getRepository(EnvironmentEntity),
        db.dataSource.getRepository(EnvironmentCredentialEntity),
      );
    const environment = (fields: Partial<Environment> = {}): Environment =>
      ({
        id: randomUUID(),
        projectId: tenant.projectId,
        name: `e-${randomUUID().slice(0, 6)}`,
        baseUrl: "https://api.example.com",
        specUrl: null,
        variables: {},
        disabledVariables: {},
        writesAllowed: false,
        authEnforced: false,
        createdAt: at(0),
        archivedAt: null,
        deletedAt: null,
        ...fields,
      }) as Environment;

    test("el nombre de lo eliminado queda libre, y solo el vivo se resuelve por id o por nombre", async () => {
      const store = repo();
      const deleted = environment({ name: "staging", deletedAt: at(20) });
      await store.save(deleted);
      assert.equal(await store.findByName(tenant.projectId, "staging"), null, "el nombre está libre");

      // El índice único es parcial: otro «staging» vivo entra sin chocar.
      const live = environment({ name: "staging" });
      await store.save(live);
      assert.equal((await store.findByName(tenant.projectId, "staging"))!.id, live.id);
      assert.equal(await store.findById(deleted.id), null);
      assert.ok(await store.findAnyById(deleted.id));
      assert.equal(await store.findAnyById(randomUUID()), null, "un id que no está es nulo, no un error");
      assert.deepEqual(mine(await store.listForProject(tenant.projectId, "deleted"), [deleted.id, live.id]), [
        deleted.id,
      ]);

      // Y dos vivos con el mismo nombre siguen siendo imposibles.
      await assert.rejects(store.save(environment({ name: "staging" })), /duplicate key|unique/i);
    });
  });

  describe("endpoints", () => {
    const repo = () => new TypeOrmEndpointRepository(db.dataSource.getRepository(EndpointEntity));
    const endpoint = (fields: Partial<Endpoint> = {}): Endpoint =>
      ({
        id: randomUUID(),
        projectId: tenant.projectId,
        method: "GET",
        path: `/p-${randomUUID().slice(0, 6)}`,
        description: "",
        pathParameters: [],
        query: [],
        headers: [],
        body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
        requiresAuth: false,
        auth: { type: "inherit", params: {} },
        tags: [],
        status: "active",
        origin: "manual",
        operationId: null,
        orderIndex: 0,
        preRequestScript: "",
        postResponseScript: "",
        createdAt: at(0),
        updatedAt: at(0),
        updatedBy: tenant.userId,
        deletedAt: null,
        ...fields,
      }) as unknown as Endpoint;

    const filter = (deleted: boolean) => ({ status: "all" as const, search: "", deleted, offset: 0, limit: 50 });

    test("la papelera es otra lista y se cuenta aparte; restaurar y purgar solo tocan lo borrado", async () => {
      const store = repo();
      const live = endpoint();
      const deleted = endpoint({ deletedAt: at(20) });
      await store.saveMany([live, deleted]);

      const ids = [live.id, deleted.id];
      assert.deepEqual(mine((await store.list(tenant.projectId, filter(false))).rows, ids), [live.id]);
      assert.deepEqual(mine((await store.list(tenant.projectId, filter(true))).rows, ids), [deleted.id]);
      assert.equal(await store.countDeleted(tenant.projectId), 1);

      // Restaurar no toca lo que está vivo, y purgar no toca lo que no está borrado.
      assert.equal(await store.restore(tenant.projectId, [live.id], at(30)), 0);
      assert.equal(await store.purge(tenant.projectId, [live.id]), 0);
      assert.equal(await store.restore(tenant.projectId, [], at(30)), 0, "sin ids no hay consulta");
      assert.equal(await store.purge(tenant.projectId, []), 0);

      assert.equal(await store.restore(tenant.projectId, [deleted.id], at(30)), 1);
      assert.equal(await store.countDeleted(tenant.projectId), 0);
      const back = (await store.findById(tenant.projectId, deleted.id))!;
      assert.deepEqual(back.updatedAt, at(30), "la fila cambió de estado, y su fecha lo dice");

      await store.softDelete(tenant.projectId, [deleted.id], at(40));
      assert.equal(await store.purge(tenant.projectId, [deleted.id]), 1);
      assert.equal(await store.findById(tenant.projectId, deleted.id), null);
    });

    test("restaurar uno cuyo método y ruta se reutilizaron choca con el índice parcial", async () => {
      const store = repo();
      const first = endpoint({ path: "/repetido" });
      await store.save(first);
      await store.softDelete(tenant.projectId, [first.id], at(20));
      // Libre mientras está en la papelera: el índice único solo cuenta lo vivo.
      await store.save(endpoint({ path: "/repetido" }));
      await assert.rejects(store.restore(tenant.projectId, [first.id], at(30)), /duplicate key|unique/i);
    });
  });

  describe("flujos, conjuntos y suites", () => {
    const repo = () =>
      new TypeOrmWorkflowRepository(
        db.dataSource.getRepository(RequestTemplateEntity),
        db.dataSource.getRepository(WorkflowEntity),
        db.dataSource.getRepository(WorkflowDatasetEntity),
        db.dataSource.getRepository(WorkflowSuiteEntity),
      );
    const workflow = (fields: Partial<WorkflowRow> = {}): WorkflowRow =>
      ({
        id: randomUUID(),
        projectId: tenant.projectId,
        name: `w-${randomUUID().slice(0, 6)}`,
        description: null,
        status: "ready",
        definition: { steps: [] },
        ...stamp(),
        deletedAt: null,
        ...fields,
      }) as WorkflowRow;
    const dataset = (workflowId: string, fields: Partial<DatasetRow> = {}): DatasetRow =>
      ({
        id: randomUUID(),
        projectId: tenant.projectId,
        workflowId,
        name: `d-${randomUUID().slice(0, 6)}`,
        rows: [],
        ...stamp(),
        archivedAt: null,
        deletedAt: null,
        ...fields,
      }) as DatasetRow;
    const suite = (fields: Partial<SuiteRow> = {}): SuiteRow =>
      ({
        id: randomUUID(),
        projectId: tenant.projectId,
        name: `s-${randomUUID().slice(0, 6)}`,
        description: null,
        workflowIds: [],
        ...stamp(),
        archivedAt: null,
        deletedAt: null,
        ...fields,
      }) as SuiteRow;

    test("para un flujo, `active` es «no eliminado» y `archived` mira su estado", async () => {
      const store = repo();
      const ready = workflow();
      const filed = workflow({ status: "archived" });
      const trashed = workflow({ deletedAt: at(20) });
      for (const row of [ready, filed, trashed]) await store.saveWorkflow(row);

      const ids = [ready.id, filed.id, trashed.id];
      assert.deepEqual(
        mine(await store.listWorkflows(tenant.projectId), ids).sort(),
        [ready.id, filed.id].sort(),
        "el archivado sigue en la lista de trabajo",
      );
      assert.deepEqual(mine(await store.listWorkflows(tenant.projectId, "archived"), ids), [filed.id]);
      assert.deepEqual(mine(await store.listWorkflows(tenant.projectId, "deleted"), ids), [trashed.id]);

      // El nombre de lo eliminado queda libre, y el índice parcial deja entrar otro igual.
      assert.equal(await store.findWorkflowByName(tenant.projectId, trashed.name), null);
      await store.saveWorkflow(workflow({ name: trashed.name }));
    });

    test("una suite eliminada deja de contar como referencia, y un flujo eliminado no ata su petición", async () => {
      const store = repo();
      const flow = workflow();
      await store.saveWorkflow(flow);
      const named = suite({ workflowIds: [flow.id] });
      await store.saveSuite(named);
      assert.equal(await store.isWorkflowReferenced(tenant.projectId, flow.id), true);
      await store.saveSuite({ ...named, deletedAt: at(20) });
      assert.equal(await store.isWorkflowReferenced(tenant.projectId, flow.id), false);

      const template = {
        id: randomUUID(),
        projectId: tenant.projectId,
        name: `t-${randomUUID().slice(0, 6)}`,
        operationId: "op",
        description: null,
        expectedStatus: 200,
        parameters: {},
        disabledParameters: {},
        headers: {},
        disabledHeaders: {},
        body: { type: "none" },
        auth: "default",
        ...stamp(),
      };
      await store.saveTemplate(template as never);
      const user = workflow({ definition: { steps: [{ id: "a", requestTemplateId: template.id }] } as never });
      await store.saveWorkflow(user);
      assert.equal(await store.isTemplateReferenced(tenant.projectId, template.id), true);
      await store.saveWorkflow({ ...user, deletedAt: at(20) });
      assert.equal(await store.isTemplateReferenced(tenant.projectId, template.id), false);
    });

    test("los conjuntos y las suites tienen los tres estados, y el nombre libre al eliminarse", async () => {
      const store = repo();
      const flow = workflow();
      await store.saveWorkflow(flow);
      const live = dataset(flow.id);
      const filed = dataset(flow.id, { archivedAt: at(10) });
      const trashed = dataset(flow.id, { deletedAt: at(20) });
      for (const row of [live, filed, trashed]) await store.saveDataset(row);
      const datasetIds = [live.id, filed.id, trashed.id];
      assert.deepEqual(mine(await store.listDatasets(tenant.projectId), datasetIds), [live.id]);
      assert.deepEqual(mine(await store.listDatasets(tenant.projectId, "archived"), datasetIds), [filed.id]);
      assert.deepEqual(mine(await store.listDatasets(tenant.projectId, "deleted"), datasetIds), [trashed.id]);
      assert.equal(await store.findDatasetByName(flow.id, trashed.name), null);
      await store.saveDataset(dataset(flow.id, { name: trashed.name }));

      const liveSuite = suite();
      const filedSuite = suite({ archivedAt: at(10) });
      const trashedSuite = suite({ deletedAt: at(20) });
      for (const row of [liveSuite, filedSuite, trashedSuite]) await store.saveSuite(row);
      const suiteIds = [liveSuite.id, filedSuite.id, trashedSuite.id];
      assert.deepEqual(mine(await store.listSuites(tenant.projectId), suiteIds), [liveSuite.id]);
      assert.deepEqual(mine(await store.listSuites(tenant.projectId, "archived"), suiteIds), [filedSuite.id]);
      assert.deepEqual(mine(await store.listSuites(tenant.projectId, "deleted"), suiteIds), [trashedSuite.id]);
      assert.equal(await store.findSuiteByName(tenant.projectId, trashedSuite.name), null);
      await store.saveSuite(suite({ name: trashedSuite.name }));
    });

    test("el borrado de verdad de un flujo se lleva sus conjuntos", async () => {
      const store = repo();
      const flow = workflow({ deletedAt: at(20) });
      await store.saveWorkflow(flow);
      const row = dataset(flow.id, { deletedAt: at(20) });
      await store.saveDataset(row);
      await store.deleteWorkflow(tenant.projectId, flow.id);
      assert.equal(await store.findDataset(tenant.projectId, row.id), null);
    });
  });

  describe("roles, planes, mocks, documentaciones y monitores", () => {
    test("cada lista tiene sus tres estados, y lo que resuelve una URL o un nombre mira solo lo vivo", async () => {
      const roles = new TypeOrmRoleRepository(
        db.dataSource.getRepository(RoleEntity),
        db.dataSource.getRepository(RolePermissionEntity),
        db.dataSource.getRepository(RoleRuleEntity),
      );
      const role = (fields: Partial<Role> = {}): Role =>
        ({
          id: randomUUID(),
          projectId: tenant.projectId,
          name: `r-${randomUUID().slice(0, 6)}`,
          description: "",
          color: "#6366f1",
          sameRoleDataIsolation: false,
          position: 0,
          createdAt: at(0),
          updatedAt: at(0),
          archivedAt: null,
          deletedAt: null,
          ...fields,
        }) as Role;
      const liveRole = role();
      const filedRole = role({ archivedAt: at(10) });
      const trashedRole = role({ deletedAt: at(20) });
      for (const row of [liveRole, filedRole, trashedRole]) await roles.save(row);
      const roleIds = [liveRole.id, filedRole.id, trashedRole.id];
      assert.deepEqual(mine(await roles.list(tenant.projectId), roleIds), [liveRole.id]);
      assert.deepEqual(mine(await roles.list(tenant.projectId, "archived"), roleIds), [filedRole.id]);
      assert.deepEqual(mine(await roles.list(tenant.projectId, "deleted"), roleIds), [trashedRole.id]);
      // El nombre del eliminado queda libre: el índice único es parcial.
      await roles.save(role({ name: trashedRole.name }));

      const plans = new TypeOrmPerformancePlanRepository(db.dataSource.getRepository(PerformancePlanEntity));
      const plan = (fields: Partial<PerformancePlanRow> = {}): PerformancePlanRow =>
        ({
          id: randomUUID(),
          projectId: tenant.projectId,
          name: `pl-${randomUUID().slice(0, 6)}`,
          description: null,
          definition: { scenarios: [], profile: { type: "constant", vus: 1, durationS: 1 }, thresholds: {} },
          ...stamp(),
          archivedAt: null,
          deletedAt: null,
          ...fields,
        }) as PerformancePlanRow;
      const livePlan = plan();
      const filedPlan = plan({ archivedAt: at(10) });
      const trashedPlan = plan({ deletedAt: at(20) });
      for (const row of [livePlan, filedPlan, trashedPlan]) await plans.save(row);
      const planIds = [livePlan.id, filedPlan.id, trashedPlan.id];
      assert.deepEqual(mine(await plans.list(tenant.projectId), planIds), [livePlan.id]);
      assert.deepEqual(mine(await plans.list(tenant.projectId, "archived"), planIds), [filedPlan.id]);
      assert.deepEqual(mine(await plans.list(tenant.projectId, "deleted"), planIds), [trashedPlan.id]);
      assert.equal(await plans.findByName(tenant.projectId, trashedPlan.name), null);
      assert.equal((await plans.findByName(tenant.projectId, livePlan.name))!.id, livePlan.id);

      const mocks = new TypeOrmMockRepository(
        db.dataSource.getRepository(MockServerEntity),
        db.dataSource.getRepository(MockCallEntity),
      );
      const mock = (fields: Partial<MockServer> = {}): MockServer =>
        ({
          id: randomUUID(),
          projectId: tenant.projectId,
          name: `m-${randomUUID().slice(0, 6)}`,
          publicId: randomUUID().replace(/-/g, ""),
          visibility: "public",
          apiKeyHash: null,
          apiKeyPreview: "",
          delay: { kind: "none" },
          enabled: true,
          createdAt: at(0),
          updatedAt: at(0),
          createdBy: tenant.userId,
          archivedAt: null,
          deletedAt: null,
          ...fields,
        }) as MockServer;
      const liveMock = mock();
      const filedMock = mock({ archivedAt: at(10) });
      const trashedMock = mock({ deletedAt: at(20) });
      for (const row of [liveMock, filedMock, trashedMock]) await mocks.save(row);
      const mockIds = [liveMock.id, filedMock.id, trashedMock.id];
      assert.deepEqual(mine(await mocks.listByProject(tenant.projectId), mockIds), [liveMock.id]);
      assert.deepEqual(mine(await mocks.listByProject(tenant.projectId, "archived"), mockIds), [filedMock.id]);
      assert.deepEqual(mine(await mocks.listByProject(tenant.projectId, "deleted"), mockIds), [trashedMock.id]);
      // La URL pública solo resuelve lo vivo: lo archivado o borrado deja de servir.
      assert.ok(await mocks.findByPublicId(liveMock.publicId));
      assert.equal(await mocks.findByPublicId(filedMock.publicId), null);
      assert.equal(await mocks.findByPublicId(trashedMock.publicId), null);

      const sites = new TypeOrmDocSiteRepository(db.dataSource.getRepository(DocSiteEntity));
      const site = (fields: Partial<DocSite> = {}): DocSite =>
        ({
          id: randomUUID(),
          projectId: tenant.projectId,
          name: `s-${randomUUID().slice(0, 6)}`,
          publicId: randomUUID().replace(/-/g, ""),
          visibility: "public",
          apiKeyHash: null,
          apiKeyPreview: "",
          baseUrl: "",
          intro: "",
          includeExamples: false,
          enabled: true,
          createdAt: at(0),
          updatedAt: at(0),
          createdBy: tenant.userId,
          archivedAt: null,
          deletedAt: null,
          ...fields,
        }) as DocSite;
      const liveSite = site();
      const filedSite = site({ archivedAt: at(10) });
      const trashedSite = site({ deletedAt: at(20) });
      for (const row of [liveSite, filedSite, trashedSite]) await sites.save(row);
      const siteIds = [liveSite.id, filedSite.id, trashedSite.id];
      assert.deepEqual(mine(await sites.listByProject(tenant.projectId), siteIds), [liveSite.id]);
      assert.deepEqual(mine(await sites.listByProject(tenant.projectId, "archived"), siteIds), [filedSite.id]);
      assert.deepEqual(mine(await sites.listByProject(tenant.projectId, "deleted"), siteIds), [trashedSite.id]);
      assert.ok(await sites.findByPublicId(liveSite.publicId));
      assert.equal(await sites.findByPublicId(filedSite.publicId), null);

      const monitors = new TypeOrmMonitorRepository(
        db.dataSource.getRepository(MonitorEntity),
        db.dataSource.getRepository(MonitorExecutionEntity),
        db.dataSource,
      );
      const monitor = (fields: Partial<Monitor> = {}): Monitor =>
        ({
          id: randomUUID(),
          projectId: tenant.projectId,
          name: `mo-${randomUUID().slice(0, 6)}`,
          enabled: true,
          schedule: { kind: "interval", minutes: 60 },
          plan: { environmentId: randomUUID() },
          alert: null,
          nextRunAt: at(0),
          lastRunAt: null,
          lastOutcome: null,
          consecutiveFailures: 0,
          createdAt: at(0),
          updatedAt: at(0),
          createdBy: tenant.userId,
          archivedAt: null,
          deletedAt: null,
          ...fields,
        }) as unknown as Monitor;
      const liveMonitor = monitor();
      const filedMonitor = monitor({ archivedAt: at(10) });
      const trashedMonitor = monitor({ deletedAt: at(20) });
      for (const row of [liveMonitor, filedMonitor, trashedMonitor]) await monitors.save(row);
      const monitorIds = [liveMonitor.id, filedMonitor.id, trashedMonitor.id];
      assert.deepEqual(mine(await monitors.listByProject(tenant.projectId), monitorIds), [liveMonitor.id]);
      assert.deepEqual(mine(await monitors.listByProject(tenant.projectId, "archived"), monitorIds), [filedMonitor.id]);
      assert.deepEqual(mine(await monitors.listByProject(tenant.projectId, "deleted"), monitorIds), [
        trashedMonitor.id,
      ]);
      // Y el reclamo del turno solo se lleva los vivos: lo apartado no vigila.
      const claimed = await monitors.claimDue(at(100), 10, () => null);
      assert.deepEqual(mine(claimed, monitorIds), [liveMonitor.id]);
    });
  });
});
