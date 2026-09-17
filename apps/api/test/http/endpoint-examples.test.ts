/**
 * Los ejemplos guardados, por la API: guardarlos desde una respuesta real, leerlos, renombrarlos,
 * borrarlos, importarlos de una colección de Postman y volver a exportarlos.
 *
 * Lo que estas pruebas demuestran y las unitarias no pueden: que la redacción está **en el camino**.
 * Se puede tener un `redactExample` perfecto y una ruta que guarda el cuerpo sin llamarlo, y las
 * pruebas del dominio seguirían verdes con el token en la base de datos. Así que aquí se manda un
 * token de verdad por HTTP y se comprueba que lo que vuelve no lo tiene.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
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

let owner: Actor;
let outsider: Actor;
let projectId: string;
let endpointId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

/** Un JWT de verdad, para que la detección por forma tenga algo real que morder. */
const JWT = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from('{"sub":"ana"}').toString("base64url"),
  "ZmlybWE",
].join(".");

const pair = (patch: { status?: number; body?: string; requestHeaders?: Record<string, string> } = {}) => ({
  request: {
    method: "POST",
    url: "https://api.ejemplo.com/v1/sesiones",
    headers: Object.entries(patch.requestHeaders ?? { "Content-Type": "application/json" }).map(([name, value]) => ({
      name,
      value,
      enabled: true,
    })),
    body: { text: '{"usuario":"ana"}', contentType: "application/json" },
  },
  response: {
    status: patch.status ?? 200,
    headers: [{ name: "Content-Type", value: "application/json", enabled: true }],
    body: patch.body ?? '{"id":7}',
    contentType: "application/json",
    durationMs: 31,
  },
});

before(async () => {
  context = await createTestApp();
  owner = await signUp(`examples-${Date.now()}@example.test`);
  outsider = await signUp(`examples-outsider-${Date.now()}@example.test`);

  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Ejemplos" });
  assert.equal(project.status, 201);
  // El POST de proyecto contesta `projectId`, no `id`.
  projectId = project.body.projectId;

  const endpoint = await api()
    .post(`${base()}/endpoints`)
    .set(as(owner))
    .send({ method: "POST", path: "/v1/sesiones" });
  assert.equal(endpoint.status, 201);
  endpointId = endpoint.body.id;
});

after(async () => {
  await context.close();
});

describe("guardar una respuesta como ejemplo", () => {
  test("el nombre lo pone el código de estado cuando no se escribe uno", async () => {
    const saved = await api().post(`${base()}/endpoints/${endpointId}/examples`).set(as(owner)).send(pair());
    assert.equal(saved.status, 201);
    assert.equal(saved.body.example.name, "200 correcto");
    assert.equal(saved.body.example.response.status, 200);
    assert.equal(saved.body.example.origin, "manual");
    // El cuerpo vuelve indentado: la redacción lo reserializa, y un ejemplo se lee. El tamaño es
    // el del cuerpo guardado, no el del que se mandó, que es lo correcto — es lo que ocupa la fila.
    assert.equal(saved.body.example.response.body, '{\n  "id": 7\n}');
    assert.equal(saved.body.example.sizeBytes, 13);
  });

  test("y sale en la lista del endpoint", async () => {
    const list = await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(owner));
    assert.equal(list.status, 200);
    assert.equal(list.body.examples.length, 1);
    assert.equal(list.body.examples[0].name, "200 correcto");
  });

  test("el token NO se guarda, ni en la cabecera ni en el cuerpo, y se dice qué se quitó", async () => {
    // Esta es la prueba que importa. Si la redacción no estuviera en el camino, el ejemplo se
    // guardaría igual y nadie se enteraría hasta exportarlo a un repositorio.
    const saved = await api()
      .post(`${base()}/endpoints/${endpointId}/examples`)
      .set(as(owner))
      .send(
        pair({
          status: 201,
          requestHeaders: { Authorization: "Bearer s3cr3t0", "Content-Type": "application/json" },
          body: JSON.stringify({ id: 7, access_token: "s3cr3t0", jwt: JWT }),
        }),
      );
    assert.equal(saved.status, 201);

    const text = JSON.stringify(saved.body.example);
    assert.ok(!text.includes("s3cr3t0"), "el secreto sigue dentro del ejemplo guardado");
    assert.ok(!text.includes(JWT), "el JWT sigue dentro del ejemplo guardado");
    assert.deepEqual(saved.body.redaction.droppedHeaders, ["Authorization"]);
    assert.deepEqual(saved.body.redaction.maskedFields.sort(), ["access_token", "jwt (JWT)"]);
    // Y lo que no era un secreto sigue ahí: el ejemplo sirve para algo.
    assert.match(saved.body.example.response.body, /"id": 7/);
  });

  test("dos con el mismo estado no chocan: el segundo se numera", async () => {
    const saved = await api().post(`${base()}/endpoints/${endpointId}/examples`).set(as(owner)).send(pair());
    assert.equal(saved.status, 201);
    assert.equal(saved.body.example.name, "200 correcto 2");
  });

  test("un código que no es HTTP se rechaza con el campo, no con un 500", async () => {
    const saved = await api()
      .post(`${base()}/endpoints/${endpointId}/examples`)
      .set(as(owner))
      .send(pair({ status: 999 }));
    assert.equal(saved.status, 422);
    assert.ok(saved.body.errors.some((problem: { field: string }) => problem.field === "response.status"));
  });

  test("un endpoint de otro proyecto no existe para este", async () => {
    const other = await api()
      .post(`/orgs/${outsider.organizationId}/projects`)
      .set(as(outsider))
      .send({ name: "Ajeno" });
    const alien = await api()
      .post(`/orgs/${outsider.organizationId}/projects/${other.body.projectId}/endpoints`)
      .set(as(outsider))
      .send({ method: "GET", path: "/ajeno" });
    // El id existe, pero no en este proyecto: 404, no 403 ni una lista vacía.
    const saved = await api().post(`${base()}/endpoints/${alien.body.id}/examples`).set(as(owner)).send(pair());
    assert.equal(saved.status, 404);
  });
});

