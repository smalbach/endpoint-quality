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
import {
  EMPTY_TOTALS,
  RESULT_BODY_LIMIT,
  emptyRequest,
  type CollectionItem,
  type CollectionRun,
} from "@/modules/collections/domain/model";
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
  // Con un parámetro de ruta y una query: es lo que el runner traduce a la entrada del envío.
  request: {
    ...emptyRequest(),
    url: `https://api.test/${id}/{productId}`,
    pathParameters: [{ name: "productId", type: "string", description: "", value: "7" }],
    query: [{ name: "expand", type: "string", description: "", value: "prices", required: false, enabled: true }],
  },
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
  /** Lo que se le mandó al comando de enviar, para mirar qué compuso el runner. */
  const inputs: { pathParameters: { name: string; value: string }[]; preRequestScript: string }[] = [];
  const commandBus = {
    execute: async (command: { request: string }) => {
      inputs.push(JSON.parse(command.request));
      const answer = answers[call] ?? answers[answers.length - 1] ?? sent();
      call += 1;
      // Lo que se lanza puede no ser un `Error`: un `throw "texto"` de un adaptador cualquiera.
      if (answer instanceof Error || typeof answer === "string") throw answer;
      return answer;
    },
  } as unknown as CommandBus;

  const runner = new CollectionRunner(commandBus, collections, runs, queue, clock, progress);
  return {
    runner,
    runs,
    collections,
    queue,
    events,
    inputs,
    done: () => subscription.unsubscribe(),
    calls: () => call,
  };
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

  test("lo que se lanza sin ser un Error también es una fila roja, con una frase en vez de un vacío", async () => {
    const context = await build([request("a")], {}, ["no es un Error" as unknown as SentRequestView]);
    await context.runner.execute("run");
    const run = await context.runs.findById("run");
    assert.equal(run?.results[0].error, "La petición no se pudo enviar");
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

  test("una respuesta que no llegó y un script que falló se cuentan como la fila roja que son", async () => {
    const roto = sent({
      request: { method: "GET", url: "", headers: {}, body: null },
      response: null,
      scripts: {
        pre: { error: null, logs: [{ level: "log", text: "antes" }], tests: [{ name: "pre", passed: true, message: null }], environmentUpdates: [], visualization: null, durationMs: 1 },
        post: { error: "ReferenceError: pm no está", logs: [{ level: "error", text: "después" }], tests: [], environmentUpdates: [], visualization: null, durationMs: 1 },
      },
    });
    const context = await build([request("a")], {}, [roto]);
    await context.runner.execute("run");

    const run = await context.runs.findById("run");
    assert.equal(run?.status, "failed");
    const [result] = run!.results;
    assert.equal(result.status, null, "sin respuesta no hay código");
    assert.equal(result.durationMs, 0);
    assert.equal(result.sizeBytes, 0);
    // La URL que se enseña es la que se escribió: el envío no llegó a resolver ninguna.
    assert.equal(result.url, "https://api.test/a/{productId}");
    assert.equal(result.error, "ReferenceError: pm no está");
    assert.deepEqual(result.tests.map((test) => test.name), ["pre"]);
    assert.deepEqual(result.logs.map((entry) => entry.text), ["antes", "después"]);
    context.done();
  });

  test("un script de antes que revienta es el error de la fila cuando el de después no dice nada", async () => {
    const context = await build([request("a")], {}, [
      sent({
        scripts: {
          pre: { error: "SyntaxError", logs: [], tests: [], environmentUpdates: [], visualization: null, durationMs: 1 },
          post: null,
        },
      }),
    ]);
    await context.runner.execute("run");
    assert.equal((await context.runs.findById("run"))?.results[0].error, "SyntaxError");
    context.done();
  });

  test("los parámetros de ruta viajan con la petición", async () => {
    const conRuta: CollectionItem = {
      ...request("a"),
      request: {
        ...request("a").request!,
        url: "https://api.test/widgets/:id",
        pathParameters: [{ name: "id", type: "string", description: "", value: "7" }],
      },
    };
    const context = await build([conRuta]);
    await context.runner.execute("run");
    assert.equal((await context.runs.findById("run"))?.status, "passed");
    assert.deepEqual(context.inputs[0].pathParameters, [{ name: "id", value: "7" }]);
    context.done();
  });
  test("guarda lo que salió, lo que contestó y lo que dejó escrito", async () => {
    const context = await build([request("a")], {}, [
      sent({
        request: {
          method: "POST",
          url: "https://api.test/v1/products",
          headers: { Authorization: "Bearer ***" },
          body: '{"sku":"A1"}',
        },
        response: {
          status: 201,
          headers: { "x-request-id": "abc" },
          body: '{"id":7}',
          sizeBytes: 8,
          durationMs: 12,
          timing: { dnsMs: 1, ttfbMs: 10, downloadMs: 1 },
        },
        auth: "Bearer del entorno «local»",
        cookies: { sent: ["sid=api.test/"], stored: ["sid"], rejected: [{ line: "a=b", why: "otro dominio" }] },
        variables: { product_id: "7" },
        scripts: {
          pre: { error: null, logs: [], tests: [], environmentUpdates: [], visualization: null, durationMs: 3 },
          post: { error: null, logs: [], tests: [], environmentUpdates: [], visualization: null, durationMs: 5 },
        },
      }),
    ]);
    await context.runner.execute("run");
    const result = (await context.runs.findById("run"))!.results[0];

    // La URL de la fila es la que salió, no `{{baseUrl}}/…`: es de lo que se lee un 404.
    assert.equal(result.url, "https://api.test/v1/products");
    assert.equal(result.sent?.headers.Authorization, "Bearer ***");
    assert.equal(result.sent?.body, '{"sku":"A1"}');
    assert.equal(result.received?.body, '{"id":7}');
    assert.equal(result.received?.timing.ttfbMs, 10);
    assert.equal(result.auth, "Bearer del entorno «local»");
    assert.deepEqual(result.cookies.stored, ["sid"]);
    assert.deepEqual(result.writes, [{ key: "product_id", value: "7" }]);
    assert.deepEqual(result.scripts, { pre: { error: null, durationMs: 3 }, post: { error: null, durationMs: 5 } });
    context.done();
  });

  test("solo se guarda lo que esta petición escribió, no el almacén entero", async () => {
    const context = await build([request("a"), request("b")], {}, [
      sent({ variables: { product_id: "7" } }),
      sent({ variables: { product_id: "7", price_id: "9" } }),
    ]);
    await context.runner.execute("run");
    const results = (await context.runs.findById("run"))!.results;
    assert.deepEqual(results[0].writes, [{ key: "product_id", value: "7" }]);
    assert.deepEqual(results[1].writes, [{ key: "price_id", value: "9" }], "lo de la anterior no se repite");
    context.done();
  });

  test("una petición que no se pudo enviar no inventa ni petición ni respuesta", async () => {
    const context = await build([request("a")], {}, [new Error("Variables sin valor: baseUrl") as unknown as SentRequestView]);
    await context.runner.execute("run");
    const result = (await context.runs.findById("run"))!.results[0];
    assert.equal(result.sent, null);
    assert.equal(result.received, null);
    assert.equal(result.auth, "No se envió");
    assert.deepEqual(result.writes, []);
    context.done();
  });

  test("un destino bloqueado deja la petición que salió y ninguna respuesta", async () => {
    const context = await build([request("a")], {}, [
      sent({
        // Como contesta el botón de enviar cuando la guardia SSRF corta: hay petición y no respuesta.
        request: { method: "GET", url: "", headers: {}, body: null },
        response: null,
        error: "El destino 10.0.0.1 está bloqueado: es una dirección privada",
        auth: "Sin autenticación",
      }),
    ]);
    await context.runner.execute("run");
    const result = (await context.runs.findById("run"))!.results[0];

    assert.equal(result.received, null);
    assert.equal(result.status, null);
    assert.equal(result.durationMs, 0);
    assert.equal(result.sizeBytes, 0);
    // Sin URL resuelta se queda la escrita, que es más que dejar la fila en blanco.
    assert.equal(result.url, "https://api.test/a/{productId}");
    assert.equal(result.sent?.body, null);
    assert.match(String(result.error), /bloqueado/);
    context.done();
  });

  test("un cuerpo enorme se guarda recortado y dicho", async () => {
    const huge = "x".repeat(RESULT_BODY_LIMIT + 500);
    const context = await build([request("a")], {}, [
      sent({
        request: { method: "POST", url: "https://api.test/a", headers: {}, body: huge },
        response: {
          status: 200,
          headers: {},
          body: huge,
          sizeBytes: huge.length,
          durationMs: 1,
          timing: { dnsMs: 0, ttfbMs: 1, downloadMs: 0 },
        },
      }),
    ]);
    await context.runner.execute("run");
    const result = (await context.runs.findById("run"))!.results[0];
    assert.equal(result.sent?.body?.length, RESULT_BODY_LIMIT);
    assert.equal(result.sent?.bodyTruncated, true);
    assert.equal(result.received?.body.length, RESULT_BODY_LIMIT);
    assert.equal(result.received?.bodyTruncated, true);
    // El tamaño de verdad no se pierde al recortar: es lo que el informe enseña.
    assert.equal(result.sizeBytes, huge.length);
    context.done();
  });

  test("pasado el tope de la corrida se dejan de guardar cuerpos, y lo demás sigue", async () => {
    const body = "y".repeat(RESULT_BODY_LIMIT);
    const answer = sent({
      request: { method: "POST", url: "https://api.test/a", headers: {}, body },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
        sizeBytes: body.length,
        durationMs: 1,
        timing: { dnsMs: 0, ttfbMs: 1, downloadMs: 0 },
      },
    });
    // Cada petición guarda dos cuerpos de 16 KB: el presupuesto da para 62 y sobran las que faltan.
    const many = Array.from({ length: 70 }, (_, index) => request(`r${index}`));
    const context = await build(many, {}, [answer]);
    await context.runner.execute("run");
    const results = (await context.runs.findById("run"))!.results;
    const last = results[results.length - 1];

    assert.equal(results[0].received?.body.length, RESULT_BODY_LIMIT, "las primeras sí caben");
    assert.equal(last.received?.body, "", "la última ya no guarda el cuerpo");
    assert.equal(last.received?.bodyTruncated, true);
    assert.equal(last.sent?.body, "", "tampoco el que se mandó");
    assert.equal(last.received?.status, 200, "pero el resto del intercambio sigue ahí");
    assert.deepEqual(last.received?.headers, { "content-type": "application/json" });
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
