/**
 * Los comandos y las consultas de colecciones, sin HTTP y sin base de datos.
 *
 * Aquí viven las decisiones que el camino feliz de `test/http/collections.test.ts` no toma nunca:
 * el nombre repetido, el documento que el esquema rechaza, la carpeta que no está, la corrida que
 * pediría cuatro mil peticiones, el entorno de otro proyecto, y el 404 que contesta igual tanto si
 * el id no existe como si es de otro inquilino.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CommandBus } from "@nestjs/cqrs";

import { FixedClock } from "@/shared/clock/clock.port";
import { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import type { Environment } from "@/modules/environments/domain/model";
import type { SentRequestView } from "@/modules/endpoints/application/commands/send-endpoint-request";
import {
  CreateCollectionCommand,
  CreateCollectionHandler,
  DeleteCollectionCommand,
  DeleteCollectionHandler,
  UpdateCollectionCommand,
  UpdateCollectionHandler,
} from "@/modules/collections/application/commands/manage-collection";
import { ImportPostmanCollectionCommand, ImportPostmanCollectionHandler } from "@/modules/collections/application/commands/import-postman-collection";
import {
  SendCollectionRequestCommand,
  SendCollectionRequestHandler,
} from "@/modules/collections/application/commands/send-collection-request";
import {
  CancelCollectionRunCommand,
  CancelCollectionRunHandler,
  DeleteCollectionRunCommand,
  DeleteCollectionRunHandler,
  MAX_DELAY_MS,
  MAX_ITERATIONS,
  MAX_RUN_REQUESTS,
  RunCollectionCommand,
  RunCollectionHandler,
} from "@/modules/collections/application/commands/run-collection";
import {
  ExportCollectionQuery,
  ExportCollectionHandler,
  GetCollectionQuery,
  GetCollectionHandler,
  GetCollectionRunQuery,
  GetCollectionRunHandler,
  ListCollectionRunsQuery,
  ListCollectionRunsHandler,
  ListCollectionsQuery,
  ListCollectionsHandler,
} from "@/modules/collections/application/queries/read-collections";
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
import { MAX_COLLECTION_ITEMS } from "@/modules/collections/domain/schema";
import type { CollectionRunQueuePort } from "@/modules/collections/domain/ports";
import {
  InMemoryCollectionRepository,
  InMemoryCollectionRunRepository,
  InMemoryEnvironmentRepository,
  InMemoryProjectRepository,
} from "../support/in-memory-repositories";

const NOW = new Date("2026-09-21T10:00:00Z");
const ORG = "o1";
const PROJECT = "p1";
const OTHER_PROJECT = "p2";

const project = (id: string, organizationId = ORG): Project => ({
  id,
  organizationId,
  name: id,
  slug: id,
  description: "",
  createdBy: "u1",
  createdAt: NOW,
  archivedAt: null,
  activeSpecVersionId: null,
  activeEnvironmentId: null,
  baseUrl: "http://api.test",
  tags: [],
  auth: { type: "none", settings: {}, secretCiphertext: null },
  deletedAt: null,
});

const environment = (id: string, projectId: string): Environment => ({
  id,
  projectId,
  name: "local",
  baseUrl: "http://api.test",
  specUrl: null,
  variables: {},
  disabledVariables: {},
  writesAllowed: true,
  authEnforced: false,
  createdAt: NOW,
  archivedAt: null,
  deletedAt: null,
});

const request = (id: string, over: Partial<CollectionItem> = {}): CollectionItem => ({
  id,
  kind: "request",
  name: id,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: null,
  request: { ...emptyRequest(), url: `{{baseUrl}}/${id}` },
  items: [],
  ...over,
});

const document = (items: CollectionItem[]): CollectionDocument => ({ ...EMPTY_DOCUMENT, items });

const row = (fields: Partial<CollectionRow> = {}): CollectionRow => ({
  id: randomUUID(),
  projectId: PROJECT,
  name: "Widgets",
  description: "",
  document: document([request("a")]),
  createdAt: NOW,
  updatedAt: NOW,
  updatedBy: "u1",
  ...fields,
});

const run = (fields: Partial<CollectionRun> = {}): CollectionRun => ({
  id: randomUUID(),
  organizationId: ORG,
  projectId: PROJECT,
  collectionId: "c1",
  collectionName: "Widgets",
  environmentId: null,
  environmentName: null,
  status: "running",
  iterations: 1,
  delayMs: 0,
  stopOnFailure: false,
  folderId: null,
  folderName: null,
  totals: { ...EMPTY_TOTALS },
  results: [],
  startedAt: NOW,
  finishedAt: null,
  error: null,
  startedBy: "u1",
  ...fields,
});

/** Una cola que solo apunta lo que le mandan: el runner no corre en estas pruebas. */
class RecordingQueue implements CollectionRunQueuePort {
  readonly enqueued: string[] = [];
  readonly cancelled: string[] = [];
  async enqueue(runId: string): Promise<void> {
    this.enqueued.push(runId);
  }
  process(): void {}
  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
  isCancelled(runId: string): boolean {
    return this.cancelled.includes(runId);
  }
}

