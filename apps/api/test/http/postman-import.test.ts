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

describe("las variables de Postman, como entorno del proyecto", () => {
  /** El fichero de entorno tal y como lo genera Postman: la URL base es una variable más y los
   * secretos vienen en blanco, que es lo correcto de un fichero que se commitea. */
  const ENVIRONMENT = JSON.stringify({
    id: "6b1e",
    name: "Catalog API — local",
    values: [
      { key: "baseUrl", value: "http://localhost:8000", type: "default", enabled: true },
      { key: "scope", value: "catalog:read", type: "default", enabled: true },
      { key: "access_token", value: "", type: "secret", enabled: true },
      { key: "api_key", value: "una-clave", type: "secret", enabled: true },
      { key: "legacy", value: "x", type: "default", enabled: false },
    ],
    _postman_variable_scope: "environment",
  });

  test("entra con su nombre, su URL base y sus secretos cifrados", async () => {
    const base = await project(true);
    const response = await api().post(`${base}/environments/import/postman`).set(as(owner)).send({ text: ENVIRONMENT });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.name, "Catalog API — local");
    assert.equal(response.body.action, "created");
    assert.equal(response.body.baseUrl, "http://localhost:8000");
    assert.equal(response.body.variables, 4);
    assert.equal(response.body.disabledVariables, 1);
    assert.equal(response.body.secrets, 2);

    const listed = await api().get(`${base}/environments`).set(as(owner));
    const [environment] = listed.body;
    // La URL base sale de la variable y la variable se queda: cada `{{baseUrl}}/v1/x` de un flujo
    // la busca por su nombre.
    assert.equal(environment.variables.baseUrl.initial, "http://localhost:8000");
    // Un secreto no sale nunca: ni su valor ni su longitud.
    assert.equal(environment.variables.api_key.initial, "••••••••");
    assert.equal(environment.variables.api_key.sensitive, true);
    assert.equal(environment.variables.scope.initial, "catalog:read");
    assert.equal(environment.disabledVariables.legacy.initial, "x");
    // El primer entorno de un proyecto es el activo.
    assert.equal(environment.active, true);
  });

  test("volver a importar el mismo fichero no borra el secreto que alguien escribió", async () => {
    // El caso que hace peligrosa la segunda importación: el fichero commiteado trae `access_token`
    // en blanco, y dejarlo ganar sería convertir «traer el entorno otra vez» en «romper el que
    // funcionaba».
    const base = await project(true);
    const first = await api().post(`${base}/environments/import/postman`).set(as(owner)).send({ text: ENVIRONMENT });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const typed = await api()
      .patch(`${base}/environments/${first.body.id}`)
      .set(as(owner))
      .send({ variables: { access_token: { initial: "un-token-de-verdad", sensitive: true } } });
    assert.equal(typed.status, 204, JSON.stringify(typed.body));

    const again = await api()
      .post(`${base}/environments/import/postman`)
      .set(as(owner))
      .send({ text: ENVIRONMENT, baseUrl: "http://host.docker.internal:8000" });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.action, "updated");
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.baseUrl, "http://host.docker.internal:8000");
    assert.ok(
      again.body.notes.some((note: string) => /access_token/.test(note)),
      JSON.stringify(again.body.notes),
    );

    const revealed = await api().get(`${base}/environments/${first.body.id}/variables/reveal`).set(as(owner));
    assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
    // `reveal` contesta nombre → valor en claro, solo de las sensibles.
    assert.equal(revealed.body.access_token, "un-token-de-verdad");
    // Y lo que el fichero sí traía se reescribe.
    assert.equal(revealed.body.api_key, "una-clave");
  });

  test("sin ninguna URL absoluta entre las variables se pide, no se inventa", async () => {
    const base = await project(true);
    const response = await api()
      .post(`${base}/environments/import/postman`)
      .set(as(owner))
      .send({ text: JSON.stringify({ name: "Sin base", values: [{ key: "scope", value: "read" }] }) });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.match(String(response.body.type), /base-url-missing$/);
  });

  test("un fichero sin variables es un 422 y no un entorno vacío", async () => {
    const base = await project(true);
    const response = await api()
      .post(`${base}/environments/import/postman`)
      .set(as(owner))
      .send({ text: JSON.stringify({ name: "Vacío", values: [] }) });
    assert.equal(response.status, 422, JSON.stringify(response.body));
  });
});

