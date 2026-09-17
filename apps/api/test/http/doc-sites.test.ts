/**
 * La documentación publicada, por HTTP: publicarla, y que su URL se lea **sin sesión**.
 *
 * Lo que estas pruebas demuestran y las unitarias no pueden: que la ruta pública está de verdad
 * abierta y **solo hasta donde tiene que estarlo**. La proyección puede ser perfecta y un `@Public()`
 * mal puesto o un `publicId` que se resuelve sin comprobar la clave dejan la API de alguien a la
 * vista, con el dominio en verde.
 *
 * Así que aquí se llama a la URL **sin ninguna cabecera de autenticación** y se comprueba lo que
 * contesta; y a la privada sin clave, con una equivocada y con la suya. Y se comprueba lo que un
 * volcado de la respuesta **no** lleva dentro: el token del endpoint, sus scripts, y —salvo que se
 * diga— los cuerpos de ejemplo.
 */
import { after, afterEach, before, describe, test } from "node:test";
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

/**
 * Un endpoint con todo lo que **no** se puede publicar puesto: un token en la autenticación, otro en
 * una cabecera escrita a mano, una contraseña en el cuerpo y dos scripts.
 */
async function loadedEndpoint(): Promise<string> {
  const created = await api()
    .post(`${base()}/endpoints`)
    .set(as(owner))
    .send({
      method: "POST",
      path: "/v1/pedidos",
      description: "Crea un pedido",
      tags: ["Pedidos"],
      auth: { type: "bearer", params: { token: "TOKEN-DEL-ENDPOINT" } },
      headers: [
        { name: "Authorization", value: "Bearer OTRO-TOKEN-EN-CABECERA", enabled: true },
        { name: "Accept", value: "application/json", enabled: true },
        { name: "X-Debug", value: "APAGADA", enabled: false },
      ],
      query: [
        { name: "dry", type: "boolean", required: false, description: "No guarda", value: "false", enabled: true },
      ],
      body: {
        mode: "json",
        text: '{"cliente":"Ana","password":"hunter2"}',
        contentType: "application/json",
        fields: [],
      },
      preRequestScript: 'pm.environment.set("token", "SCRIPT-SECRETO")',
      postResponseScript: 'pm.test("ok", () => {})',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const endpointId: string = created.body.id;

  const example = await api()
    .post(`${base()}/endpoints/${endpointId}/examples`)
    .set(as(owner))
    .send({
      name: "201 creado",
      request: {
        method: "POST",
        url: "https://api.ejemplo.com/v1/pedidos",
        headers: [{ name: "Authorization", value: "Bearer TOKEN-DE-LA-PETICION", enabled: true }],
        body: { text: "{}", contentType: "application/json" },
      },
      response: {
        status: 201,
        headers: [
          { name: "Content-Type", value: "application/json", enabled: true },
          { name: "Set-Cookie", value: "session=GALLETA-SECRETA; HttpOnly", enabled: true },
        ],
        body: '{"id":"42","cliente":"Ana"}',
        contentType: "application/json",
        durationMs: 18,
      },
    });
  assert.equal(example.status, 201, JSON.stringify(example.body));
  return endpointId;
}

type IssuedSite = {
  site: { id: string; publicId: string; apiKeyPreview: string; includeExamples: boolean; baseUrl: string };
  apiKey: string | null;
};

async function publish(patch: Record<string, unknown>): Promise<IssuedSite> {
  const created = await api().post(`${base()}/doc-sites`).set(as(owner)).send(patch);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body as IssuedSite;
}

/** La lectura pública: sin ninguna cabecera de sesión, que es de lo que va todo este fichero. */
const read = (publicId: string, key?: string) => {
  const call = api().get(`/shared/docs/${publicId}`);
  return key ? call.set("x-api-key", key) : call;
};

before(async () => {
  context = await createTestApp();
  owner = await signUp(`docs-${Date.now()}@example.test`);
  const project = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: "Pedidos", description: "La API de pedidos" });
  assert.equal(project.status, 201);
  projectId = project.body.projectId;
  await loadedEndpoint();
});