async function rejectsWith(promise: Promise<unknown>, kind: string, code?: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `se esperaba un DomainError y llegó ${String(error)}`);
    assert.equal(error.kind, kind);
    if (code !== undefined) assert.equal(error.code, code);
    return error;
  }
  assert.fail("se esperaba un error");
}

let projects: InMemoryProjectRepository;
let collections: InMemoryCollectionRepository;
let runs: InMemoryCollectionRunRepository;
let environments: InMemoryEnvironmentRepository;
let queue: RecordingQueue;
let clock: FixedClock;

beforeEach(async () => {
  projects = new InMemoryProjectRepository();
  collections = new InMemoryCollectionRepository();
  runs = new InMemoryCollectionRunRepository();
  environments = new InMemoryEnvironmentRepository();
  queue = new RecordingQueue();
  clock = new FixedClock(NOW);
  await projects.save(project(PROJECT));
  await projects.save(project(OTHER_PROJECT));
});

const createHandler = () => new CreateCollectionHandler(projects, collections, clock);
const updateHandler = () => new UpdateCollectionHandler(projects, collections, clock);
const deleteHandler = () => new DeleteCollectionHandler(projects, collections);
const runHandler = () => new RunCollectionHandler(projects, collections, runs, environments, queue, clock);

describe("crear una colección", () => {
  test("la crea vacía y devuelve su id", async () => {
    const { id } = await createHandler().execute(
      new CreateCollectionCommand(ORG, PROJECT, { name: "  Widgets  " }, "u1"),
    );
    const saved = await collections.find(PROJECT, id);
    assert.equal(saved?.name, "Widgets", "el nombre llega recortado");
    assert.equal(saved?.description, "");
    assert.deepEqual(saved?.document, EMPTY_DOCUMENT);
    assert.equal(saved?.updatedBy, "u1");
  });

  test("un documento que llega con la creación se valida y se guarda sin secretos literales", async () => {
    const folder = {
      ...emptyFolder("f1", "Carpeta"),
      auth: { type: "bearer" as const, params: { token: "escrito-a-mano" } },
      items: [request("a", { request: { ...emptyRequest(), auth: { type: "basic", params: { password: "1234" } } } })],
    };
    const { id } = await createHandler().execute(
      new CreateCollectionCommand(ORG, PROJECT, { name: "Con árbol", description: "x", document: document([folder]) }, "u1"),
    );
    const saved = await collections.find(PROJECT, id);
    assert.equal(saved?.description, "x");
    assert.deepEqual(saved?.document.items[0].auth, { type: "bearer", params: { token: "" } });
    assert.deepEqual(saved?.document.items[0].items[0].request?.auth, { type: "basic", params: { password: "" } });
  });

  test("sin nombre, o con uno que son solo espacios, es un 422 que nombra el campo", async () => {
    for (const input of [{ name: "   " }, {}]) {
      const error = await rejectsWith(
        createHandler().execute(new CreateCollectionCommand(ORG, PROJECT, input, "u1")),
        "invalid",
      );
      assert.deepEqual(error.fields, [{ field: "name", detail: "Ponle uno" }]);
    }
  });

  test("un nombre que ya está en el proyecto es un 409", async () => {
    await collections.save(row({ name: "Widgets" }));
    await rejectsWith(
      createHandler().execute(new CreateCollectionCommand(ORG, PROJECT, { name: "Widgets" }, "u1")),
      "conflict",
      "collection-name-taken",
    );
  });

  test("un documento que el esquema rechaza es un 422 con el campo que está mal", async () => {
    const roto = document([{ ...request("a"), request: null }]);
    const error = await rejectsWith(
      createHandler().execute(new CreateCollectionCommand(ORG, PROJECT, { name: "Rota", document: roto }, "u1")),
      "invalid",
      "collection-invalid",
    );
    assert.equal(error.fields?.[0].field, "items.0.request");
  });

  test("el proyecto de otra organización no existe", async () => {
    await rejectsWith(
      createHandler().execute(new CreateCollectionCommand("otra-org", PROJECT, { name: "x" }, "u1")),
      "not-found",
      "project-not-found",
    );
  });
});

