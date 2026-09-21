/**
 * El servidor de mocks, por HTTP: crearlo, y que su URL conteste **sin sesión**.
 *
 * Lo que estas pruebas demuestran y las unitarias no pueden: que la ruta pública está de verdad
 * abierta, y que está abierta **solo hasta donde tiene que estarlo**. Se puede tener un motor
 * perfecto y un `@Public()` mal puesto, o un `publicId` que se resuelve sin comprobar la clave, y el
 * dominio seguiría verde mientras la URL entrega los ejemplos de otro proyecto.
 *
 * Así que aquí se llama a la URL del mock **sin ninguna cabecera de autenticación** y se comprueba
 * lo que contesta; y al mock privado sin clave, con una clave equivocada, y con la suya.
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
let projectId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

/** Un endpoint del proyecto, con un ejemplo guardado detrás. */
async function endpointWith(
  method: string,
  path: string,
  examples: { name: string; status: number; body: string; url?: string; contentType?: string }[],
): Promise<string> {
  const created = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method, path });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const endpointId: string = created.body.id;
  for (const example of examples) {
    const saved = await api()
      .post(`${base()}/endpoints/${endpointId}/examples`)
      .set(as(owner))
      .send({
        name: example.name,
        request: {
          method,
          url: example.url ?? `https://api.ejemplo.com${path}`,
          headers: [{ name: "Authorization", value: "Bearer TOKEN-EN-CLARO", enabled: true }],
          body: { text: "", contentType: "application/json" },
        },
        response: {
          status: example.status,
          headers: [
            { name: "Content-Type", value: example.contentType ?? "application/json", enabled: true },
            { name: "X-Total", value: "7", enabled: true },
            // Las dos que el mock no puede reenviar: el cuerpo se guardó ya descomprimido, y la
            // longitud la recalcula el servidor.
            { name: "Content-Encoding", value: "gzip", enabled: true },
            { name: "Content-Length", value: "99999", enabled: true },
          ],
          body: example.body,
          contentType: example.contentType ?? "application/json",
          durationMs: 21,
        },
      });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  }
  return endpointId;
}

async function createMock(patch: { name: string; visibility: "public" | "private"; delay?: unknown }) {
  const created = await api().post(`${base()}/mocks`).set(as(owner)).send(patch);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body as { mock: { id: string; publicId: string; apiKeyPreview: string }; apiKey: string | null };
}

