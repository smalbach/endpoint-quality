/**
 * Una colección de Postman, importada como endpoints y como flujos, contra la API de verdad.
 *
 * Las dos mitades de lo mismo. Una colección es lo que la gente tiene de verdad, y trae dos cosas
 * que este producto quiere por separado: **las URL**, que son endpoints del proyecto, y **los
 * tests**, que son el orden y las afirmaciones de un escenario y por tanto un flujo.
 *
 * Lo que estas pruebas fijan, más allá de que funcione:
 *
 * - Importar dos veces la misma colección **actualiza** los mismos flujos, no crea copias. Es el
 *   caso ordinario —cambió un test, la carpeta ganó un paso— y «Pedidos (copia 2)» dejaría a
 *   alguien averiguando cuál de tres es el vivo.
 * - Una petición que el contrato declara entra como nodo de petición guardada; una que no, como
 *   nodo «fetch» con su llamada escrita. Nunca se inventa una operación.
 * - Un test que se sabe leer sale como comprobaciones del nodo; uno que no, como nodo script con el
 *   código tal cual. Nada se traduce a medias.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api()
    .post("/auth/register")
    .send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}

/** Un proyecto, con contrato o sin él. */
async function project(withContract: boolean): Promise<string> {
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `postman-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const base = `/orgs/${owner.organizationId}/projects/${created.body.projectId}`;
  if (withContract) {
    const imported = await api()
      .post(`${base}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
  }
  return base;
}

/** La colección de ejemplo: una carpeta con tres peticiones, dos de ellas del contrato. */
const COLLECTION = JSON.stringify({
  info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    {
      name: "Things",
      item: [
        {
          name: "Crear thing",
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "X-Tenant", value: "acme" },
            ],
            url: { raw: "{{baseUrl}}/things" },
            body: { mode: "raw", raw: '{"name":"silla","size":4}', options: { raw: { language: "json" } } },
          },
          event: [
            {
              listen: "test",
              script: {
                exec: [
                  'pm.test("Se creó", function () {',
                  "  pm.response.to.have.status(201);",
                  "  const jsonData = pm.response.json();",
                  '  pm.environment.set("thingId", jsonData.data.id);',
                  "});",
                ],
              },
            },
          ],
        },
        {
          name: "Leer thing",
          request: { method: "GET", header: [], url: { raw: "{{baseUrl}}/things/{{thingId}}" } },
          event: [
            {
              listen: "test",
              script: {
                exec: [
                  'pm.test("Sigue ahí", function () {',
                  "  const j = pm.response.json();",
                  "  for (const key of Object.keys(j)) { pm.expect(key).to.exist; }",
                  "});",
                ],
              },
            },
          ],
        },
        {
          name: "Avisar al webhook",
          request: {
            method: "POST",
            header: [{ key: "Authorization", value: "Bearer un-token-de-verdad" }],
            url: { raw: "https://hooks.ejemplo.com/aviso" },
            body: { mode: "raw", raw: '{"ok":true}' },
          },
        },
      ],
    },
  ],
});

before(async () => {
  context = await createTestApp();
  owner = await signUp(`postman-${Date.now()}@ejemplo.com`);
});
after(async () => {
  await context?.close();
});

describe("las URL de una colección, como endpoints del proyecto", () => {
  test("entran por el importador de ficheros, y una segunda vez no se duplican", async () => {
    const base = await project(true);
    const first = await api()
      .post(`${base}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from(COLLECTION), "tienda.postman_collection.json");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.format, "postman");
    // `POST /things` ya está: importar el contrato crea un endpoint por operación, y el importador
    // no dobla una ruta que el proyecto tiene. Las otras dos son nuevas — una de ellas con un
    // `{{thingId}}` donde el contrato escribe `{id}`, que son rutas distintas hasta que alguien lo
    // edite.
    assert.deepEqual(
      first.body.imported.map((entry: { method: string; path: string }) => `${entry.method} ${entry.path}`).sort(),
      ["GET /things/{{thingId}}", "POST /aviso"],
    );
    assert.deepEqual(
      first.body.skipped.map((entry: { path: string; reason: string }) => [entry.path, entry.reason]),
      [["/things", "El proyecto ya tiene este endpoint"]],
    );

    const again = await api()
      .post(`${base}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from(COLLECTION), "tienda.postman_collection.json");
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.imported.length, 0);
    assert.equal(again.body.skipped.length, 3);
    assert.ok(again.body.skipped.every((entry: { reason: string }) => /ya tiene este endpoint/.test(entry.reason)));
  });
});