describe("guardar una colección", () => {
  test("renombrar deja lo demás como estaba", async () => {
    const saved = row({ name: "Vieja", description: "la de antes" });
    await collections.save(saved);
    await updateHandler().execute(new UpdateCollectionCommand(ORG, PROJECT, saved.id, { name: " Nueva " }, "u2"));

    const after = await collections.find(PROJECT, saved.id);
    assert.equal(after?.name, "Nueva");
    assert.equal(after?.description, "la de antes", "lo que no se manda no se toca");
    assert.deepEqual(after?.document, saved.document);
    assert.equal(after?.updatedBy, "u2");
  });

  test("sin tocar el nombre se queda el suyo, y el árbol nuevo sustituye al viejo", async () => {
    const saved = row({ name: "Widgets" });
    await collections.save(saved);
    await updateHandler().execute(
      new UpdateCollectionCommand(ORG, PROJECT, saved.id, { description: "otra", document: document([]) }, "u2"),
    );

    const after = await collections.find(PROJECT, saved.id);
    assert.equal(after?.name, "Widgets");
    assert.equal(after?.description, "otra");
    assert.deepEqual(after?.document.items, []);
  });

  test("dejar el nombre en blanco es un 422, y usar el de otra colección un 409", async () => {
    const saved = row({ name: "Widgets" });
    await collections.save(saved);
    await collections.save(row({ name: "Otra" }));

    await rejectsWith(
      updateHandler().execute(new UpdateCollectionCommand(ORG, PROJECT, saved.id, { name: " " }, "u2")),
      "invalid",
    );
    await rejectsWith(
      updateHandler().execute(new UpdateCollectionCommand(ORG, PROJECT, saved.id, { name: "Otra" }, "u2")),
      "conflict",
      "collection-name-taken",
    );
    // Guardarla con el nombre que ya tenía no choca consigo misma.
    await updateHandler().execute(new UpdateCollectionCommand(ORG, PROJECT, saved.id, { name: "Widgets" }, "u2"));
  });

  test("la colección de otro proyecto no existe, y tampoco un id inventado", async () => {
    const ajena = row({ projectId: OTHER_PROJECT });
    await collections.save(ajena);
    await rejectsWith(
      updateHandler().execute(new UpdateCollectionCommand(ORG, PROJECT, ajena.id, { name: "x" }, "u2")),
      "not-found",
      "collection-not-found",
    );
    await rejectsWith(
      updateHandler().execute(new UpdateCollectionCommand(ORG, PROJECT, randomUUID(), { name: "x" }, "u2")),
      "not-found",
      "collection-not-found",
    );
  });
});

describe("borrar una colección", () => {
  test("se borra, y sus corridas se quedan: son un hecho sobre un rato", async () => {
    const saved = row();
    await collections.save(saved);
    await runs.save(run({ collectionId: saved.id, status: "passed" }));

    await deleteHandler().execute(new DeleteCollectionCommand(ORG, PROJECT, saved.id));
    assert.equal(await collections.find(PROJECT, saved.id), null);
    assert.equal((await runs.list(PROJECT, saved.id)).length, 1);
  });

  test("borrar la de otro proyecto es un 404 y no la borra", async () => {
    const ajena = row({ projectId: OTHER_PROJECT });
    await collections.save(ajena);
    await rejectsWith(
      deleteHandler().execute(new DeleteCollectionCommand(ORG, PROJECT, ajena.id)),
      "not-found",
      "collection-not-found",
    );
    assert.notEqual(await collections.find(OTHER_PROJECT, ajena.id), null);
  });
});