describe("cambiar y borrar", () => {
  test("renombrar, y no dejar dos con el mismo nombre", async () => {
    const list = await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(owner));
    const first = list.body.examples[0];
    const second = list.body.examples[1];

    const renamed = await api()
      .patch(`${base()}/endpoints/${endpointId}/examples/${first.id}`)
      .set(as(owner))
      .send({ name: "Sesión abierta" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.example.name, "Sesión abierta");

    const clash = await api()
      .patch(`${base()}/endpoints/${endpointId}/examples/${second.id}`)
      .set(as(owner))
      .send({ name: "Sesión abierta" });
    assert.equal(clash.status, 409);
  });

  test("reeditar el par pasa otra vez por la redacción", async () => {
    // Sin esto, editar sería el camino para meter un token en la base de datos.
    const list = await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(owner));
    const target = list.body.examples[0];
    const updated = await api()
      .patch(`${base()}/endpoints/${endpointId}/examples/${target.id}`)
      .set(as(owner))
      .send({ response: pair({ body: JSON.stringify({ token: "otro-secreto" }) }).response });
    assert.equal(updated.status, 200);
    assert.ok(!JSON.stringify(updated.body.example).includes("otro-secreto"));
    assert.deepEqual(updated.body.redaction.maskedFields, ["token"]);
  });

  test("borrar uno deja los otros", async () => {
    const before = await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(owner));
    const count = before.body.examples.length;
    const target = before.body.examples[0];

    const gone = await api().delete(`${base()}/endpoints/${endpointId}/examples/${target.id}`).set(as(owner));
    assert.equal(gone.status, 204);

    const after = await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(owner));
    assert.equal(after.body.examples.length, count - 1);
    assert.ok(!after.body.examples.some((row: { id: string }) => row.id === target.id));
  });

  test("borrar el mismo dos veces es un 404, no un 204 que miente", async () => {
    const list = await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(owner));
    const target = list.body.examples[0];
    assert.equal(
      (await api().delete(`${base()}/endpoints/${endpointId}/examples/${target.id}`).set(as(owner))).status,
      204,
    );
    assert.equal(
      (await api().delete(`${base()}/endpoints/${endpointId}/examples/${target.id}`).set(as(owner))).status,
      404,
    );
  });

  test("quien no es de la organización no ve ni escribe nada", async () => {
    assert.equal((await api().get(`${base()}/endpoints/${endpointId}/examples`).set(as(outsider))).status, 403);
    assert.equal(
      (await api().post(`${base()}/endpoints/${endpointId}/examples`).set(as(outsider)).send(pair())).status,
      403,
    );
  });
});