after(async () => {
  await context?.close();
});

/**
 * Cada prueba publica lo suyo y lo retira.
 *
 * No es aseo: el proyecto acepta cinco documentaciones y ni una más, porque cada una es una URL
 * pública viva. Dejarlas acumuladas haría que la sexta prueba fallara con un 409 y que el fallo
 * pareciera de la prueba en vez del límite que se quiso.
 */
afterEach(async () => {
  const list = await api().get(`${base()}/doc-sites`).set(as(owner));
  for (const site of (list.body.sites ?? []) as { id: string }[]) {
    await api().delete(`${base()}/doc-sites/${site.id}`).set(as(owner));
  }
});

describe("publicar", () => {
  test("hay que decir si es pública o privada: no hay valor por defecto", async () => {
    const sin = await api().post(`${base()}/doc-sites`).set(as(owner)).send({ name: "sin decidir" });
    assert.equal(sin.status, 422);
  });

  test("los ejemplos empiezan apagados: publicar la forma de la API no es publicar sus datos", async () => {
    const issued = await publish({ name: "sin ejemplos por defecto", visibility: "public" });
    assert.equal(issued.site.includeExamples, false);
  });

  test("una URL base con una variable no vale: esta página no tiene entorno que resolverla", async () => {
    const malo = await api()
      .post(`${base()}/doc-sites`)
      .set(as(owner))
      .send({ name: "con variable", visibility: "public", baseUrl: "{{baseUrl}}" });
    assert.equal(malo.status, 422);
    assert.equal(malo.body.errors[0].field, "baseUrl");
  });

  test("la barra final se normaliza, o la mitad de las URLs saldrían con dos", async () => {
    const issued = await publish({
      name: "con barra",
      visibility: "public",
      baseUrl: "https://api.ejemplo.com/",
    });
    assert.equal(issued.site.baseUrl, "https://api.ejemplo.com");
  });

  test("una privada devuelve su clave una vez, y de ella solo queda el resumen", async () => {
    const issued = await publish({ name: "privada", visibility: "private" });
    assert.ok(issued.apiKey && issued.apiKey.length >= 32);
    assert.match(issued.site.apiKeyPreview, /…/);

    const list = await api().get(`${base()}/doc-sites`).set(as(owner));
    const row = list.body.sites.find((site: { id: string }) => site.id === issued.site.id);
    assert.equal(row.apiKey, undefined);
    assert.equal(row.apiKeyHash, undefined);
  });

  test("la lista dice cuántas rutas tienen descripción y cuántas tienen ejemplo", async () => {
    const list = await api().get(`${base()}/doc-sites`).set(as(owner));
    assert.equal(list.status, 200);
    // Es la cifra que dice si la página va a documentar algo o a ser una lista de paths, y sale
    // antes de mandarle el enlace a nadie.
    assert.deepEqual(list.body.coverage, { endpoints: 1, described: 1, withExamples: 1 });
    // El prefijo lo decide el servidor, no la pantalla.
    assert.equal(list.body.prefix, "/docs");
  });
});