describe("lanzar una corrida", () => {
  test("sin entorno y sin ajustes corre la colección entera con los valores de por defecto", async () => {
    const saved = row({ document: document([request("a"), request("b")]) });
    await collections.save(saved);

    const { runId } = await runHandler().execute(
      new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: null }, "u1"),
    );
    const started = await runs.findById(runId);
    assert.equal(started?.status, "running");
    assert.equal(started?.iterations, 1);
    assert.equal(started?.delayMs, 0);
    assert.equal(started?.stopOnFailure, false);
    assert.equal(started?.environmentId, null);
    assert.equal(started?.environmentName, null);
    assert.equal(started?.folderId, null);
    assert.equal(started?.folderName, null);
    assert.equal(started?.collectionName, "Widgets");
    assert.deepEqual(queue.enqueued, [runId], "la cola es quien la recorre");
  });

  test("con carpeta y entorno, la corrida copia el nombre de los dos", async () => {
    const folder = { ...emptyFolder("f1", "01 · Widgets"), items: [request("a")] };
    const saved = row({ document: document([folder, request("suelta")]) });
    await collections.save(saved);
    await environments.save(environment("e1", PROJECT));

    const { runId } = await runHandler().execute(
      new RunCollectionCommand(
        ORG,
        PROJECT,
        saved.id,
        { environmentId: "e1", folderId: "f1", iterations: 2, delayMs: 100, stopOnFailure: true },
        "u1",
      ),
    );
    const started = await runs.findById(runId);
    assert.equal(started?.folderName, "01 · Widgets");
    assert.equal(started?.environmentName, "local");
    assert.equal(started?.iterations, 2);
    assert.equal(started?.delayMs, 100);
    assert.equal(started?.stopOnFailure, true);
  });

  test("las vueltas y la espera tienen tope, y no valen decimales", async () => {
    const saved = row();
    await collections.save(saved);
    const handler = runHandler();

    for (const iterations of [0, MAX_ITERATIONS + 1, 1.5]) {
      const error = await rejectsWith(
        handler.execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: null, iterations }, "u1")),
        "invalid",
        "invalid-iterations",
      );
      assert.equal(error.fields?.[0].field, "iterations");
    }
    for (const delayMs of [-1, MAX_DELAY_MS + 1, 0.5]) {
      await rejectsWith(
        handler.execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: null, delayMs }, "u1")),
        "invalid",
        "invalid-delay",
      );
    }
    assert.deepEqual(queue.enqueued, [], "ninguna llegó a la cola");
  });

  test("una carpeta que no está, o un id que es de una petición, es un 404", async () => {
    const saved = row({ document: document([request("a")]) });
    await collections.save(saved);
    const handler = runHandler();

    await rejectsWith(
      handler.execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: null, folderId: "no-existe" }, "u1")),
      "not-found",
      "collection-folder-not-found",
    );
    await rejectsWith(
      handler.execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: null, folderId: "a" }, "u1")),
      "not-found",
      "collection-folder-not-found",
    );
  });

  test("sin ninguna petición que correr es un 409, y la carpeta vacía lo dice de ella", async () => {
    const vacia = row({ name: "Vacía", document: document([]) });
    const conCarpeta = row({ name: "Con carpeta", document: document([emptyFolder("f1", "Sola")]) });
    await collections.save(vacia);
    await collections.save(conCarpeta);
    const handler = runHandler();

    const sinNada = await rejectsWith(
      handler.execute(new RunCollectionCommand(ORG, PROJECT, vacia.id, { environmentId: null }, "u1")),
      "conflict",
      "nothing-to-run",
    );
    assert.match(sinNada.message, /La colección no tiene/);

    const carpeta = await rejectsWith(
      handler.execute(new RunCollectionCommand(ORG, PROJECT, conCarpeta.id, { environmentId: null, folderId: "f1" }, "u1")),
      "conflict",
      "nothing-to-run",
    );
    assert.match(carpeta.message, /Esa carpeta no tiene/);
  });

  test("peticiones por vueltas tiene un techo, y se dice con su número", async () => {
    const items = Array.from({ length: 120 }, (_, index) => request(`r${index}`));
    const saved = row({ document: document(items) });
    await collections.save(saved);

    const error = await rejectsWith(
      runHandler().execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: null, iterations: 50 }, "u1")),
      "invalid",
      "too-many-requests",
    );
    assert.match(String(error.fields?.[0].detail), new RegExp(`120 peticiones × 50 vueltas pasan de ${MAX_RUN_REQUESTS}`));
  });

  test("un entorno que no existe, o que es de otro proyecto, es un 404 antes de escribir nada", async () => {
    const saved = row();
    await collections.save(saved);
    await environments.save(environment("ajeno", OTHER_PROJECT));
    const handler = runHandler();

    await rejectsWith(
      handler.execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: "no-existe" }, "u1")),
      "not-found",
      "environment-not-found",
    );
    await rejectsWith(
      handler.execute(new RunCollectionCommand(ORG, PROJECT, saved.id, { environmentId: "ajeno" }, "u1")),
      "not-found",
      "environment-not-found",
    );
    assert.equal(runs.rows.size, 0);
  });
});

