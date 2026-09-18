/**
 * The endpoints of a project, through the API: writing them, importing them, the contract adding its
 * own, and «Send» against a real server on loopback.
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

/** Answers every request with what it received. */
let echo: Server;
let origin: string;

let owner: Actor;
let outsider: Actor;
let projectId: string;
let environmentId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

before(async () => {
  echo = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      // Un login como los de verdad: 302 a otra ruta y **dos** cabeceras `Set-Cookie`, una de
      // ellas con una fecha que lleva una coma dentro. Las dos cosas juntas son lo que rompe un
      // cliente que no sigue la redirección de un POST o que lee las cookies como una sola cadena.
      if (incoming.url?.startsWith("/entrar")) {
        response.writeHead(302, {
          location: "/tras-entrar",
          "set-cookie": [
            "session=s3cr3t0; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; HttpOnly",
            "tema=oscuro; Path=/",
            // Para otro dominio: el servidor la manda y el tarro tiene que rechazarla.
            "ajena=1; Domain=otro.example.com; Path=/",
          ],
        });
        response.end();
        return;
      }
      response.writeHead(incoming.url?.startsWith("/missing") ? 404 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: incoming.method,
          url: incoming.url,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("endpoints@example.com");
  outsider = await signUp("endpoints-ajeno@example.com");

  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({
      name: "Tienda",
      baseUrl: origin,
      auth: { type: "api_key", headerName: "X-Api-Key", apiKey: "clave-del-proyecto" },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  projectId = created.body.projectId;

  const environment = await api()
    .post(`${base()}/environments`)
    .set(as(owner))
    .send({
      name: "local",
      baseUrl: origin,
      writesAllowed: false,
      variables: {
        userId: { initial: "42", current: "", sensitive: false },
        token: { initial: "tok-secreto", current: "", sensitive: true },
      },
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  const list = await api().get(`${base()}/environments`).set(as(owner));
  environmentId = list.body[0].id;
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

describe("escribir endpoints", () => {
  let endpointId: string;

  test("crear normaliza la ruta y deriva sus parámetros", async () => {
    const response = await api()
      .post(`${base()}/endpoints`)
      .set(as(owner))
      .send({ method: "GET", path: "/users/:id", description: "Un usuario", tags: ["users"] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    endpointId = response.body.id;
    assert.equal(response.body.path, "/users/{id}");
    assert.deepEqual(response.body.pathParameters, [{ name: "id", type: "string", description: "", value: "" }]);
    assert.equal(response.body.origin, "manual");
    assert.equal(response.body.status, "active");
    assert.equal(response.body.inContract, null);
  });

  test("el mismo método y ruta dos veces es 409, y una ruta sin / es 422 con el campo", async () => {
    const duplicate = await api()
      .post(`${base()}/endpoints`)
      .set(as(owner))
      .send({ method: "GET", path: "/users/{id}" });
    assert.equal(duplicate.status, 409);
    const invalid = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "GET", path: "users" });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.body.errors.some((error: { field: string }) => error.field === "path"));
  });

  test("editar guarda lo que el analizador perdía: tipo de cuerpo, filas apagadas y valores", async () => {
    const response = await api()
      .patch(`${base()}/endpoints/${endpointId}`)
      .set(as(owner))
      .send({
        pathParameters: [{ name: "id", type: "string", description: "", value: "{{userId}}" }],
        query: [{ name: "expand", type: "string", required: false, description: "", value: "roles", enabled: false }],
        body: { mode: "raw", text: "<x/>", contentType: "application/xml", fields: [] },
      });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const read = await api().get(`${base()}/endpoints/${endpointId}`).set(as(owner));
    assert.equal(read.body.pathParameters[0].value, "{{userId}}");
    assert.equal(read.body.query[0].enabled, false);
    assert.deepEqual(read.body.body, { mode: "raw", text: "<x/>", contentType: "application/xml", fields: [] });
  });

  test("una contraseña escrita a mano en la autenticación no se guarda; una {{variable}} sí", async () => {
    const response = await api()
      .patch(`${base()}/endpoints/${endpointId}`)
      .set(as(owner))
      .send({ auth: { type: "basic", params: { username: "ana", password: "hunter2-literal" } } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const read = await api().get(`${base()}/endpoints/${endpointId}`).set(as(owner));
    assert.equal(JSON.stringify(read.body).includes("hunter2-literal"), false);
    assert.deepEqual(read.body.auth, { type: "basic", params: { username: "ana", password: "" } });

    await api()
      .patch(`${base()}/endpoints/${endpointId}`)
      .set(as(owner))
      .send({ auth: { type: "basic", params: { username: "ana", password: "{{clave}}" } } });
    const kept = await api().get(`${base()}/endpoints/${endpointId}`).set(as(owner));
    assert.equal(kept.body.auth.params.password, "{{clave}}");
  });

  test("listar filtra por estado y búsqueda, y cuenta por estado", async () => {
    const extra = await api()
      .post(`${base()}/endpoints`)
      .set(as(owner))
      .send({ method: "DELETE", path: "/users/{id}" });
    await api()
      .post(`${base()}/endpoints`)
      .set(as(owner))
      .send({ method: "GET", path: "/orders", description: "Pedidos" });

    const archived = await api()
      .patch(`${base()}/endpoints/bulk-status`)
      .set(as(owner))
      .send({ ids: [extra.body.id], status: "archived" });
    assert.deepEqual(archived.body, { updated: 1 });

    const active = await api().get(`${base()}/endpoints`).set(as(owner));
    assert.equal(active.body.meta.total, 2);
    assert.deepEqual(active.body.counts, { active: 2, archived: 1, inactive: 0 });

    const all = await api().get(`${base()}/endpoints?status=all&search=pedid`).set(as(owner));
    assert.deepEqual(
      all.body.data.map((row: { path: string }) => row.path),
      ["/orders"],
    );

    const bad = await api().get(`${base()}/endpoints?status=deleted`).set(as(owner));
    assert.equal(bad.status, 422);
  });

  test("borrar lo quita de todo y deja crear otro igual", async () => {
    const created = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "PATCH", path: "/tmp" });
    const removed = await api().delete(`${base()}/endpoints/${created.body.id}`).set(as(owner));
    assert.equal(removed.status, 204);
    assert.equal((await api().get(`${base()}/endpoints/${created.body.id}`).set(as(owner))).status, 404);
    assert.equal((await api().delete(`${base()}/endpoints/${created.body.id}`).set(as(owner))).status, 404);
    const again = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "PATCH", path: "/tmp" });
    assert.equal(again.status, 201);
    const bulk = await api()
      .post(`${base()}/endpoints/bulk-delete`)
      .set(as(owner))
      .send({ ids: [again.body.id] });
    assert.deepEqual(bulk.body, { deleted: 1 });
  });

  test("otra organización no ve nada", async () => {
    const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/endpoints`).set(as(outsider));
    assert.equal(response.status, 403);
  });
});

describe("importar", () => {
  test("un markdown con curls crea endpoints y dice cuáles ya estaban", async () => {
    const markdown = [
      "```bash",
      `curl ${origin}/users/3fa85f64-5717-4562-b3fc-2c963f66afa6 -H 'Authorization: Bearer x'`,
      "```",
      `curl -X POST ${origin}/carts -H 'Content-Type: application/json' -d '{"sku":"A"}'`,
      `curl -X POST ${origin}/carts -d '{"sku":"B"}'`,
    ].join("\n");
    const response = await api()
      .post(`${base()}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from(markdown), "curls.md");
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.format, "markdown");
    assert.deepEqual(
      response.body.imported.map((row: { method: string; path: string }) => `${row.method} ${row.path}`),
      ["POST /carts"],
    );
    assert.deepEqual(
      response.body.skipped.map((row: { reason: string }) => row.reason),
      ["El proyecto ya tiene este endpoint", "Repetido en el fichero"],
    );
  });

  test("un fichero que no es de ningún formato conocido es 422, y sin fichero también", async () => {
    const unknown = await api()
      .post(`${base()}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from("{}"), "x.json");
    assert.equal(unknown.status, 422);
    const missing = await api().post(`${base()}/endpoints/import/file`).set(as(owner)).field("x", "1");
    assert.equal(missing.status, 422);
  });

  test("un cURL suelto", async () => {
    const response = await api()
      .post(`${base()}/endpoints/import/curl`)
      .set(as(owner))
      .send({ curl: `curl '${origin}/products?page=2' -H 'X-Api-Key: k'` });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.path, "/products");
    assert.equal(response.body.origin, "import");
    assert.equal(response.body.requiresAuth, true);
    assert.deepEqual(
      response.body.query.map((row: { name: string; value: string }) => [row.name, row.value]),
      [["page", "2"]],
    );
  });
});

describe("el contrato", () => {
  test("importarlo crea sus endpoints y enlaza los que ya existían", async () => {
    const spec = `
openapi: 3.1.0
info: { title: Tienda, version: "1.0.0" }
paths:
  /orders:
    get: { operationId: listOrders, tags: [Orders], responses: { "200": {} } }
  /orders/{orderId}:
    get: { operationId: getOrder, responses: { "200": {} } }
`;
    const imported = await api()
      .post(`${base()}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: spec } });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));

    // The sync is an event handler: it runs after the import answered.
    let rows: { path: string; origin: string; operationId: string | null; inContract: boolean | null }[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      rows = (await api().get(`${base()}/endpoints?status=all&limit=500`).set(as(owner))).body.data;
      if (rows.some((row) => row.path === "/orders/{orderId}")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const byPath = (path: string) => rows.find((row) => row.path === path)!;
    assert.equal(byPath("/orders/{orderId}").origin, "contract");
    assert.equal(byPath("/orders/{orderId}").operationId, "getOrder");
    // Written by hand earlier: linked, not duplicated, not rewritten.
    assert.equal(rows.filter((row) => row.path === "/orders").length, 1);
    assert.equal(byPath("/orders").origin, "manual");
    assert.equal(byPath("/orders").operationId, "listOrders");
    assert.equal(byPath("/orders").inContract, true);
    assert.equal(byPath("/carts").inContract, false);
  });
});

describe("enviar", () => {
  const send = (body: Record<string, unknown>) =>
    api().post(`${base()}/endpoints/send`).set(as(owner)).field("request", JSON.stringify(body));

  test("variables del entorno, parámetro de ruta, query y token de la petición; el eco no enseña el token", async () => {
    const response = await send({
      environmentId,
      method: "GET",
      path: "/users/{id}",
      pathParameters: [{ name: "id", value: "{{userId}}" }],
      query: [
        { name: "expand", value: "roles", enabled: true },
        { name: "off", value: "x", enabled: false },
      ],
      headers: [{ name: "X-Trace", value: "t-1", enabled: true }],
      body: { mode: "none" },
      auth: { mode: "bearer", token: "{{token}}" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const answered = JSON.parse(response.body.response.body);
    assert.equal(answered.url, "/users/42?expand=roles");
    assert.equal(answered.headers.authorization, "Bearer tok-secreto");
    assert.equal(answered.headers["x-trace"], "t-1");
    assert.equal(response.body.response.status, 200);
    assert.equal(response.body.request.headers.Authorization, "••••••••");
    assert.equal(JSON.stringify(response.body.request).includes("tok-secreto"), false);
    assert.equal(response.body.auth, "Bearer de esta petición");
    assert.deepEqual(response.body.environment, { id: environmentId, name: "local" });
  });

  test("sin entorno va a la URL base del proyecto con su API key", async () => {
    const response = await send({ method: "GET", path: "/missing", body: { mode: "none" } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.response.status, 404);
    assert.equal(JSON.parse(response.body.response.body).headers["x-api-key"], "clave-del-proyecto");
    assert.equal(response.body.auth, "API key del proyecto");
  });

  test("un entorno sin escrituras no deja mandar un POST", async () => {
    const response = await send({ environmentId, method: "POST", path: "/carts", body: { mode: "json", text: "{}" } });
    assert.equal(response.status, 409);
    assert.match(response.body.type, /writes-not-allowed$/);
  });

  test("una variable que nadie definió se dice antes de enviar", async () => {
    const response = await send({ environmentId, method: "GET", path: "/users/{{nadie}}" });
    assert.equal(response.status, 422);
    assert.match(response.body.detail, /nadie/);
    const placeholder = await send({ method: "GET", path: "/users/{id}" });
    assert.equal(placeholder.status, 422);
    assert.match(placeholder.body.type, /path-parameter-missing$/);
  });

  test("una operación GraphQL llega como {query, variables} con las variables del entorno dentro", async () => {
    const operation = {
      mode: "graphql",
      text: "query ($id: ID!) { user(id: $id) { name } }",
      variables: '{"id": "{{userId}}"}',
    };
    // Por `GET`, en la query: el entorno no deja escribir, y una consulta no escribe.
    const response = await send({
      environmentId,
      method: "GET",
      path: "/graphql",
      body: operation,
      auth: { type: "none", params: {} },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const answered = JSON.parse(response.body.response.body);
    const search = new URL(answered.url, "http://x").searchParams;
    assert.equal(search.get("query"), operation.text);
    assert.deepEqual(JSON.parse(search.get("variables")!), { id: "42" });
    assert.equal(answered.body, "");
    assert.equal(answered.headers["content-type"], undefined);

    // Por `POST`, en el cuerpo y como JSON.
    const posted = await send({ method: "POST", path: "/graphql", body: operation, auth: { type: "none", params: {} } });
    assert.equal(posted.status, 422, "sin entorno no hay userId");
    const postedOk = await send({
      method: "POST",
      path: "/graphql",
      body: { ...operation, variables: '{"id": "7"}' },
      auth: { type: "none", params: {} },
    });
    assert.equal(postedOk.status, 200, JSON.stringify(postedOk.body));
    const received = JSON.parse(postedOk.body.response.body);
    assert.equal(received.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(received.body), { query: operation.text, variables: { id: "7" } });

    const unresolved = await send({
      environmentId,
      method: "GET",
      path: "/graphql",
      body: { mode: "graphql", text: "{ a }", variables: '{"id": {{nadie}}}' },
    });
    assert.equal(unresolved.status, 422);
    assert.match(unresolved.body.detail, /nadie/);

    const broken = await send({
      method: "GET",
      path: "/graphql",
      body: { mode: "graphql", text: "{ a }", variables: "[1, 2]" },
    });
    assert.equal(broken.status, 422);
    assert.match(broken.body.type, /graphql-variables-invalid$/);
  });

  test("form-data con un fichero llega entero; un .exe no sale", async () => {
    const request = {
      method: "POST",
      path: "/upload",
      body: {
        mode: "form-data",
        fields: [
          { name: "caption", value: "hola", kind: "text", enabled: true },
          { name: "doc", value: "", kind: "file", enabled: true },
        ],
      },
      auth: { mode: "none" },
    };
    const response = await api()
      .post(`${base()}/endpoints/send`)
      .set(as(owner))
      .field("request", JSON.stringify(request))
      .attach("file:doc", Buffer.from("contenido del fichero"), "doc.txt");
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const answered = JSON.parse(response.body.response.body);
    assert.match(answered.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(answered.body, /name="caption"\r\n\r\nhola/);
    assert.match(answered.body, /filename="doc.txt"\r\nContent-Type: text\/plain\r\n\r\ncontenido del fichero/);
    assert.equal(answered.headers["x-api-key"], undefined);

    const blocked = await api()
      .post(`${base()}/endpoints/send`)
      .set(as(owner))
      .field("request", JSON.stringify(request))
      .attach("file:doc", Buffer.from("MZ"), "setup.exe");
    assert.equal(blocked.status, 422);
    assert.match(blocked.body.type, /file-type-blocked$/);
  });

  /**
   * Los tipos de autenticación de Postman, enviados de verdad y vistos en el destino.
   *
   * El destino devuelve las cabeceras que recibió, así que esto no comprueba que se calculó una
   * firma: comprueba que la firma **llegó**. Es la diferencia entre un firmante con pruebas y un
   * producto que autentica.
   */
  test("cada tipo llega al destino con la credencial que le toca", async () => {
    const basic = await send({
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: { type: "basic", params: { username: "ana", password: "hunter2" } },
    });
    assert.equal(basic.status, 200, JSON.stringify(basic.body));
    assert.equal(
      JSON.parse(basic.body.response.body).headers.authorization,
      `Basic ${Buffer.from("ana:hunter2").toString("base64")}`,
    );
    assert.equal(basic.body.auth, "Basic de esta petición");
    // La contraseña no vuelve en el eco, como no vuelve ningún secreto.
    assert.equal(JSON.stringify(basic.body.request).includes("hunter2"), false);

    // Una clave en la query va en la URL y no en una cabecera.
    const apikey = await send({
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: { type: "apikey", params: { key: "api_key", value: "abc123", in: "query" } },
    });
    assert.equal(apikey.status, 200, JSON.stringify(apikey.body));
    assert.equal(JSON.parse(apikey.body.response.body).url, "/users?api_key=abc123");
    assert.equal(JSON.parse(apikey.body.response.body).headers.api_key, undefined);

    // La firma de AWS: el destino ve el esquema, el ámbito y las cabeceras firmadas.
    const aws = await send({
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: {
        type: "awsv4",
        params: { accessKey: "AKIDEXAMPLE", secretKey: "secreta", region: "eu-west-1", service: "execute-api" },
      },
    });
    assert.equal(aws.status, 200, JSON.stringify(aws.body));
    const signed = JSON.parse(aws.body.response.body).headers;
    assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/execute-api\/aws4_request/);
    assert.match(signed.authorization, /SignedHeaders=host;x-amz-date/);
    assert.ok(signed["x-amz-date"]);
    assert.equal(JSON.stringify(aws.body.request).includes("secreta"), false);

    // Hawk firma el host y el puerto, así que su mac depende de la URL: basta ver que llegó.
    const hawk = await send({
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: { type: "hawk", params: { authId: "dh37fgj492je", authKey: "clave", algorithm: "sha256" } },
    });
    assert.equal(hawk.status, 200, JSON.stringify(hawk.body));
    assert.match(JSON.parse(hawk.body.response.body).headers.authorization, /^Hawk id="dh37fgj492je", ts="\d+", nonce=".+", mac=".+"$/);
  });

  test("NTLM se dice que no y no manda media negociación", async () => {
    const response = await send({
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: { type: "ntlm", params: { username: "a", password: "b" } },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.auth, /NTLM: .*tres vueltas/);
    assert.equal(JSON.parse(response.body.response.body).headers.authorization, undefined);
  });

  test("Digest pide el 401 primero, y dice cuando el servidor no lo pide", async () => {
    // El destino de estas pruebas no pide autenticación, así que no hay reto del que firmar. Eso
    // se dice; antes de esto Digest no existía, y mandar una cabecera sin `nonce` da un 400 raro.
    const response = await send({
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: { type: "digest", params: { username: "ana", password: "hunter2" } },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.auth, /Digest: el servidor no pidió autenticación/);
  });

  test("el bloque viejo {mode, token} se sigue leyendo: una pestaña sin recargar no deja de enviar", async () => {
    const response = await send({
      environmentId,
      method: "GET",
      path: "/users",
      body: { mode: "none" },
      auth: { mode: "bearer", token: "{{token}}" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(JSON.parse(response.body.response.body).headers.authorization, "Bearer tok-secreto");
  });

  /**
   * El tarro de cookies: una API que autentica con cookie, probada de principio a fin.
   *
   * Sin esto era imposible. El login contestaba su `Set-Cookie`, la petición siguiente salía sin
   * él, y todo lo que iba detrás contestaba 401; la única salida era capturar la cookie con un
   * script y pegarla a mano en una cabecera.
   */
  test("el login deja la cookie puesta y la petición siguiente la lleva", async () => {
    // Un POST que contesta 302: se sigue como GET —como hace cualquier navegador— y la cookie de
    // ese salto es justo la que hace falta. Antes esto se rechazaba por ser «una escritura».
    const login = await send({
      method: "POST",
      path: "/entrar",
      body: { mode: "json", text: '{"email":"a@b.c","password":"x"}' },
      auth: { type: "none", params: {} },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.response.status, 200);
    // Llegó a la ruta de después de la redirección, y como GET sin cuerpo.
    const landed = JSON.parse(login.body.response.body);
    assert.equal(landed.url, "/tras-entrar");
    assert.equal(landed.method, "GET");

    // Las dos propias se guardaron; la de otro dominio no, y se dice por qué.
    assert.deepEqual(login.body.cookies.stored.sort(), ["session=127.0.0.1/", "tema=127.0.0.1/"]);
    assert.equal(login.body.cookies.rejected.length, 1);
    assert.match(login.body.cookies.rejected[0].why, /no es el dominio de 127\.0\.0\.1/);
    // El valor no vuelve en ninguna parte de la respuesta: es una credencial.
    assert.equal(JSON.stringify(login.body.request).includes("s3cr3t0"), false);

    // La petición siguiente la lleva, sin que nadie escriba una cabecera.
    const after = await send({ method: "GET", path: "/privado", body: { mode: "none" }, auth: { type: "none", params: {} } });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const sent = JSON.parse(after.body.response.body).headers.cookie;
    assert.match(sent, /session=s3cr3t0/);
    assert.match(sent, /tema=oscuro/);
    assert.deepEqual(after.body.cookies.sent.sort(), ["session=127.0.0.1/", "tema=127.0.0.1/"]);

    // Y se puede mirar, con el valor tapado salvo que se pida.
    const listed = await api().get(`${base()}/cookies`).set(as(owner));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const session = listed.body.cookies.find((cookie: { name: string }) => cookie.name === "session");
    assert.equal(session.value, "\u2022".repeat(8));
    assert.equal(session.httpOnly, true);
    assert.equal(session.hostOnly, true);
    const revealed = await api().get(`${base()}/cookies?reveal=true`).set(as(owner));
    assert.equal(
      revealed.body.cookies.find((cookie: { name: string }) => cookie.name === "session").value,
      "s3cr3t0",
    );

    // Borrar una deja la otra, que es la diferencia entre la clave de la RFC y borrar por nombre.
    const removed = await api()
      .delete(`${base()}/cookies?domain=127.0.0.1&path=/&name=tema`)
      .set(as(owner));
    assert.equal(removed.status, 204);
    const rest = await api().get(`${base()}/cookies`).set(as(owner));
    assert.deepEqual(
      rest.body.cookies.map((cookie: { name: string }) => cookie.name),
      ["session"],
    );

    // Vaciarlo es cerrar sesión: la petición siguiente sale sin nada.
    assert.equal((await api().delete(`${base()}/cookies`).set(as(owner))).status, 204);
    const naked = await send({ method: "GET", path: "/privado", body: { mode: "none" }, auth: { type: "none", params: {} } });
    assert.equal(JSON.parse(naked.body.response.body).headers.cookie, undefined);
  });

  test("una cookie escrita a mano pasa por las mismas reglas que las del servidor", async () => {
    const written = await api()
      .post(`${base()}/cookies`)
      .set(as(owner))
      .send({ url: `${origin}/algo`, setCookie: "manual=abc; Path=/" });
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(written.body.cookie.value, "abc");

    const sent = await send({ method: "GET", path: "/privado", body: { mode: "none" }, auth: { type: "none", params: {} } });
    assert.match(JSON.parse(sent.body.response.body).headers.cookie, /manual=abc/);

    // Y las reglas son las mismas: un dominio ajeno se rechaza aquí también, con su motivo.
    const refused = await api()
      .post(`${base()}/cookies`)
      .set(as(owner))
      .send({ url: `${origin}/algo`, setCookie: "robada=1; Domain=otro.example.com" });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.match(refused.body.type, /cookie-rejected$/);
    assert.match(JSON.stringify(refused.body), /no es el dominio/);

    await api().delete(`${base()}/cookies`).set(as(owner));
  });

  test("una cabecera Cookie escrita a mano gana sobre el tarro", async () => {
    await api()
      .post(`${base()}/cookies`)
      .set(as(owner))
      .send({ url: `${origin}/algo`, setCookie: "delTarro=1; Path=/" });
    const response = await send({
      method: "GET",
      path: "/privado",
      headers: [{ name: "Cookie", value: "aMano=2", enabled: true }],
      body: { mode: "none" },
      auth: { type: "none", params: {} },
    });
    assert.equal(JSON.parse(response.body.response.body).headers.cookie, "aMano=2");
    await api().delete(`${base()}/cookies`).set(as(owner));
  });

  test("un destino que no responde vuelve como error dentro de la respuesta, no como 500", async () => {
    const response = await send({ method: "GET", path: "http://127.0.0.1:1/nada", auth: { mode: "none" } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.response, null);
    assert.ok(response.body.error);
  });
});