before(async () => {
  context = await createTestApp();
  owner = await signUp(`mocks-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Mocks" });
  assert.equal(project.status, 201);
  projectId = project.body.projectId;
});

after(async () => {
  await context?.close();
});

describe("crear un mock", () => {
  test("hay que decir si es público o privado: no hay valor por defecto", async () => {
    // Un mock sirve datos reales de alguien —redactados, pero reales—, y si la opción cómoda fuera
    // la abierta se publicaría sin decidirlo.
    const sin = await api().post(`${base()}/mocks`).set(as(owner)).send({ name: "sin decidir" });
    assert.equal(sin.status, 422);
  });

  test("un mock privado devuelve su clave una vez, y de ella solo queda el resumen", async () => {
    const created = await createMock({ name: "privado", visibility: "private" });
    assert.ok(created.apiKey && created.apiKey.length >= 32);
    assert.match(created.mock.apiKeyPreview, /…/);

    const list = await api().get(`${base()}/mocks`).set(as(owner));
    const row = list.body.mocks.find((mock: { id: string }) => mock.id === created.mock.id);
    // Ni la clave ni su hash vuelven a salir por la API.
    assert.equal(row.apiKey, undefined);
    assert.equal(row.apiKeyHash, undefined);
    assert.equal(row.apiKeyPreview, created.mock.apiKeyPreview);
  });

  test("un mock público no tiene clave, y rotar una que no existe es un 409", async () => {
    const created = await createMock({ name: "sin clave", visibility: "public" });
    assert.equal(created.apiKey, null);
    const rotated = await api().post(`${base()}/mocks/${created.mock.id}/key`).set(as(owner)).send({});
    assert.equal(rotated.status, 409);
  });

  test("la lista dice cuántas rutas pueden contestar, que es lo que hace falta saber antes", async () => {
    const list = await api().get(`${base()}/mocks`).set(as(owner));
    assert.equal(list.status, 200);
    assert.equal(list.body.prefix, "/mock");
    assert.equal(typeof list.body.coverage.withExamples, "number");
    assert.ok(list.body.coverage.endpoints >= list.body.coverage.withExamples);
  });

  test("un retardo mayor del máximo no se acepta: mientras espera tiene un socket ocupado", async () => {
    const created = await api()
      .post(`${base()}/mocks`)
      .set(as(owner))
      .send({ name: "lento", visibility: "public", delay: { kind: "fixed", ms: 60_000 } });
    assert.equal(created.status, 422);
  });
});

describe("la URL pública", () => {
  let publicId: string;

  before(async () => {
    await endpointWith("GET", "/v1/pedidos/{id}", [
      { name: "el bueno", status: 200, body: '{"id":"42","total":9}' },
      { name: "el que no está", status: 404, body: '{"error":"no existe"}' },
    ]);
    await endpointWith("GET", "/v1/pedidos", [
      { name: "página 1", status: 200, body: '{"page":1}', url: "https://api.ejemplo.com/v1/pedidos?page=1" },
      { name: "página 2", status: 200, body: '{"page":2}', url: "https://api.ejemplo.com/v1/pedidos?page=2" },
    ]);
    await endpointWith("POST", "/v1/pedidos", [{ name: "creado", status: 201, body: '{"id":"nuevo"}' }]);
    await endpointWith("DELETE", "/v1/pedidos/{id}", []);
    publicId = (await createMock({ name: "el del front", visibility: "public" })).mock.publicId;
  });

  test("contesta el ejemplo **sin ninguna cabecera de autenticación**", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/pedidos/42`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { id: "42", total: 9 });
    assert.equal(answer.headers["x-eq-mock-endpoint"], "GET /v1/pedidos/{id}");
    assert.equal(answer.headers["x-eq-mock-example"], "el bueno");
  });

  test("reenvía las cabeceras del ejemplo y no las que romperían al cliente", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/pedidos/42`);
    assert.equal(answer.headers["x-total"], "7");
    // Heredar `gzip` sobre un cuerpo descomprimido hace fallar a todos los clientes, y una
    // `content-length` vieja desincroniza la respuesta.
    assert.equal(answer.headers["content-encoding"], undefined);
    assert.notEqual(answer.headers["content-length"], "99999");
  });

  test("no lleva dentro la credencial que traía el ejemplo", async () => {
    // La redacción es de la ola de los ejemplos, pero es aquí donde importa: el mock es lo que hace
    // público lo guardado, y un token dentro saldría por una URL que cualquiera puede llamar.
    const answer = await api().get(`/mock/${publicId}/v1/pedidos/42`);
    assert.equal(JSON.stringify(answer.headers).includes("TOKEN-EN-CLARO"), false);
    assert.equal(answer.text.includes("TOKEN-EN-CLARO"), false);
  });

  test("se puede pedir el camino de error sin tocar el mock", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/pedidos/42`).set("x-eq-mock-status", "404");
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.body, { error: "no existe" });
    assert.equal(answer.headers["x-eq-mock-reason"], "by-status");
  });

  test("la cabecera de Postman vale igual, para traerse sus pruebas sin reescribirlas", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/pedidos/42`).set("x-mock-response-name", "el que no está");
    assert.equal(answer.status, 404);
  });

  test("la cadena de consulta elige entre dos ejemplos de la misma ruta", async () => {
    const dos = await api().get(`/mock/${publicId}/v1/pedidos?page=2`);
    assert.deepEqual(dos.body, { page: 2 });
    assert.equal(dos.headers["x-eq-mock-reason"], "request-match");
    const una = await api().get(`/mock/${publicId}/v1/pedidos?page=1`);
    assert.deepEqual(una.body, { page: 1 });
  });

  test("el nombre del ejemplo sale codificado: una cabecera HTTP no lleva UTF-8", async () => {
    // Node escribe los bytes y el cliente los lee como latin-1, así que «página» tal cual llega
    // partido. Y un nombre de ejemplo con tilde es lo normal, no el caso raro.
    const answer = await api().get(`/mock/${publicId}/v1/pedidos?page=1`);
    assert.equal(answer.headers["x-eq-mock-example"], "p%C3%A1gina 1");
    // El motivo es un código y no una frase, por lo mismo y porque así se puede buscar.
    assert.equal(answer.headers["x-eq-mock-reason"], "request-match");
  });

  test("el método decide, y el mismo camino con otro método es otro endpoint", async () => {
    const creado = await api().post(`/mock/${publicId}/v1/pedidos`).send({ total: 1 });
    assert.equal(creado.status, 201);
    assert.deepEqual(creado.body, { id: "nuevo" });
  });

  test("la ruta que no está es un 404 que dice a qué se parece", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/pedido/42`);
    assert.equal(answer.status, 404);
    assert.equal(answer.headers["content-type"]?.startsWith("application/problem+json"), true);
    assert.equal(answer.body.type, "https://endpoint-quality.dev/problems/mock-no-route");
    assert.match(answer.body.detail, /GET \/v1\/pedidos\/\{id\}/);
  });

  test("el método equivocado es un 405 con Allow, y no un 404", async () => {
    const answer = await api().put(`/mock/${publicId}/v1/pedidos/42`).send({});
    assert.equal(answer.status, 405);
    assert.equal(answer.headers.allow, "DELETE, GET, HEAD");
  });

  test("la ruta declarada sin ejemplos es un 501 que dice cómo se arregla", async () => {
    const answer = await api().delete(`/mock/${publicId}/v1/pedidos/42`);
    assert.equal(answer.status, 501);
    assert.equal(answer.body.type, "https://endpoint-quality.dev/problems/mock-no-example");
    assert.match(answer.body.detail, /guarda la respuesta/);
  });

  test("un HEAD trae las cabeceras del GET y ningún cuerpo", async () => {
    const answer = await api().head(`/mock/${publicId}/v1/pedidos/42`);
    assert.equal(answer.status, 200);
    // Las cabeceras del recurso sí, que es para lo que se pide un HEAD.
    assert.equal(answer.headers["x-total"], "7");
    assert.equal(answer.headers["x-eq-mock-example"], "el bueno");
    assert.ok(!answer.text);
  });

  test("una cabecera del ejemplo con un salto de línea no puede partir la respuesta en dos", async () => {
    // El valor lo grabó otro servidor o lo trajo un HAR, y acaba en una respuesta que lee un
    // navegador: es una inyección de cabeceras esperando a pasar. La primera puerta es la validación
    // del ejemplo, que no deja entrar el salto de línea; el saneado del que sirve es la segunda.
    const created = await api()
      .post(`${base()}/endpoints`)
      .set(as(owner))
      .send({ method: "GET", path: "/v1/inyeccion" });
    const saved = await api()
      .post(`${base()}/endpoints/${created.body.id}/examples`)
      .set(as(owner))
      .send({
        name: "con salto",
        request: {
          method: "GET",
          url: "https://x.test/v1/inyeccion",
          headers: [],
          body: { text: "", contentType: "" },
        },
        response: {
          status: 200,
          headers: [{ name: "X-Malo", value: "a\r\nX-Inyectada: si", enabled: true }],
          body: "{}",
          contentType: "application/json",
          durationMs: 1,
        },
      });

    assert.equal(saved.status, 422, JSON.stringify(saved.body));
    assert.ok(
      saved.body.errors.some((error: { field: string }) => error.field === "response.headers.0"),
      JSON.stringify(saved.body.errors),
    );
  });

  test("abre CORS a cualquier origen y sin credenciales, que es la única combinación legal con «*»", async () => {
    // Un mock se consume desde un front en un puerto que cambia cada día: la lista de orígenes de
    // la API lo rompería en la primera hora.
    const answer = await api().get(`/mock/${publicId}/v1/pedidos/42`).set("Origin", "http://localhost:5173");
    assert.equal(answer.headers["access-control-allow-origin"], "*");
    assert.equal(answer.headers["cache-control"], "no-store");
    // La ausencia de `allow-credentials` aquí es **débil**: esta aplicación de prueba no monta el
    // CORS global, que es justo quien la escribe. Con `*` delante es la combinación que el navegador
    // rechaza de plano, y por eso el que sirve la quita en el último momento. Comprobado contra la
    // pila desplegada, que sí lleva el CORS global y nginx delante.
    assert.equal(answer.headers["access-control-allow-credentials"], undefined);
  });

  test("el preflight del navegador se contesta sin llegar al motor", async () => {
    const answer = await api()
      .options(`/mock/${publicId}/v1/pedidos/42`)
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "GET");
    assert.equal(answer.status, 204);
    assert.equal(answer.headers["access-control-allow-origin"], "*");
  });

  test("un OPTIONS que no es preflight sí llega al motor, y contesta lo que le toque", async () => {
    // Lo que los separa es `Access-Control-Request-Method`. Un proyecto puede declarar su propio
    // `OPTIONS`, y contestarle 204 en seco sería servir otra cosa.
    const answer = await api().options(`/mock/${publicId}/v1/pedidos/42`);
    assert.equal(answer.status, 405);
  });

  test("el retardo configurado se espera de verdad", async () => {
    // Una latencia constante no reproduce el fallo que se busca, pero un retardo que no se aplica no
    // reproduce ninguno: es la única forma de comprobar que el número sirve para algo.
    const lento = await createMock({ name: "con retardo", visibility: "public", delay: { kind: "fixed", ms: 250 } });
    const started = Date.now();
    const answer = await api().get(`/mock/${lento.mock.publicId}/v1/pedidos/42`);
    const elapsed = Date.now() - started;
    assert.equal(answer.status, 200);
    assert.ok(elapsed >= 240, `contestó en ${elapsed} ms, sin esperar los 250`);
  });

  test("un publicId que no existe no dice si existió: sería un oráculo para adivinar URLs", async () => {
    const answer = await api().get("/mock/noexiste/v1/pedidos/42");
    assert.equal(answer.status, 404);
    assert.equal(answer.body.type, "https://endpoint-quality.dev/problems/mock-not-found");
  });
});