describe("cancelar y borrar una corrida", () => {
  test("cancelar avisa a la cola y cierra la fila, que es lo que la deja cerrada si ni arrancó", async () => {
    const corriendo = run();
    await runs.save(corriendo);

    await new CancelCollectionRunHandler(projects, runs, queue, clock).execute(
      new CancelCollectionRunCommand(ORG, PROJECT, corriendo.id),
    );
    const after = await runs.findById(corriendo.id);
    assert.equal(after?.status, "cancelled");
    assert.deepEqual(after?.finishedAt, NOW);
    assert.deepEqual(queue.cancelled, [corriendo.id]);
  });

  test("una que ya terminó no se cancela, y una de otro proyecto no existe", async () => {
    const terminada = run({ status: "passed" });
    const ajena = run({ projectId: OTHER_PROJECT });
    await runs.save(terminada);
    await runs.save(ajena);
    const handler = new CancelCollectionRunHandler(projects, runs, queue, clock);

    await rejectsWith(
      handler.execute(new CancelCollectionRunCommand(ORG, PROJECT, terminada.id)),
      "conflict",
      "run-not-running",
    );
    await rejectsWith(
      handler.execute(new CancelCollectionRunCommand(ORG, PROJECT, ajena.id)),
      "not-found",
      "collection-run-not-found",
    );
    assert.deepEqual(queue.cancelled, []);
  });

  test("borrar una corrida la quita; la de otro proyecto no se alcanza", async () => {
    const mia = run({ status: "passed" });
    const ajena = run({ projectId: OTHER_PROJECT });
    await runs.save(mia);
    await runs.save(ajena);
    const handler = new DeleteCollectionRunHandler(projects, runs);

    await handler.execute(new DeleteCollectionRunCommand(ORG, PROJECT, mia.id));
    assert.equal(await runs.findById(mia.id), null);

    await rejectsWith(
      handler.execute(new DeleteCollectionRunCommand(ORG, PROJECT, ajena.id)),
      "not-found",
      "collection-run-not-found",
    );
    assert.notEqual(await runs.findById(ajena.id), null);
  });
});

