/**
 * Una colección de Postman, de punta a punta: entra tal cual, se edita, se envía una petición y se
 * corre entera contra un servidor de verdad.
 *
 * Lo que de verdad se comprueba aquí es la cadena: el `Setup` guarda un id con
 * `pm.collectionVariables.set` y la petición siguiente lo lee con `{{...}}`. Sin eso una colección
 * de verdad —crear, leer lo creado, borrarlo— no corre, y era justo lo que se perdía cuando esto
 * entraba como un grafo de flujo.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let target: Server;
let origin: string;
let owner: Actor;
let projectId: string;
let environmentId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

/** Un API mínimo con memoria: crea, lee y borra widgets, que es lo que la colección ejercita. */
const widgets = new Map<string, { id: string; name: string }>();
let nextId = 1;

async function finished(runId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = (await api().get(`${base()}/collections/runs/${runId}`).set(as(owner))).body;
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("la corrida no terminó");
}

/** El fichero que alguien exporta de Postman, con lo que trae uno de verdad. */
const postmanFile = () => ({
  info: { _postman_id: "abc", name: "Widgets", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{access_token}}", type: "string" }] },
  variable: [{ key: "widget_id", value: "", type: "string" }],
  item: [
    {
      name: "01 · Widgets",
      description: "Crear, leer y borrar.",
      item: [
        {
          name: "Setup · crear un widget",
          event: [
            {
              listen: "test",
              script: {
                type: "text/javascript",
                exec: [
                  "pm.test('crea', function () { pm.expect(pm.response.code).to.equal(201); });",
                  "pm.collectionVariables.set('widget_id', pm.response.json().id);",
                ],
              },
            },
          ],
          request: {
            method: "POST",
            header: [{ key: "Content-Type", value: "application/json" }],
            url: { raw: "{{baseUrl}}/widgets", host: ["{{baseUrl}}"], path: ["widgets"] },
            body: { mode: "raw", raw: '{"name":"uno"}', options: { raw: { language: "json" } } },
          },
        },
        {
          name: "lo creado se lee",
          event: [
            {
              listen: "test",
              script: {
                type: "text/javascript",
                exec: [
                  "pm.test('existe', function () { pm.expect(pm.response.code).to.equal(200); });",
                  "pm.test('es el mismo', function () { pm.expect(pm.response.json().id).to.equal(pm.collectionVariables.get('widget_id')); });",
                ],
              },
            },
          ],
          request: {
            method: "GET",
            header: [],
            url: {
              raw: "{{baseUrl}}/widgets/{{widget_id}}?full=true&draft=no",
              query: [
                { key: "full", value: "true" },
                { key: "draft", value: "no", disabled: true },
              ],
            },
          },
        },
        {
          name: "borrarlo",
          event: [
            {
              listen: "test",
              script: {
                type: "text/javascript",
                exec: ["pm.test('borra', function () { pm.expect(pm.response.code).to.equal(204); });"],
              },
            },
          ],
          request: { method: "DELETE", header: [], url: { raw: "{{baseUrl}}/widgets/{{widget_id}}" } },
        },
      ],
    },
  ],
});

before(async () => {
  target = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    const match = /^\/widgets\/(.+)$/.exec(url.pathname);
    if (incoming.method === "POST" && url.pathname === "/widgets") {
      const id = String(nextId++);
      widgets.set(id, { id, name: "uno" });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id, name: "uno" }));
      return;
    }
    if (incoming.method === "GET" && match) {
      const widget = widgets.get(match[1]);
      response.writeHead(widget ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(widget ?? { error: "no está" }));
      return;
    }
    if (incoming.method === "DELETE" && match) {
      widgets.delete(match[1]);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("colecciones@example.com");
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Widgets" });
  projectId = project.body.projectId;
  const environment = await api()
    .post(`${base()}/environments`)
    .set(as(owner))
    .send({ name: "local", baseUrl: origin, writesAllowed: true });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  environmentId = environment.body.environmentId ?? environment.body.id;
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => target.close(() => resolve()));
});