describe("un mock privado", () => {
  let publicId: string;
  let apiKey: string;

  before(async () => {
    await endpointWith("GET", "/v1/secreto", [{ name: "ok", status: 200, body: '{"ok":true}' }]);
    const created = await createMock({ name: "privado de verdad", visibility: "private" });
    publicId = created.mock.publicId;
    apiKey = created.apiKey!;
  });

  test("sin clave no contesta", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/secreto`);
    assert.equal(answer.status, 401);
    assert.equal(answer.body.type, "https://endpoint-quality.dev/problems/mock-key-invalid");
  });

  test("con la clave equivocada tampoco", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/secreto`).set("x-api-key", `${apiKey}x`);
    assert.equal(answer.status, 401);
  });

  test("con la suya sí", async () => {
    const answer = await api().get(`/mock/${publicId}/v1/secreto`).set("x-api-key", apiKey);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true });
  });

  test("rotar la clave deja fuera a la vieja en el mismo momento", async () => {
    const list = await api().get(`${base()}/mocks`).set(as(owner));
    const mockId = list.body.mocks.find((mock: { publicId: string }) => mock.publicId === publicId).id;
    const rotated = await api().post(`${base()}/mocks/${mockId}/key`).set(as(owner)).send({});
    assert.equal(rotated.status, 201);
    assert.notEqual(rotated.body.apiKey, apiKey);

    assert.equal((await api().get(`/mock/${publicId}/v1/secreto`).set("x-api-key", apiKey)).status, 401);
    assert.equal((await api().get(`/mock/${publicId}/v1/secreto`).set("x-api-key", rotated.body.apiKey)).status, 200);
    apiKey = rotated.body.apiKey;
  });

  test("apagarlo contesta 503 y lo dice, en vez de parecer roto", async () => {
    const list = await api().get(`${base()}/mocks`).set(as(owner));
    const mockId = list.body.mocks.find((mock: { publicId: string }) => mock.publicId === publicId).id;
    assert.equal((await api().patch(`${base()}/mocks/${mockId}`).set(as(owner)).send({ enabled: false })).status, 200);

    const answer = await api().get(`/mock/${publicId}/v1/secreto`).set("x-api-key", apiKey);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.type, "https://endpoint-quality.dev/problems/mock-disabled");

    await api().patch(`${base()}/mocks/${mockId}`).set(as(owner)).send({ enabled: true });
  });

  test("borrarlo deja la URL muerta", async () => {
    const list = await api().get(`${base()}/mocks`).set(as(owner));
    const mockId = list.body.mocks.find((mock: { publicId: string }) => mock.publicId === publicId).id;
    assert.equal((await api().delete(`${base()}/mocks/${mockId}`).set(as(owner))).status, 204);
    const answer = await api().get(`/mock/${publicId}/v1/secreto`).set("x-api-key", apiKey);
    assert.equal(answer.status, 404);
  });
});