describe("leer las colecciones", () => {
  test("la lista cuenta lo que hay dentro y enseña cómo acabó la última corrida", async () => {
    const conCorrida = row({ name: "Con corrida", document: document([{ ...emptyFolder("f1", "F"), items: [request("a")] }]) });
    const sinCorrida = row({ name: "Sin corrida" });
    await collections.save(conCorrida);
    await collections.save(sinCorrida);
    await runs.save(
      run({
        collectionId: conCorrida.id,
        status: "failed",
        totals: { ...EMPTY_TOTALS, requests: 3, failed: 2 },
        startedAt: NOW,
      }),
    );

    const list = await new ListCollectionsHandler(projects, collections, runs).execute(
      new ListCollectionsQuery(ORG, PROJECT),
    );
    const con = list.find((entry) => entry.name === "Con corrida")!;
    assert.deepEqual([con.folders, con.requests], [1, 1]);
    assert.equal(con.lastRun?.status, "failed");
    assert.equal(con.lastRun?.failed, 2);
    assert.equal(list.find((entry) => entry.name === "Sin corrida")?.lastRun, null);
  });

  test("una colección se lee entera, y se exporta como el fichero de Postman", async () => {
    const saved = row({ document: document([request("a")]) });
    await collections.save(saved);

    const view = await new GetCollectionHandler(projects, collections).execute(
      new GetCollectionQuery(ORG, PROJECT, saved.id),
    );
    assert.equal(view.requests, 1);
    assert.equal(view.items.length, 1);

    const exported = await new ExportCollectionHandler(projects, collections).execute(
      new ExportCollectionQuery(ORG, PROJECT, saved.id),
    );
    assert.equal(exported.name, "Widgets");
    assert.deepEqual(exported.redacted, []);
  });

  test("las corridas se listan por proyecto, y se pueden estrechar a una colección", async () => {
    const handler = new ListCollectionRunsHandler(projects, runs);
    await runs.save(run({ collectionId: "c1", startedAt: new Date("2026-09-21T10:00:00Z") }));
    await runs.save(run({ collectionId: "c2", startedAt: new Date("2026-09-21T11:00:00Z") }));
    await runs.save(run({ projectId: OTHER_PROJECT, collectionId: "c1" }));

    const todas = await handler.execute(new ListCollectionRunsQuery(ORG, PROJECT));
    assert.deepEqual(
      todas.map((entry) => entry.collectionId),
      ["c2", "c1"],
      "la más nueva primero",
    );
    const deUna = await handler.execute(new ListCollectionRunsQuery(ORG, PROJECT, "c1"));
    assert.deepEqual(
      deUna.map((entry) => entry.collectionId),
      ["c1"],
    );
    await rejectsWith(handler.execute(new ListCollectionRunsQuery("otra-org", PROJECT)), "not-found");
  });

  test("una corrida se lee con sus resultados dentro; la de otro proyecto no", async () => {
    const mia = run({
      status: "passed",
      results: [
        {
          iteration: 1,
          itemId: "a",
          name: "a",
          folder: "",
          method: "GET",
          url: "http://api.test/a",
          status: 200,
          durationMs: 1,
          sizeBytes: 2,
          tests: [],
          error: null,
          logs: [],
        },
      ],
    });
    await runs.save(mia);
    const handler = new GetCollectionRunHandler(projects, runs);

    const view = await handler.execute(new GetCollectionRunQuery(ORG, PROJECT, mia.id));
    assert.equal(view.results.length, 1);
    assert.equal(view.status, "passed");

    await rejectsWith(
      handler.execute(new GetCollectionRunQuery(ORG, OTHER_PROJECT, mia.id)),
      "not-found",
      "collection-run-not-found",
    );
  });
});

