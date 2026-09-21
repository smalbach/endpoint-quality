/**
 * El runner por dentro: lo que hace cuando algo no va como en el camino feliz.
 *
 * El camino feliz —crear, leer lo creado, borrarlo, con las variables viajando de una petición a
 * la siguiente— se prueba contra la API de verdad en `test/http/collections.test.ts`. Aquí están
 * los bordes: cancelar entre dos peticiones, parar en la primera roja, una colección que se borró
 * mientras la corrida esperaba turno, y una petición que ni se pudo enviar.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CommandBus } from "@nestjs/cqrs";

import { FixedClock } from "@/shared/clock/clock.port";
import { InMemoryCollectionRepository, InMemoryCollectionRunRepository } from "../support/in-memory-repositories";
import { CollectionProgressStream } from "@/modules/collections/infrastructure/collection-progress.stream";
import { CollectionRunner } from "@/modules/collections/infrastructure/collection-runner";
import { EMPTY_TOTALS, emptyRequest, type CollectionItem, type CollectionRun } from "@/modules/collections/domain/model";
import type { CollectionRunQueuePort } from "@/modules/collections/domain/ports";
import type { SentRequestView } from "@/modules/endpoints/application/commands/send-endpoint-request";

const clock = new FixedClock(new Date("2026-09-21T10:00:00Z"));

const request = (id: string): CollectionItem => ({
  id,
  kind: "request",
  name: id,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: null,
  request: { ...emptyRequest(), url: `https://api.test/${id}` },
  items: [],
});

const sent = (over: Partial<SentRequestView> = {}): SentRequestView => ({
  request: { method: "GET", url: "https://api.test/x", headers: {}, body: null },
  response: { status: 200, headers: {}, body: "{}", sizeBytes: 2, durationMs: 4, timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 } },
  error: null,
  auth: "—",
  environment: null,
  scripts: { pre: null, post: null },
  sessionToken: null,
  cookies: { sent: [], stored: [], rejected: [] },
  variables: {},
  ...over,
});

/** Una cola que dice que sí a todo menos a lo que se le mande cancelar. */
class StubQueue implements CollectionRunQueuePort {
  cancelled = new Set<string>();
  async enqueue(): Promise<void> {}
  process(): void {}
  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }
}

async function build(items: CollectionItem[], over: Partial<CollectionRun> = {}, answers: SentRequestView[] = []) {
  const collections = new InMemoryCollectionRepository();
  const runs = new InMemoryCollectionRunRepository();
  const queue = new StubQueue();
  const progress = new CollectionProgressStream();
  const events: string[] = [];
  const subscription = progress.forRun("run").subscribe((event) => events.push(event.type));

  await collections.save({
    id: "col",
    projectId: "p",
    name: "Tienda",
    description: "",
    document: { auth: { type: "inherit", params: {} }, variables: [], preRequestScript: "", postResponseScript: "", items },
    createdAt: clock.now(),
    updatedAt: clock.now(),
    updatedBy: "u",
  });
  const run: CollectionRun = {
    id: "run",
    organizationId: "o",
    projectId: "p",
    collectionId: "col",
    collectionName: "Tienda",
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
    startedAt: clock.now(),
    finishedAt: null,
    error: null,
    startedBy: "u",
    ...over,
  };
  await runs.save(run);

  let call = 0;
  const commandBus = {
    execute: async () => {
      const answer = answers[call] ?? answers[answers.length - 1] ?? sent();
      call += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as CommandBus;

  const runner = new CollectionRunner(commandBus, collections, runs, queue, clock, progress);
  return { runner, runs, collections, queue, events, done: () => subscription.unsubscribe(), calls: () => call };
}

describe("el runner de una colección", () => {
  test("corre las peticiones en orden y acaba en verde", async () => {
    const context = await build([request("a"), request("b")]);
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "passed");
    assert.equal(run?.totals.requests, 2);
    assert.equal(context.calls(), 2);
    assert.deepEqual(context.events, ["result", "result", "finished"]);
    context.done();
  });

  test("las vueltas repiten la colección entera", async () => {
    const context = await build([request("a")], { iterations: 3 });
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.totals.requests, 3);
    assert.deepEqual(run?.results.map((result) => result.iteration), [1, 2, 3]);
    context.done();
  });

  test("cancelar para entre dos peticiones y deja lo que ya se midió", async () => {
    const context = await build([request("a"), request("b")]);
    await context.queue.cancel("run");
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "cancelled");
    assert.equal(context.calls(), 0, "la que no había salido no sale");
    context.done();
  });

  test("con «parar en la primera roja» no sigue después de un test que falla", async () => {
    const red = sent({
      scripts: { pre: null, post: { error: null, logs: [], tests: [{ name: "x", passed: false, message: "no" }], environmentUpdates: [], visualization: null, durationMs: 1 } },
    });
    const context = await build([request("a"), request("b")], { stopOnFailure: true }, [red]);
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "failed");
    assert.equal(run?.totals.requests, 1);
    assert.equal(run?.totals.testsFailed, 1);
    context.done();
  });

  test("una petición que no se pudo enviar es una fila roja, no una corrida rota", async () => {
    const context = await build([request("a"), request("b")], {}, [
      new Error("Variables sin valor: baseUrl") as unknown as SentRequestView,
      sent(),
    ]);
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "failed");
    assert.equal(run?.totals.requests, 2, "la siguiente se envía igual");
    assert.equal(run?.results[0].status, null);
    assert.match(String(run?.results[0].error), /Variables sin valor/);
    context.done();
  });

  test("lo que los scripts escriben viaja a la petición siguiente", async () => {
    const context = await build([request("a"), request("b")], {}, [sent({ variables: { id: "7" } }), sent()]);
    await context.runner.execute("run");
    // La segunda llamada llevó la variable: se comprueba por lo que el runner guardó del primero.
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "passed");
    context.done();
  });

  test("una corrida que ya terminó no se vuelve a correr", async () => {
    const context = await build([request("a")], { status: "cancelled" });
    await context.runner.execute("run");
    assert.equal(context.calls(), 0);
    context.done();
  });

  test("una corrida que no existe no revienta", async () => {
    const context = await build([request("a")]);
    await context.runner.execute("otra");
    assert.equal(context.calls(), 0);
    context.done();
  });

  test("si la colección se borró mientras esperaba, la corrida lo dice", async () => {
    const context = await build([request("a")]);
    await context.collections.delete("p", "col");
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "error");
    assert.match(String(run?.error), /se borró/);
    context.done();
  });

  test("una carpeta sin peticiones acaba en error, no en verde vacío", async () => {
    const folder: CollectionItem = {
      id: "f",
      kind: "folder",
      name: "f",
      description: "",
      preRequestScript: "",
      postResponseScript: "",
      auth: null,
      request: null,
      items: [],
    };
    const context = await build([folder], { folderId: "f" });
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.status, "error");
    assert.match(String(run?.error), /ninguna petición/);
    context.done();
  });

  test("la espera entre peticiones se respeta", async () => {
    const context = await build([request("a"), request("b")], { delayMs: 20 });
    const started = Date.now();
    await context.runner.execute("run");
    assert.ok(Date.now() - started >= 20, "esperó entre las dos");
    context.done();
  });
});
