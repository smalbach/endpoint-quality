/**
 * Los dos repositorios de colecciones contra un Postgres de verdad: el árbol que vive en una
 * columna `jsonb` y las corridas de él.
 *
 * Lo que se comprueba aquí y no se puede comprobar con un doble en memoria: que el documento
 * entero vuelve tal cual de la columna, que el `projectId` que lleva **toda** lectura de verdad
 * impide alcanzar la colección de otro proyecto, y que la consulta que la lista usa para enseñar
 * «cómo acabó la última» devuelve una sola corrida por colección en una sola ida a la base.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { CollectionEntity, CollectionRunEntity } from "@/shared/database/entities";
import {
  TypeOrmCollectionRepository,
  TypeOrmCollectionRunRepository,
} from "@/modules/collections/infrastructure/persistence/typeorm-collection.repository";
import {
  EMPTY_DOCUMENT,
  EMPTY_TOTALS,
  emptyFolder,
  emptyRequest,
  type CollectionDocument,
  type CollectionItem,
  type CollectionRow,
  type CollectionRun,
} from "@/modules/collections/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, countRows, plain, seedTenant, type Tenant } from "../support/repos-seed-b";

const requestItem = (name: string): CollectionItem => ({
  id: randomUUID(),
  kind: "request",
  name,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: null,
  request: { ...emptyRequest(), url: `{{baseUrl}}/${name}` },
  items: [],
});

describe("TypeOrmCollectionRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmCollectionRepository;

  const document = (): CollectionDocument => ({
    ...EMPTY_DOCUMENT,
    auth: { type: "bearer", params: { token: "{{access_token}}" } },
    variables: [{ key: "widget_id", value: "", enabled: true }],
    preRequestScript: "console.log(1)",
    items: [{ ...emptyFolder(randomUUID(), "01 · Widgets"), items: [requestItem("crear")] }],
  });

  const row = (projectId: string, fields: Partial<CollectionRow> = {}): CollectionRow => ({
    id: randomUUID(),
    projectId,
    name: `col-${randomUUID().slice(0, 6)}`,
    description: "",
    document: document(),
    createdAt: at(0),
    updatedAt: at(0),
    updatedBy: randomUUID(),
    ...fields,
  });

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmCollectionRepository(db.dataSource.getRepository(CollectionEntity));
  });
  after(async () => db?.drop());

  test("el documento entero vuelve de la columna tal como entró", async () => {
    const saved = row(tenant.projectId, { name: "Widgets", description: "La del catálogo" });
    await repo.save(saved);

    const found = await repo.find(tenant.projectId, saved.id);
    assert.deepEqual(plain(found), saved);
    // El árbol no se aplana ni pierde el orden al pasar por `jsonb`.
    assert.equal(found?.document.items[0].items[0].request?.url, saved.document.items[0].items[0].request?.url);
    assert.deepEqual(found?.document.variables, [{ key: "widget_id", value: "", enabled: true }]);
  });

  test("guardar otra vez la misma fila la actualiza en vez de duplicarla", async () => {
    const saved = row(tenant.projectId, { name: "Editable" });
    await repo.save(saved);
    await repo.save({ ...saved, description: "editada", updatedAt: at(60), document: EMPTY_DOCUMENT });

    const found = await repo.find(tenant.projectId, saved.id);
    assert.equal(found?.description, "editada");
    assert.deepEqual(found?.document.items, []);
    assert.equal(await countRows(db.dataSource, "collections", `id = $1`, [saved.id]), 1);
  });

  test("la lista es la del proyecto, por nombre", async () => {
    const own = await seedTenant(db.dataSource);
    await repo.save(row(own.projectId, { name: "Zeta" }));
    await repo.save(row(own.projectId, { name: "Alfa" }));
    await repo.save(row(own.otherProjectId, { name: "De otro" }));

    assert.deepEqual(
      (await repo.list(own.projectId)).map((entry) => entry.name),
      ["Alfa", "Zeta"],
    );
    assert.deepEqual(
      (await repo.list(own.otherProjectId)).map((entry) => entry.name),
      ["De otro"],
    );
  });

  test("saber el id de la colección de otro proyecto no basta para leerla ni para borrarla", async () => {
    const own = await seedTenant(db.dataSource);
    const mine = row(own.projectId, { name: "Mía" });
    await repo.save(mine);

    assert.equal(await repo.find(own.otherProjectId, mine.id), null);
    assert.equal(await repo.find(own.projectId, randomUUID()), null);

    await repo.delete(own.otherProjectId, mine.id);
    assert.notEqual(await repo.find(own.projectId, mine.id), null, "el borrado de otro proyecto no la tocó");

    await repo.delete(own.projectId, mine.id);
    assert.equal(await repo.find(own.projectId, mine.id), null);
  });

  test("el nombre se busca dentro del proyecto: es lo que decide si importar crea o actualiza", async () => {
    const own = await seedTenant(db.dataSource);
    const mine = row(own.projectId, { name: "Catalog API" });
    await repo.save(mine);
    await repo.save(row(own.otherProjectId, { name: "Catalog API" }));

    assert.equal((await repo.findByName(own.projectId, "Catalog API"))?.id, mine.id);
    assert.equal(await repo.findByName(own.projectId, "Catalog"), null);
  });
});

describe("TypeOrmCollectionRunRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmCollectionRunRepository;

  const run = (projectId: string, fields: Partial<CollectionRun> = {}): CollectionRun => ({
    id: randomUUID(),
    organizationId: tenant.organizationId,
    projectId,
    collectionId: randomUUID(),
    collectionName: "Widgets",
    environmentId: null,
    environmentName: null,
    status: "passed",
    iterations: 1,
    delayMs: 0,
    stopOnFailure: false,
    folderId: null,
    folderName: null,
    totals: { ...EMPTY_TOTALS },
    results: [],
    startedAt: at(0),
    finishedAt: null,
    error: null,
    startedBy: randomUUID(),
    ...fields,
  });

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmCollectionRunRepository(db.dataSource.getRepository(CollectionRunEntity));
  });
  after(async () => db?.drop());

  test("una corrida vuelve entera, con sus totales y sus resultados", async () => {
    const saved = run(tenant.projectId, {
      status: "failed",
      environmentId: randomUUID(),
      environmentName: "local",
      iterations: 3,
      delayMs: 250,
      stopOnFailure: true,
      folderId: "f-1",
      folderName: "01 · Widgets",
      totals: { requests: 2, failed: 1, tests: 3, testsPassed: 2, testsFailed: 1 },
      results: [
        {
          iteration: 1,
          itemId: "i-1",
          name: "crear",
          folder: "01 · Widgets",
          method: "POST",
          url: "https://api.test/widgets",
          status: 201,
          durationMs: 12,
          sizeBytes: 34,
          tests: [{ name: "crea", passed: true, message: null }],
          error: null,
          logs: [{ level: "warn", text: "ojo" }],
          sent: {
            method: "POST",
            url: "https://api.test/widgets",
            headers: { "content-type": "application/json" },
            body: '{"name":"uno"}',
            bodyTruncated: false,
          },
          received: {
            status: 201,
            headers: { "x-request-id": "abc" },
            body: '{"id":"1"}',
            bodyTruncated: false,
            sizeBytes: 34,
            durationMs: 12,
            timing: { dnsMs: 1, ttfbMs: 10, downloadMs: 1 },
          },
          auth: "Bearer del entorno «local»",
          cookies: { sent: ["sid=api.test/"], stored: ["sid"], rejected: [{ line: "a=b", why: "otro dominio" }] },
          writes: [{ key: "widget_id", value: "1" }],
          scripts: { pre: null, post: { error: null, durationMs: 2 } },
        },
      ],
      finishedAt: at(30),
      error: "algo pasó",
    });
    await repo.save(saved);

    assert.deepEqual(plain(await repo.find(tenant.projectId, saved.id)), saved);
    assert.deepEqual(plain(await repo.findById(saved.id)), saved);
  });

  test("saber el id de una corrida de otro proyecto no basta para leerla ni para borrarla", async () => {
    const own = await seedTenant(db.dataSource);
    const mine = run(own.projectId);
    await repo.save(mine);

    assert.equal(await repo.find(own.otherProjectId, mine.id), null);
    assert.equal(await repo.find(own.projectId, randomUUID()), null);
    assert.equal(await repo.findById(randomUUID()), null);

    await repo.delete(own.otherProjectId, mine.id);
    assert.notEqual(await repo.find(own.projectId, mine.id), null);
    await repo.delete(own.projectId, mine.id);
    assert.equal(await repo.find(own.projectId, mine.id), null);
  });

  test("la lista son las del proyecto, la más nueva primero, y se puede estrechar a una colección", async () => {
    const own = await seedTenant(db.dataSource);
    const primera = randomUUID();
    const segunda = randomUUID();
    await repo.save(run(own.projectId, { collectionId: primera, startedAt: at(10) }));
    await repo.save(run(own.projectId, { collectionId: primera, startedAt: at(30) }));
    await repo.save(run(own.projectId, { collectionId: segunda, startedAt: at(20) }));
    await repo.save(run(own.otherProjectId, { collectionId: primera, startedAt: at(40) }));

    assert.deepEqual(
      (await repo.list(own.projectId)).map((entry) => entry.startedAt),
      [at(30), at(20), at(10)],
    );
    assert.deepEqual(
      (await repo.list(own.projectId, primera)).map((entry) => entry.startedAt),
      [at(30), at(10)],
    );
    assert.deepEqual(await repo.list(own.projectId, randomUUID()), []);
  });

  test("la última de cada colección sale en una consulta, y sin proyecto que mirar no sale ninguna", async () => {
    const own = await seedTenant(db.dataSource);
    assert.deepEqual([...(await repo.latestByCollection(own.projectId))], []);

    const primera = randomUUID();
    const segunda = randomUUID();
    await repo.save(run(own.projectId, { collectionId: primera, startedAt: at(10), status: "failed" }));
    const ultima = run(own.projectId, { collectionId: primera, startedAt: at(30), status: "passed" });
    await repo.save(ultima);
    await repo.save(run(own.projectId, { collectionId: segunda, startedAt: at(20), status: "cancelled" }));
    await repo.save(run(own.otherProjectId, { collectionId: primera, startedAt: at(90) }));

    const latest = await repo.latestByCollection(own.projectId);
    assert.equal(latest.size, 2);
    assert.equal(latest.get(primera)?.id, ultima.id);
    assert.equal(latest.get(primera)?.status, "passed");
    assert.equal(latest.get(segunda)?.status, "cancelled");
  });
});