/**
 * La bitácora: lo que queda de cada llamada, y **lo que no queda**.
 *
 * Es la única prueba que puede demostrar lo segundo. Las unitarias dicen que la fila que construye
 * el dominio no tiene esas columnas; esta manda una petición de verdad por la ruta pública, con un
 * token en una cabecera y otro en el cuerpo, y comprueba que no aparecen **en ninguna parte** de lo
 * guardado — ni en la fila, ni en el listado, ni de rebote en la ruta. Entre las dos está lo que
 * hace falta para creerse que apuntar un front a un mock no es entregarle sus credenciales.
 */
describe("la bitácora del mock", () => {
  let mockId: string;
  let publicId: string;

  const calls = () => api().get(`${base()}/mocks/${mockId}/calls`).set(as(owner));

  before(async () => {
    await endpointWith("GET", "/v1/bitacora/{id}", [{ name: "el bueno", status: 200, body: '{"id":"7"}' }]);
    await endpointWith("POST", "/v1/bitacora/entrar", [{ name: "entrado", status: 200, body: '{"ok":true}' }]);
    await endpointWith("DELETE", "/v1/bitacora/{id}", []);
    const created = await createMock({ name: "el de la bitácora", visibility: "public" });
    mockId = created.mock.id;
    publicId = created.mock.publicId;
  });

  test("servir el mock deja la llamada registrada, y el listado la enseña", async () => {
    const served = await api().get(`/mock/${publicId}/v1/bitacora/7`);
    assert.equal(served.status, 200);

    const list = await calls();
    assert.equal(list.status, 200);
    assert.equal(list.body.keep, 200);
    const [last] = list.body.calls;
    assert.equal(last.method, "GET");
    assert.equal(last.path, "/v1/bitacora/7");
    assert.equal(last.status, 200);
    assert.equal(last.exampleName, "el bueno");
    assert.equal(last.missCode, "");
    // El reloj de las pruebas está parado, así que la hora es la suya y no la del reloj de verdad.
    assert.equal(last.at, "2026-03-01T10:00:00.000Z");
    assert.equal(typeof last.durationMs, "number");
  });

  test("cada manera de no contestar queda con su código, que es lo que se pregunta al mirarla", async () => {
    await api().get(`/mock/${publicId}/v1/bitacor/7`);
    await api().put(`/mock/${publicId}/v1/bitacora/7`).send({});
    await api().delete(`/mock/${publicId}/v1/bitacora/7`);

    const list = await calls();
    const recent: { status: number; missCode: string; path: string }[] = list.body.calls.slice(0, 3);
    assert.deepEqual(
      recent.map((row) => [row.status, row.missCode]),
      [
        [501, "mock-no-example"],
        [405, "mock-wrong-method"],
        [404, "mock-no-route"],
      ],
    );
    // La ruta que se pidió, que es la mitad de «pediste /v1/bitacor y el mock sirve /v1/bitacora».
    assert.equal(recent[2].path, "/v1/bitacor/7");
  });

  test("ni una cabecera ni un cuerpo con un token acaban en ninguna parte de lo guardado", async () => {
    // La petición que entra al mock es de un tercero: lleva el `Bearer` de un usuario real y, en el
    // cuerpo del login que se está probando, su contraseña. Guardarlas convertiría esta tabla en un
    // almacén de credenciales ajenas alimentado por una ruta que cualquiera puede llamar.
    const secret = "TOKEN-DE-QUIEN-LLAMA";
    const served = await api()
      .post(`/mock/${publicId}/v1/bitacora/entrar?api_key=${secret}-EN-LA-QUERY`)
      .set("Authorization", `Bearer ${secret}-EN-LA-CABECERA`)
      .set("X-Empresa-Token", `${secret}-EN-UNA-CABECERA-RARA`)
      .set("Cookie", `sesion=${secret}-EN-LA-COOKIE`)
      .send({ usuario: "ana@example.test", password: `${secret}-EN-EL-CUERPO` });
    assert.equal(served.status, 200);

    const list = await calls();
    // El listado entero, serializado: si algo de eso estuviera guardado, saldría por aquí.
    assert.equal(JSON.stringify(list.body).includes(secret), false, JSON.stringify(list.body.calls[0]));
    // Y la fila tal cual está en el almacén, sin pasar por la vista: la vista podría estar tapándolo.
    const stored = [...context.repositories.mocks.calls.values()];
    assert.equal(JSON.stringify(stored).includes(secret), false);
    // La cadena de consulta no está ni redactada: `?token=` sigue siendo la forma más vieja de
    // mandar una credencial, y los nombres de los parámetros no valen lo que cuesta el riesgo.
    assert.equal(list.body.calls[0].path, "/v1/bitacora/entrar");
  });

  test("un fallo al guardar no rompe la respuesta del mock", async () => {
    // Un mock que se cae porque su bitácora se cayó es peor que un mock sin bitácora, y esta ruta
    // recibe tráfico de verdad: la escritura va después de la respuesta y dentro de un `try`.
    const repository = context.repositories.mocks;
    const original = repository.saveCall.bind(repository);
    repository.saveCall = async () => {
      throw new Error("la base de datos se ha ido");
    };
    try {
      const served = await api().get(`/mock/${publicId}/v1/bitacora/7`);
      assert.equal(served.status, 200);
      assert.deepEqual(served.body, { id: "7" });
      assert.equal(served.headers["x-eq-mock-example"], "el bueno");
    } finally {
      repository.saveCall = original;
    }
  });

  test("la bitácora no es pública, aunque la URL que la llena lo sea", async () => {
    // Que cualquiera pueda llamar a un mock no significa que cualquiera pueda ver qué le pidieron.
    assert.equal((await api().get(`${base()}/mocks/${mockId}/calls`)).status, 401);
  });

  test("desde otra organización es un 403, y no un 404 que diga que no existe", async () => {
    const other = await signUp(`mocks-bitacora-${Date.now()}@example.test`);
    assert.equal((await api().get(`${base()}/mocks/${mockId}/calls`).set(as(other))).status, 403);
  });

  test("borrar el mock apaga su URL y lo deja restaurable; el definitivo se lleva su bitácora", async () => {
    const created = await createMock({ name: "efímero", visibility: "public" });
    await api().get(`/mock/${created.mock.publicId}/v1/bitacora/7`);
    assert.equal((await api().get(`${base()}/mocks/${created.mock.id}/calls`).set(as(owner))).body.calls.length, 1);

    assert.equal((await api().delete(`${base()}/mocks/${created.mock.id}`).set(as(owner))).status, 204);
    // La URL deja de contestar en el acto: un mock fuera de la lista que siguiera sirviendo sería
    // un mock que nadie mira apuntando al front de alguien.
    assert.equal((await api().get(`/mock/${created.mock.publicId}/v1/bitacora/7`)).status, 404);
    // Y su bitácora sigue: es lo que dice si merece la pena restaurarlo.
    assert.equal(
      [...context.repositories.mocks.calls.values()].some((call) => call.mockServerId === created.mock.id),
      true,
    );
    const trash = await api().get(`${base()}/mocks?state=deleted`).set(as(owner));
    assert.ok(trash.body.mocks.some((mock: { id: string }) => mock.id === created.mock.id));

    // Restaurado con el mismo `publicId`: la URL que ya estaba pegada en un front vuelve a servir.
    const back = await api().post(`${base()}/mocks/${created.mock.id}/restore`).set(as(owner));
    assert.equal(back.status, 201);
    assert.equal(back.body.publicId, created.mock.publicId);
    assert.equal((await api().get(`/mock/${created.mock.publicId}/v1/bitacora/7`)).status, 200);

    // Archivado también apaga la URL, sin perder la configuración.
    const filed = await api()
      .patch(`${base()}/mocks/${created.mock.id}/archived`)
      .set(as(owner))
      .send({ archived: true });
    assert.equal(filed.status, 200);
    assert.ok(filed.body.archivedAt);
    assert.equal((await api().get(`/mock/${created.mock.publicId}/v1/bitacora/7`)).status, 404);
    await api().patch(`${base()}/mocks/${created.mock.id}/archived`).set(as(owner)).send({ archived: false });

    // El definitivo pide que antes esté eliminado, y entonces sí se lleva la bitácora.
    assert.equal((await api().delete(`${base()}/mocks/${created.mock.id}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base()}/mocks/${created.mock.id}`).set(as(owner));
    assert.equal((await api().delete(`${base()}/mocks/${created.mock.id}?purge=true`).set(as(owner))).status, 204);
    assert.equal(
      [...context.repositories.mocks.calls.values()].some((call) => call.mockServerId === created.mock.id),
      false,
    );
  });
});

describe("el mock es de su proyecto y de nadie más", () => {
  test("la URL de un mock solo sirve los endpoints de su propio proyecto", async () => {
    // El `publicId` se resuelve sin saber de quién es, así que esto es lo único que separa los datos
    // de dos inquilinos en esta ruta.
    const other = await signUp(`mocks-otro-${Date.now()}@example.test`);
    const otherProject = await api()
      .post(`/orgs/${other.organizationId}/projects`)
      .set(as(other))
      .send({ name: "Ajeno" });
    const otherBase = `/orgs/${other.organizationId}/projects/${otherProject.body.projectId}`;
    const created = await api()
      .post(`${otherBase}/endpoints`)
      .set(as(other))
      .send({ method: "GET", path: "/v1/ajeno" });
    await api()
      .post(`${otherBase}/endpoints/${created.body.id}/examples`)
      .set(as(other))
      .send({
        name: "ajeno",
        request: { method: "GET", url: "https://x.test/v1/ajeno", headers: [], body: { text: "", contentType: "" } },
        response: {
          status: 200,
          headers: [],
          body: '{"ajeno":true}',
          contentType: "application/json",
          durationMs: 1,
        },
      });
    const mine = await createMock({ name: "el mío", visibility: "public" });

    const answer = await api().get(`/mock/${mine.mock.publicId}/v1/ajeno`);
    assert.equal(answer.status, 404);
    assert.equal(answer.body.type, "https://endpoint-quality.dev/problems/mock-no-route");
  });

  test("crear un mock en un proyecto ajeno no se puede", async () => {
    const other = await signUp(`mocks-fuera-${Date.now()}@example.test`);
    const answer = await api().post(`${base()}/mocks`).set(as(other)).send({ name: "no", visibility: "public" });
    assert.ok(answer.status === 403 || answer.status === 404, `respondió ${answer.status}`);
  });
});