describe("enviar una petición de la colección", () => {
  const sent = (): SentRequestView => ({
    request: { method: "GET", url: "http://api.test/a", headers: {}, body: null },
    response: { status: 200, headers: {}, body: "{}", sizeBytes: 2, durationMs: 4, timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 } },
    error: null,
    auth: "—",
    environment: null,
    scripts: { pre: null, post: null },
    sessionToken: null,
    cookies: { sent: [], stored: [], rejected: [] },
    variables: {},
  });

  function handlerWithBus() {
    const seen: string[] = [];
    const commandBus = {
      execute: async (command: { request: string }) => {
        seen.push(command.request);
        return sent();
      },
    } as unknown as CommandBus;
    return { handler: new SendCollectionRequestHandler(commandBus, projects, collections), seen };
  }

  test("una petición que todavía no está guardada se envía sin heredar de ninguna carpeta", async () => {
    const saved = row({
      document: {
        ...document([]),
        auth: { type: "bearer", params: { token: "{{token}}" } },
        preRequestScript: "pm.environment.set('x', 1)",
        variables: [
          { key: "usada", value: "1", enabled: true },
          { key: "apagada", value: "2", enabled: false },
        ],
      },
    });
    await collections.save(saved);
    const { handler, seen } = handlerWithBus();

    await handler.execute(
      new SendCollectionRequestCommand(
        ORG,
        PROJECT,
        saved.id,
        { environmentId: null, itemId: null, request: emptyRequest(), preRequestScript: "", postResponseScript: "" },
        "u1",
      ),
    );
    const input = JSON.parse(seen[0]) as { auth: { type: string }; preRequestScript: string; variables: Record<string, string> };
    assert.equal(input.auth.type, "bearer", "sin carpetas hereda la de la colección");
    assert.match(input.preRequestScript, /\/\/ Colección/);
    assert.deepEqual(input.variables, { usada: "1" }, "una variable apagada no vale nada");
  });

  test("los parámetros de ruta y las filas de query viajan como las escribió el editor", async () => {
    const saved = row();
    await collections.save(saved);
    const { handler, seen } = handlerWithBus();

    await handler.execute(
      new SendCollectionRequestCommand(
        ORG,
        PROJECT,
        saved.id,
        {
          environmentId: null,
          itemId: null,
          request: {
            ...emptyRequest(),
            url: "{{base}}/widgets/:id",
            pathParameters: [{ name: "id", type: "string", description: "", value: "7" }],
            query: [
              { name: "full", type: "string", required: false, description: "", value: "true", enabled: true },
              { name: "draft", type: "string", required: false, description: "", value: "no", enabled: false },
            ],
          },
          preRequestScript: "",
          postResponseScript: "",
        },
        "u1",
      ),
    );
    const input = JSON.parse(seen[0]) as {
      pathParameters: { name: string; value: string }[];
      query: { name: string; value: string; enabled: boolean }[];
    };
    assert.deepEqual(input.pathParameters, [{ name: "id", value: "7" }]);
    assert.deepEqual(input.query, [
      { name: "full", value: "true", enabled: true },
      { name: "draft", value: "no", enabled: false },
    ]);
  });

  test("una petición que el esquema rechaza es un 422 que nombra el campo dentro de `request`", async () => {
    const saved = row();
    await collections.save(saved);
    const { handler } = handlerWithBus();

    const error = await rejectsWith(
      handler.execute(
        new SendCollectionRequestCommand(
          ORG,
          PROJECT,
          saved.id,
          {
            environmentId: null,
            itemId: null,
            request: { ...emptyRequest(), method: "TELEPORT" as never },
            preRequestScript: "",
            postResponseScript: "",
          },
          "u1",
        ),
      ),
      "invalid",
      "collection-request-invalid",
    );
    assert.equal(error.fields?.[0].field, "request.method");
  });

  test("lo que no es ni un objeto se rechaza sin nombrar ningún campo", async () => {
    const saved = row();
    await collections.save(saved);
    const { handler } = handlerWithBus();

    const error = await rejectsWith(
      handler.execute(
        new SendCollectionRequestCommand(
          ORG,
          PROJECT,
          saved.id,
          { environmentId: null, itemId: null, request: "no" as never, preRequestScript: "", postResponseScript: "" },
          "u1",
        ),
      ),
      "invalid",
      "collection-request-invalid",
    );
    assert.equal(error.fields?.[0].field, "request");
  });
});

describe("importar una colección de Postman", () => {
  const file = (name: unknown) => ({
    info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [{ name: "Una", request: { method: "GET", url: "{{base}}/x" } }],
  });

  test("un nombre que se queda en blanco al recortarlo tiene uno por defecto", async () => {
    const handler = new ImportPostmanCollectionHandler(projects, collections, clock);
    const result = await handler.execute(
      new ImportPostmanCollectionCommand(ORG, PROJECT, { text: JSON.stringify(file("Widgets")), name: "   " }, "u1"),
    );
    assert.equal(result.name, "Colección importada");
    assert.equal(result.action, "created");
    assert.equal((await collections.find(PROJECT, result.id))?.name, "Colección importada");
  });
});

describe("el tamaño del documento", () => {
  test("más elementos de los que caben se rechaza contándolos, no nivel a nivel", async () => {
    // Tres carpetas de 700 peticiones: ningún nivel pasa del tope y el árbol entero sí.
    const items = Array.from({ length: 3 }, (_, folderIndex) => ({
      ...emptyFolder(`f${folderIndex}`, `f${folderIndex}`),
      items: Array.from({ length: 700 }, (_, index) => request(`r${folderIndex}-${index}`)),
    }));
    await collections.save(row());

    const error = await rejectsWith(
      createHandler().execute(new CreateCollectionCommand(ORG, PROJECT, { name: "Enorme", document: document(items) }, "u1")),
      "invalid",
      "collection-invalid",
    );
    assert.deepEqual(error.fields, [{ field: "items", detail: `Como mucho ${MAX_COLLECTION_ITEMS} elementos` }]);
  });
});