describe("los tests de una colección, como flujos del proyecto", () => {
  test("una carpeta es un flujo, con sus aristas, sus comprobaciones y sus capturas", async () => {
    const base = await project(true);
    const response = await api().post(`${base}/workflows/import/postman`).set(as(owner)).send({ text: COLLECTION });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.collection, "Tienda");
    assert.equal(response.body.flows.length, 1);
    const [flow] = response.body.flows;
    assert.equal(flow.name, "Things");
    assert.equal(flow.action, "created");
    // Dos peticiones del contrato, una llamada suelta y un nodo script para el test que no se
    // pudo leer (el `for`).
    assert.equal(flow.requests, 2);
    assert.equal(flow.calls, 1);
    assert.equal(flow.scripts, 1);

    const saved = await api().get(`${base}/workflows`).set(as(owner));
    assert.equal(saved.status, 200);
    const steps: Record<string, unknown>[] = saved.body.workflows.find(
      (row: { id: string }) => row.id === flow.id,
    ).steps;

    // El orden de la carpeta son las aristas: una cadena, nunca un abanico.
    assert.deepEqual(
      steps.map((step) => [step.id, step.dependsOn]),
      [
        ["crear-thing", undefined],
        ["leer-thing", ["crear-thing"]],
        ["leer-thing-test", ["leer-thing"]],
        ["avisar-al-webhook", ["leer-thing-test"]],
      ],
    );
    // El `pm.environment.set` del primer test es una captura, y el estado que afirmaba es lo que
    // la petición guardada espera: no se queda además como comprobación.
    assert.deepEqual(steps[0].captures, [{ variable: "thingId", from: "body", path: "data.id" }]);
    assert.equal(steps[0].checks, undefined);
    // El test con un `for` no se traduce: se guarda tal cual y lo ejecuta el sandbox.
    assert.equal(steps[2].kind, "script");
    assert.match(String((steps[2].script as { code: string }).code), /for \(const key of Object.keys\(j\)\)/);
    // La llamada que el contrato no declara se escribe en el nodo, y su credencial a mano se cae.
    assert.equal(steps[3].kind, "fetch");
    assert.equal((steps[3].fetch as { url: string }).url, "https://hooks.ejemplo.com/aviso");
    assert.equal((steps[3].fetch as { useSession?: boolean }).useSession, true);
    assert.equal((steps[3].fetch as { headers?: Record<string, string> }).headers?.Authorization, undefined);
    assert.ok(response.body.notes.some((note: string) => /credencial/.test(note)));

    // Las peticiones guardadas que los nodos nombran existen, con el nombre completo de la carpeta.
    const names = saved.body.requestTemplates.map((template: { name: string }) => template.name).sort();
    assert.deepEqual(names, ["Things / Crear thing", "Things / Leer thing"]);
    assert.equal(response.body.templates.created, 2);
  });

  test("importar otra vez actualiza el mismo flujo en vez de crear una copia", async () => {
    const base = await project(true);
    const first = await api().post(`${base}/workflows/import/postman`).set(as(owner)).send({ text: COLLECTION });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const again = await api().post(`${base}/workflows/import/postman`).set(as(owner)).send({ text: COLLECTION });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.flows[0].action, "updated");
    assert.equal(again.body.flows[0].id, first.body.flows[0].id);
    assert.equal(again.body.templates.created, 0);
    assert.equal(again.body.templates.updated, 2);

    const saved = await api().get(`${base}/workflows`).set(as(owner));
    assert.equal(saved.body.workflows.length, 1);
    assert.equal(saved.body.requestTemplates.length, 2);
  });

  test("sin contrato entra todo como nodos fetch, y se dice por qué", async () => {
    const base = await project(false);
    const response = await api().post(`${base}/workflows/import/postman`).set(as(owner)).send({ text: COLLECTION });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.flows[0].requests, 0);
    assert.equal(response.body.flows[0].calls, 3);
    assert.ok(response.body.notes.some((note: string) => /contrato activo/.test(note)));
  });

  test("lo que no es una colección se dice como un 422, no como un flujo vacío", async () => {
    const base = await project(true);
    const response = await api().post(`${base}/workflows/import/postman`).set(as(owner)).send({ text: "no soy json" });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.match(String(response.body.type), /postman-invalid$/);
  });

  test("otra organización no importa nada en este proyecto", async () => {
    const base = await project(true);
    const stranger = await signUp(`postman-ajeno-${Date.now()}@ejemplo.com`);
    const response = await api().post(`${base}/workflows/import/postman`).set(as(stranger)).send({ text: COLLECTION });
    // 403 en el guard de la organización: no pertenece a ella, así que la ruta no llega al proyecto.
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });
});