/**
 * Una sola puerta, como la de Postman: sueltas cosas, él dice qué son, y luego se importa.
 *
 * Lo que fija esta suite es la mitad que faltaba. **El plan primero**: se pregunta en seco, no se
 * escribe nada, y lo que vuelve es «esto es una colección → endpoints y flujos». Y **el orden**:
 * el contrato entra antes que la colección aunque vengan en el mismo lote, porque si el proyecto
 * tiene contrato las peticiones caen en sus operaciones, y sin él entran como llamadas sueltas —
 * los mismos dos ficheros en el otro orden darían un flujo distinto.
 */
describe("una sola puerta para todo", () => {
  const ENVIRONMENT = JSON.stringify({
    name: "stub local",
    values: [
      { key: "baseUrl", value: "http://localhost:9999", type: "default", enabled: true },
      { key: "access_token", value: "", type: "secret", enabled: true },
    ],
    _postman_variable_scope: "environment",
  });

  test("el plan se lee antes de confirmarlo, y no escribe nada", async () => {
    const base = await project(false);
    const response = await api()
      .post(`${base}/import`)
      .set(as(owner))
      .send({
        dryRun: true,
        sources: [
          { name: "tienda.postman_collection.json", text: COLLECTION },
          { name: "local.postman_environment.json", text: ENVIRONMENT },
          { name: "contrato.yaml", text: STUB_SPEC_YAML },
          { name: "vieja.json", text: JSON.stringify({ name: "Vieja", requests: [] }) },
        ],
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.dryRun, true);
    assert.deepEqual(
      response.body.items.map((item: { kind: string }) => item.kind),
      ["postman-collection", "postman-environment", "openapi", "unknown"],
    );
    // Lo que no se puede leer se dice con algo que hacer, y no hunde el resto del lote.
    assert.match(response.body.items[3].reason, /v2\.1/);
    assert.ok(response.body.items.every((item: { results: unknown[] }) => item.results.length === 0));

    // Nada escrito: el proyecto sigue sin contrato, sin entornos y sin flujos.
    const after = await api().get(`${base}`).set(as(owner));
    assert.equal(after.body.contract, null);
    const flows = await api().get(`${base}/workflows`).set(as(owner));
    assert.equal(flows.body.workflows.length, 0);
  });

  test("todo de una vez, y el contrato entra antes que la colección", async () => {
    const base = await project(false);
    const response = await api()
      .post(`${base}/import`)
      .set(as(owner))
      .send({
        baseUrl: "http://host.docker.internal:9999",
        sources: [
          // A propósito en el orden contrario al que hace falta: lo reordena el servidor.
          { name: "tienda.postman_collection.json", text: COLLECTION },
          { name: "local.postman_environment.json", text: ENVIRONMENT },
          { name: "contrato.yaml", text: STUB_SPEC_YAML },
        ],
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.dryRun, false);

    const byTarget = (target: string) =>
      response.body.items.flatMap((item: { results: { target: string; summary: string }[] }) =>
        item.results.filter((entry) => entry.target === target),
      );
    assert.equal(byTarget("contract").length, 1);
    assert.match(byTarget("contract")[0].summary, /operaciones/);
    assert.match(byTarget("environment")[0].summary, /host\.docker\.internal/);
    assert.equal(byTarget("endpoints").length, 1);

    // La prueba del orden: el contrato ya estaba cuando se leyó la colección, así que dos de las
    // tres peticiones son nodos de petición guardada y no llamadas sueltas.
    const flows = await api().get(`${base}/workflows`).set(as(owner));
    assert.equal(flows.body.requestTemplates.length, 2);
    assert.match(byTarget("flows")[0].summary, /Things \(nuevo, 4 nodos\)/);
  });

  test("un volcado de Postman entra entero: sus colecciones y sus entornos", async () => {
    const base = await project(true);
    const dump = JSON.stringify({
      collections: [JSON.parse(COLLECTION)],
      environments: [JSON.parse(ENVIRONMENT)],
    });
    const response = await api()
      .post(`${base}/import`)
      .set(as(owner))
      .send({ sources: [{ name: "postman-data-dump.json", text: dump }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const [item] = response.body.items;
    assert.equal(item.kind, "postman-dump");
    assert.deepEqual(
      item.pieces.map((piece: { kind: string }) => piece.kind),
      ["postman-collection", "postman-environment"],
    );
    assert.deepEqual([...new Set(item.results.map((entry: { target: string }) => entry.target))].sort(), [
      "endpoints",
      "environment",
      "flows",
    ]);
  });

  test("sin ficheros, sin texto y sin URL es un 422", async () => {
    const base = await project(true);
    const response = await api().post(`${base}/import`).set(as(owner)).send({});
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.match(String(response.body.type), /nothing-to-import$/);
  });

  test("un proyecto que no existe es un 404, no un 201 con cuatro errores dentro", async () => {
    // Sin el guardia, el id malo llegaba a los cuatro manejadores y volvía como cuatro mensajes de
    // Postgres dentro de un 201, que se lee como «el import funcionó pero todo falló».
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${"0".repeat(8)}-0000-0000-0000-000000000000/import`)
      .set(as(owner))
      .send({ sources: [{ name: "x.json", text: COLLECTION }] });
    assert.equal(response.status, 404, JSON.stringify(response.body));
    assert.match(String(response.body.type), /project-not-found$/);
  });

  test("«ya estaban» y «sin importar» se cuentan aparte, porque no son lo mismo", async () => {
    // Importar una colección sobre su propio contrato deja casi todo repetido, y «46 sin importar»
    // manda a alguien a buscar un problema que no existe.
    const base = await project(true);
    const send = () =>
      api()
        .post(`${base}/import`)
        .set(as(owner))
        .send({ sources: [{ name: "tienda.postman_collection.json", text: COLLECTION }] });
    await send();
    const again = await send();
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const endpoints = again.body.items[0].results.find((entry: { target: string }) => entry.target === "endpoints");
    assert.match(endpoints.summary, /ya estaban/);
    assert.doesNotMatch(endpoints.summary, /sin importar/);
  });
});

describe("un proyecto exportado de aquí, por la misma puerta", () => {
  // Tenía una puerta propia en el cajón de flujos, que además sólo traía los flujos: el resto del
  // fichero —endpoints, entornos, roles— se tiraba sin decirlo.
  test("se reconoce y entra, sin tocar el nombre ni la URL base del proyecto que lo recibe", async () => {
    const source = await project(true);
    await api()
      .post(`${source}/import`)
      .set(as(owner))
      .send({ sources: [{ name: "tienda.postman_collection.json", text: COLLECTION }] });
    const exported = await api().get(`${source}/export`).set(as(owner));
    assert.equal(exported.status, 200, JSON.stringify(exported.body));

    const target = await project(false);
    const before = await api().get(target).set(as(owner));
    const response = await api()
      .post(`${target}/import`)
      .set(as(owner))
      .send({ sources: [{ name: "proyecto.json", text: JSON.stringify(exported.body) }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    const item = response.body.items[0];
    assert.equal(item.kind, "eq-bundle");
    assert.deepEqual(
      item.results.map((entry: { target: string; error: string | null }) => [entry.target, entry.error]),
      [["project", null]],
    );
    assert.match(item.results[0].summary, /flujos/);

    // Los ajustes se dejan fuera a propósito: quien suelta un fichero en un proyecto que ya tiene
    // está trayendo contenido, no renombrando aquello en lo que está.
    const after = await api().get(target).set(as(owner));
    assert.equal(after.body.name, before.body.name);
    assert.equal(after.body.baseUrl, before.body.baseUrl);
    const flows = await api().get(`${target}/workflows`).set(as(owner));
    assert.ok(flows.body.workflows.length > 0, "los flujos del fichero tienen que haber entrado");
  });
});