describe("las colecciones", () => {
  let collectionId: string;

  test("importar trae el árbol, no un grafo: carpeta, peticiones, scripts y variables", async () => {
    const imported = await api()
      .post(`${base()}/collections/import`)
      .set(as(owner))
      .send({ text: JSON.stringify(postmanFile()) });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.action, "created");
    assert.equal(imported.body.name, "Widgets");
    assert.equal(imported.body.folders, 1);
    assert.equal(imported.body.requests, 3);
    collectionId = imported.body.id;

    const view = (await api().get(`${base()}/collections/${collectionId}`).set(as(owner))).body;
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].kind, "folder");
    assert.equal(view.items[0].items.length, 3);
    assert.equal(view.auth.type, "bearer");
    assert.deepEqual(view.variables, [{ key: "widget_id", value: "", enabled: true }]);

    const read = view.items[0].items[1];
    assert.equal(read.request.url, "{{baseUrl}}/widgets/{{widget_id}}");
    // La query sale a filas, con la apagada apagada: es lo que permite volver a encenderla.
    assert.deepEqual(
      read.request.query.map((row: { name: string; value: string; enabled: boolean }) => [row.name, row.value, row.enabled]),
      [
        ["full", "true", true],
        ["draft", "no", false],
      ],
    );
    assert.match(read.postResponseScript, /pm\.test\('existe'/);
    // El cuerpo JSON del primero se lee como JSON, no como texto suelto.
    assert.equal(view.items[0].items[0].request.body.mode, "json");
  });

  test("importar otra vez actualiza esa colección en vez de duplicarla", async () => {
    const again = await api()
      .post(`${base()}/collections/import`)
      .set(as(owner))
      .send({ text: JSON.stringify(postmanFile()) });
    assert.equal(again.body.action, "updated");
    assert.equal(again.body.id, collectionId);
    const list = (await api().get(`${base()}/collections`).set(as(owner))).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].requests, 3);
  });

  test("correrla encadena las variables: crea, lee lo creado y lo borra", async () => {
    const started = await api()
      .post(`${base()}/collections/${collectionId}/runs`)
      .set(as(owner))
      .send({ environmentId });
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const run = await finished(started.body.runId);
    assert.equal(run.status, "passed", JSON.stringify(run.results, null, 2));
    assert.equal(run.totals.requests, 3);
    assert.equal(run.totals.failed, 0);
    assert.equal(run.totals.testsFailed, 0);
    assert.equal(run.totals.tests, 4);
    assert.deepEqual(
      run.results.map((result: { name: string; status: number }) => [result.name, result.status]),
      [
        ["Setup · crear un widget", 201],
        ["lo creado se lee", 200],
        ["borrarlo", 204],
      ],
    );
    assert.equal(run.results[0].folder, "01 · Widgets");
  });

  test("enviar una petición suelta usa los scripts de encima y contesta con sus tests", async () => {
    const view = (await api().get(`${base()}/collections/${collectionId}`).set(as(owner))).body;
    const create = view.items[0].items[0];
    const sent = await api()
      .post(`${base()}/collections/${collectionId}/send`)
      .set(as(owner))
      .send({
        environmentId,
        itemId: create.id,
        request: create.request,
        preRequestScript: create.preRequestScript,
        postResponseScript: create.postResponseScript,
      });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.response.status, 201);
    assert.equal(sent.body.scripts.post.tests[0].passed, true);
    // Lo que el script escribió vuelve, que es lo que el runner encadena.
    assert.ok(sent.body.variables.widget_id);
  });

  test("guardar el árbol editado, y exportarlo devuelve el fichero de Postman", async () => {
    const view = (await api().get(`${base()}/collections/${collectionId}`).set(as(owner))).body;
    const items = [
      { ...view.items[0], name: "01 · Widgets (editada)", items: view.items[0].items.slice(0, 2) },
    ];
    const saved = await api()
      .put(`${base()}/collections/${collectionId}`)
      .set(as(owner))
      .send({
        name: "Widgets",
        description: "editada",
        document: {
          auth: view.auth,
          variables: view.variables,
          preRequestScript: "",
          postResponseScript: "",
          items,
        },
      });
    assert.equal(saved.status, 204, JSON.stringify(saved.body));

    const exported = await api().get(`${base()}/collections/${collectionId}/export`).set(as(owner));
    assert.equal(exported.status, 200);
    assert.equal(exported.body.file.info.name, "Widgets");
    assert.equal(exported.body.file.item[0].name, "01 · Widgets (editada)");
    assert.equal(exported.body.file.item[0].item.length, 2);
    // La query vuelve montada en la URL cruda, y la apagada sale marcada como allí.
    const read = exported.body.file.item[0].item[1];
    assert.equal(read.request.url.raw, "{{baseUrl}}/widgets/{{widget_id}}?full=true");
    assert.deepEqual(read.request.url.query, [
      { key: "full", value: "true" },
      { key: "draft", value: "no", disabled: true },
    ]);

    // Y lo exportado vuelve a entrar: la ida y la vuelta son la misma colección.
    const back = await api()
      .post(`${base()}/collections/import`)
      .set(as(owner))
      .send({ text: JSON.stringify(exported.body.file), name: "Vuelta" });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.requests, 2);
    assert.equal(back.body.folders, 1);
  });

  test("correr una carpeta que no existe es 404; pedir vueltas de más es 422", async () => {
    const folder = await api()
      .post(`${base()}/collections/${collectionId}/runs`)
      .set(as(owner))
      .send({ environmentId, folderId: "no-existe" });
    assert.equal(folder.status, 404);

    const tooMany = await api()
      .post(`${base()}/collections/${collectionId}/runs`)
      .set(as(owner))
      .send({ environmentId, iterations: 999 });
    assert.equal(tooMany.status, 422); // el DTO ya pone el techo: ni llega al comando
  });

  test("un fichero que no es una colección es 422 y no deja nada", async () => {
    const bad = await api().post(`${base()}/collections/import`).set(as(owner)).send({ text: "esto no es json" });
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
    const empty = await api()
      .post(`${base()}/collections/import`)
      .set(as(owner))
      .send({ text: JSON.stringify({ info: { name: "Vacía" }, item: [] }) });
    assert.equal(empty.status, 422);
  });
});