describe("la URL pública", () => {
  test("contesta sin ninguna cabecera de autenticación", async () => {
    const issued = await publish({
      name: "abierta",
      visibility: "public",
      baseUrl: "https://api.ejemplo.com",
      intro: "Pide una clave a plataforma.",
    });
    const page = await read(issued.site.publicId);
    assert.equal(page.status, 200);
    assert.equal(page.body.title, "Pedidos");
    assert.equal(page.body.description, "La API de pedidos");
    assert.equal(page.body.intro, "Pide una clave a plataforma.");
    assert.equal(page.body.groups[0].tag, "Pedidos");
    assert.equal(page.body.groups[0].endpoints[0].url, "https://api.ejemplo.com/v1/pedidos");
  });

  test("y no lleva dentro ni el token del endpoint, ni sus scripts, ni la contraseña del cuerpo", async () => {
    const issued = await publish({ name: "sin secretos", visibility: "public" });
    const page = await read(issued.site.publicId);
    const published = JSON.stringify(page.body);

    // Lo que un endpoint guarda para poder *enviarse*, y que no documenta nada:
    assert.ok(!published.includes("TOKEN-DEL-ENDPOINT"), "el token de la autenticación ha salido");
    assert.ok(!published.includes("OTRO-TOKEN-EN-CABECERA"), "el token de la cabecera ha salido");
    assert.ok(!published.includes("SCRIPT-SECRETO"), "un script ha salido");
    assert.ok(!published.includes("pm.test"), "un script ha salido");
    assert.ok(!published.includes("hunter2"), "la contraseña del cuerpo ha salido");
    assert.ok(!published.includes("APAGADA"), "una fila apagada ha salido");

    // Y lo que sí: que hay que mandar un Bearer, y el resto del cuerpo.
    const endpoint = page.body.groups[0].endpoints[0];
    assert.equal(endpoint.auth.type, "bearer");
    assert.deepEqual(
      endpoint.headers.map((header: { name: string; masked: boolean }) => [header.name, header.masked]),
      [
        ["Authorization", true],
        ["Accept", false],
      ],
    );
    assert.ok(endpoint.body.text.includes("Ana"));
    assert.deepEqual(endpoint.body.masked, ["password"]);
  });

  test("sin encender los ejemplos no sale ningún cuerpo de respuesta", async () => {
    const issued = await publish({ name: "forma sí, datos no", visibility: "public" });
    const page = await read(issued.site.publicId);
    assert.deepEqual(page.body.groups[0].endpoints[0].examples, []);
    assert.equal(page.body.counts.examples, 0);
  });

  test("encendidos, salen los ejemplos y la galleta de la respuesta va tapada", async () => {
    const issued = await publish({ name: "con ejemplos", visibility: "public", includeExamples: true });
    const page = await read(issued.site.publicId);
    const example = page.body.groups[0].endpoints[0].examples[0];
    assert.equal(example.status, 201);
    // Parseado y no comparado como texto: al guardarlo, la redacción reescribe el JSON, y lo que
    // documenta es el contenido y no cómo quedaron los espacios.
    assert.deepEqual(JSON.parse(example.body), { id: "42", cliente: "Ana" });
    // Aquí se ven **las dos puertas** de la ola 4 y de esta. El `Set-Cookie` que mandé al guardar el
    // ejemplo no llegó ni a la tabla: la redacción lo tiró entonces, así que la página no puede
    // publicarlo ni queriendo. La segunda puerta —tapar el valor de una cabecera que es credencial—
    // se prueba en `doc-page.test.ts`, y existe porque el importador también escribe ejemplos.
    assert.ok(!JSON.stringify(page.body).includes("GALLETA-SECRETA"));
    assert.deepEqual(
      example.headers.map((header: { name: string; masked: boolean }) => [header.name, header.masked]),
      [["Content-Type", false]],
    );
  });

  test("lleva «noindex»: si un buscador la indexa, deja de hacer falta adivinar la URL", async () => {
    const issued = await publish({ name: "no indexable", visibility: "public" });
    const page = await read(issued.site.publicId);
    assert.equal(page.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(page.headers["cache-control"], "no-store");
  });

  test("una privada: sin clave 401, con una equivocada 401, con la suya 200", async () => {
    const issued = await publish({ name: "privada de verdad", visibility: "private" });
    assert.ok(issued.apiKey);

    const sin = await read(issued.site.publicId);
    assert.equal(sin.status, 401);
    assert.match(sin.body.type, /doc-site-key-invalid$/);

    const mala = await read(issued.site.publicId, "no-es-la-clave");
    assert.equal(mala.status, 401);

    const buena = await read(issued.site.publicId, issued.apiKey!);
    assert.equal(buena.status, 200);
    assert.equal(buena.body.title, "Pedidos");
  });

  test("rotar la clave invalida la vieja en el mismo momento", async () => {
    const issued = await publish({ name: "para rotar", visibility: "private" });
    const rotated = await api().post(`${base()}/doc-sites/${issued.site.id}/key`).set(as(owner)).send({});
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));

    assert.equal((await read(issued.site.publicId, issued.apiKey!)).status, 401);
    assert.equal((await read(issued.site.publicId, rotated.body.apiKey)).status, 200);
  });

  test("una pública no tiene clave que rotar, y se dice en vez de generar una que no pide nadie", async () => {
    const issued = await publish({ name: "pública sin clave", visibility: "public" });
    const rotated = await api().post(`${base()}/doc-sites/${issued.site.id}/key`).set(as(owner)).send({});
    assert.equal(rotated.status, 409);
    assert.match(rotated.body.type, /doc-site-not-private$/);
  });

  test("despublicada deja de contestar, y su configuración sigue ahí para volver a encenderla", async () => {
    const issued = await publish({ name: "para apagar", visibility: "public" });
    assert.equal((await read(issued.site.publicId)).status, 200);

    const off = await api().patch(`${base()}/doc-sites/${issued.site.id}`).set(as(owner)).send({ enabled: false });
    assert.equal(off.status, 200);
    const apagada = await read(issued.site.publicId);
    assert.equal(apagada.status, 404);
    assert.match(apagada.body.type, /doc-site-disabled$/);

    const on = await api().patch(`${base()}/doc-sites/${issued.site.id}`).set(as(owner)).send({ enabled: true });
    assert.equal(on.status, 200);
    assert.equal((await read(issued.site.publicId)).status, 200);
  });

  test("borrada, la URL deja de contestar y no dice que existió", async () => {
    const issued = await publish({ name: "para borrar", visibility: "public" });
    const gone = await api().delete(`${base()}/doc-sites/${issued.site.id}`).set(as(owner));
    assert.equal(gone.status, 204);

    const muerta = await read(issued.site.publicId);
    assert.equal(muerta.status, 404);
    // La misma respuesta que un `publicId` que nunca existió: distinguirlos convertiría la ruta en
    // un oráculo para adivinar URLs.
    const inventada = await read("AAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(inventada.status, 404);
    assert.equal(muerta.body.type, inventada.body.type);
  });

  test("pasar a privada una pública pide clave desde ese momento", async () => {
    const issued = await publish({ name: "pública que se cierra", visibility: "public" });
    assert.equal((await read(issued.site.publicId)).status, 200);

    const closed = await api()
      .patch(`${base()}/doc-sites/${issued.site.id}`)
      .set(as(owner))
      .send({ visibility: "private" });
    assert.equal(closed.status, 200);
    // Nunca tuvo clave, así que ha habido que crear una: sale aquí, la única vez que se puede ver.
    assert.ok(closed.body.apiKey);

    assert.equal((await read(issued.site.publicId)).status, 401);
    assert.equal((await read(issued.site.publicId, closed.body.apiKey)).status, 200);
  });
});

describe("el aislamiento entre proyectos", () => {
  test("la URL de un proyecto no enseña los endpoints de otro", async () => {
    const otro = await signUp(`docs-otro-${Date.now()}@example.test`);
    const suyo = await api().post(`/orgs/${otro.organizationId}/projects`).set(as(otro)).send({ name: "Suyo" });
    assert.equal(suyo.status, 201);
    const suProyecto = suyo.body.projectId;
    await api()
      .post(`/orgs/${otro.organizationId}/projects/${suProyecto}/endpoints`)
      .set(as(otro))
      .send({ method: "GET", path: "/v1/solo-suyo" });

    const issued = await publish({ name: "la mía", visibility: "public" });
    const page = await read(issued.site.publicId);
    assert.equal(page.status, 200);
    assert.ok(!JSON.stringify(page.body).includes("solo-suyo"));

    // Y su documentación no se puede tocar desde mi organización.
    const ajena = await api().get(`/orgs/${owner.organizationId}/projects/${suProyecto}/doc-sites`).set(as(owner));
    assert.equal(ajena.status, 404);
  });
});