describe("una colección de Postman con ejemplos", () => {
  /** Una colección como la que exporta Postman: dos ejemplos, uno de ellos con el token en claro. */
  const collection = {
    info: { name: "Sesiones", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [
      {
        name: "Abrir sesión",
        request: {
          method: "POST",
          url: { raw: "{{baseUrl}}/v1/entrar" },
          header: [{ key: "Content-Type", value: "application/json" }],
          body: { mode: "raw", raw: '{"usuario":"ana"}' },
        },
        response: [
          {
            name: "200 con token",
            originalRequest: {
              method: "POST",
              url: { raw: "{{baseUrl}}/v1/entrar" },
              header: [{ key: "Content-Type", value: "application/json" }],
              body: { mode: "raw", raw: '{"usuario":"ana","password":"1234"}' },
            },
            status: "OK",
            code: 200,
            _postman_previewlanguage: "json",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "Set-Cookie", value: "sesion=abc; Path=/" },
            ],
            body: `{"access_token":"s3cr3t0-del-fichero","expires_in":3600}`,
          },
          {
            name: "401 mal",
            status: "Unauthorized",
            code: 401,
            _postman_previewlanguage: "json",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: `{"error":"credenciales"}`,
          },
          // Sin `code`: no hay valor por defecto honesto, así que se descarta.
          { name: "sin estado", body: "{}" },
        ],
      },
    ],
  };

  let importedId: string;

  test("entra con ellos, y antes esto los perdía enteros", async () => {
    const imported = await api()
      .post(`${base()}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from(JSON.stringify(collection)), "sesiones.postman_collection.json");
    assert.equal(imported.status, 201);
    assert.equal(imported.body.imported.length, 1);
    // Dos de los tres: el que no trae código de estado no entra.
    assert.equal(imported.body.examples.imported, 2);
    importedId = imported.body.imported[0].id;
  });

  test("el token que traía el fichero no llega a la base de datos", async () => {
    // Postman guarda los ejemplos en claro, así que un fichero de verdad llega con tokens dentro.
    // Entrar por el importador no puede ser la puerta por la que se cuelan.
    const list = await api().get(`${base()}/endpoints/${importedId}/examples`).set(as(owner));
    assert.equal(list.status, 200);
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes("s3cr3t0-del-fichero"));
    assert.ok(!text.includes("1234"), "la contraseña del originalRequest sigue dentro");
    assert.ok(!text.includes("sesion=abc"), "la cookie de sesión sigue dentro");
  });

  test("conserva el nombre, el estado y la petición que lo produjo", async () => {
    const list = await api().get(`${base()}/endpoints/${importedId}/examples`).set(as(owner));
    const names = list.body.examples.map((row: { name: string }) => row.name);
    assert.deepEqual(names.sort(), ["200 con token", "401 mal"]);

    const ok = list.body.examples.find((row: { name: string }) => row.name === "200 con token");
    assert.equal(ok.origin, "import");
    // `originalRequest` y no la petición actual: el ejemplo se guardó con otro cuerpo a propósito.
    assert.match(ok.request.url, /\/v1\/entrar$/);
    assert.match(ok.request.body.text, /usuario/);
    // Y lo que no era un secreto sobrevive.
    assert.match(ok.response.body, /expires_in/);

    const bad = list.body.examples.find((row: { name: string }) => row.name === "401 mal");
    assert.equal(bad.response.status, 401);
    // Sin `originalRequest`, la petición es la del item, que es lo que Postman enseña.
    assert.equal(bad.request.method, "POST");
  });

  test("y vuelven a salir al exportar la colección, que es la ida y vuelta", async () => {
    const exported = await api().get(`${base()}/export/postman?kind=endpoints`).set(as(owner));
    assert.equal(exported.status, 200);
    // La respuesta es `{ kind, filename, file, counts, skipped }`: la colección va en `file`.
    const items = exported.body.file.item as {
      name: string;
      response?: { name: string; code: number; body: string; originalRequest: { method: string } }[];
    }[];
    const item = items.find((row) => row.name.includes("/v1/entrar"));
    assert.ok(item, "el endpoint importado no está en el fichero exportado");
    assert.equal(item.response?.length, 2);

    const ok = item.response?.find((row) => row.name === "200 con token");
    assert.equal(ok?.code, 200);
    assert.equal(ok?.originalRequest.method, "POST");
    // Lo tapado sale tapado: la redacción se hizo en la puerta y no hay que repetirla aquí.
    assert.ok(!JSON.stringify(exported.body).includes("s3cr3t0-del-fichero"));
    assert.match(ok?.body ?? "", /expires_in/);
  });
});

describe("un HAR del navegador", () => {
  /**
   * Una sesión como la que sale de la pestaña de red: la página, sus recursos, un preflight,
   * telemetría, y tres peticiones a la API — dos de ellas a la misma ruta.
   */
  const session = {
    log: {
      version: "1.2",
      creator: { name: "Chrome DevTools" },
      pages: [{ title: "https://tienda.test/pedidos" }],
      entries: [
        {
          request: { method: "GET", url: "https://tienda.test/pedidos", headers: [] },
          response: { status: 200, headers: [], content: { mimeType: "text/html", text: "<html></html>" } },
        },
        {
          request: { method: "GET", url: "https://tienda.test/assets/app.js", headers: [] },
          response: { status: 200, headers: [], content: { mimeType: "application/javascript", text: "//" } },
        },
        {
          request: { method: "OPTIONS", url: "https://api.tienda.test/v1/pedidos", headers: [] },
          response: { status: 204, headers: [], content: { mimeType: "" } },
        },
        {
          request: { method: "POST", url: "https://www.google-analytics.com/collect", headers: [] },
          response: { status: 200, headers: [], content: { mimeType: "application/json", text: "{}" } },
        },
        {
          request: {
            method: "GET",
            url: "https://api.tienda.test/v1/pedidos?page=1",
            headers: [
              { name: ":authority", value: "api.tienda.test" },
              { name: "Authorization", value: "Bearer TOKEN-DEL-NAVEGADOR" },
              { name: "Accept", value: "application/json" },
            ],
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: [
              { name: "Content-Type", value: "application/json" },
              { name: "Set-Cookie", value: "sesion=abc; Path=/" },
            ],
            content: { mimeType: "application/json", text: '{"items":[{"id":7}],"access_token":"SECRETO-HAR"}' },
          },
        },
        {
          request: { method: "GET", url: "https://api.tienda.test/v1/pedidos?page=2", headers: [] },
          response: {
            status: 404,
            statusText: "Not Found",
            headers: [{ name: "Content-Type", value: "application/json" }],
            content: { mimeType: "application/json", text: '{"error":"no hay más"}' },
          },
        },
        {
          request: {
            method: "POST",
            url: "https://api.tienda.test/v1/pedidos",
            headers: [{ name: "Content-Type", value: "application/json" }],
            postData: { mimeType: "application/json", text: '{"total":10}' },
          },
          response: {
            status: 201,
            statusText: "Created",
            headers: [{ name: "Content-Type", value: "application/json" }],
            content: { mimeType: "application/json", text: '{"id":8}' },
          },
        },
      ],
    },
  };

  let imported: { id: string; method: string; path: string }[] = [];

  test("de siete entradas entran dos endpoints, y los descartes se cuentan con su motivo", async () => {
    const response = await api()
      .post(`${base()}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from(JSON.stringify(session)), "tienda.har");
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.format, "har");

    imported = response.body.imported;
    // `GET /v1/pedidos` y `POST /v1/pedidos`: la cadena de consulta no separa dos endpoints.
    assert.deepEqual(imported.map((row: { method: string; path: string }) => `${row.method} ${row.path}`).sort(), [
      "GET /v1/pedidos",
      "POST /v1/pedidos",
    ]);
    const reasons = response.body.skipped.map((row: { reason: string }) => row.reason).join(" | ");
    assert.match(reasons, /preflight/);
    assert.match(reasons, /telemetría/);
    assert.match(reasons, /recursos de la página/);
  });

  test("y con ellos los ejemplos: es el único formato que trae las respuestas", async () => {
    const get = imported.find((row) => row.method === "GET")!;
    const list = await api().get(`${base()}/endpoints/${get.id}/examples`).set(as(owner));
    assert.equal(list.status, 200);
    // Dos entradas de la misma ruta: dos ejemplos del mismo endpoint, no dos endpoints.
    assert.deepEqual(list.body.examples.map((row: { name: string }) => row.name).sort(), ["200 OK", "404 Not Found"]);
  });

  test("el token que el navegador grabó no llega a ningún sitio", async () => {
    const get = imported.find((row) => row.method === "GET")!;
    const list = await api().get(`${base()}/endpoints/${get.id}/examples`).set(as(owner));
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes("TOKEN-DEL-NAVEGADOR"), "la cabecera Authorization del HAR está guardada");
    assert.ok(!text.includes("SECRETO-HAR"), "el token del cuerpo de la respuesta está guardado");
    assert.ok(!text.includes("sesion=abc"), "la cookie de sesión está guardada");
    // Y lo que no era un secreto sobrevive: el ejemplo documenta algo.
    assert.match(list.body.examples.find((row: { name: string }) => row.name === "200 OK").response.body, /"id": 7/);

    // El endpoint sabe que llevaba credencial, con el tipo y sin el valor.
    const endpoint = await api().get(`${base()}/endpoints/${get.id}`).set(as(owner));
    assert.equal(endpoint.body.auth.type, "bearer");
    assert.equal(endpoint.body.auth.params.token, "");
    assert.equal(endpoint.body.requiresAuth, true);
  });

  test("el cuerpo que se mandó entra con el endpoint que lo mandaba", async () => {
    const post = imported.find((row) => row.method === "POST")!;
    const endpoint = await api().get(`${base()}/endpoints/${post.id}`).set(as(owner));
    assert.equal(endpoint.body.body.mode, "json");
    assert.match(endpoint.body.body.text, /"total"/);
  });
});
