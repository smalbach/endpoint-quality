/**
 * Entornos, credenciales, configuración e importación de endpoints por la API: los caminos de error
 * y de conservación que las pruebas de cada módulo no pisaban, con el Problem Details que sale.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { MASKED_VALUE } from "@/modules/environments/domain/model";
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
const base = (id = projectId) => `/orgs/${owner.organizationId}/projects/${id}`;

async function createProject(name: string): Promise<string> {
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name, baseUrl: "http://api.test" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.projectId;
}

async function environmentId(name: string, id = projectId): Promise<string> {
  const list = await api().get(`${base(id)}/environments`).set(as(owner));
  const found = (list.body as { id: string; name: string }[]).find((row) => row.name === name);
  assert.ok(found, `no hay entorno ${name}`);
  return found.id;
}

const problem = (response: request.Response, status: number, type?: string) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.match(String(response.headers["content-type"]), /application\/problem\+json/);
  if (type) assert.equal(response.body.type, `https://endpoint-quality.dev/problems/${type}`);
};

before(async () => {
  context = await createTestApp();
  owner = await signUp("authep-config@example.com");
  projectId = await createProject("Configurable");
});

after(async () => {
  await context?.close();
});

describe("entornos", () => {
  test("un nombre en blanco es un 422 que nombra `name`; una URL base que no es URL también", async () => {
    const blank = await api().post(`${base()}/environments`).set(as(owner)).send({ name: "   ", baseUrl: "http://a.test" });
    problem(blank, 422);
    assert.deepEqual(blank.body.errors, [{ field: "name", detail: "Requerido" }]);

    const notUrl = await api().post(`${base()}/environments`).set(as(owner)).send({ name: "x", baseUrl: "no es una url" });
    problem(notUrl, 422);
    assert.deepEqual(notUrl.body.errors, [{ field: "baseUrl", detail: "Debe ser una URL absoluta" }]);
  });

  test("un nombre repetido es un 409; una variable con nombre inválido un 422 que la nombra", async () => {
    const first = await api()
      .post(`${base()}/environments`)
      .set(as(owner))
      .send({
        name: "prod",
        baseUrl: "https://prod.test/",
        variables: { token: { initial: "s3cr3t", sensitive: true } },
      });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const again = await api().post(`${base()}/environments`).set(as(owner)).send({ name: "prod", baseUrl: "https://p.test" });
    problem(again, 409, "environment-name-taken");

    const bad = await api()
      .post(`${base()}/environments`)
      .set(as(owner))
      .send({ name: "raro", baseUrl: "https://r.test", variables: { "1malo": "x" } });
    problem(bad, 422);
    assert.equal(bad.body.errors[0].field, "variables.1malo");
    assert.equal(await context.repositories.environments.findByName(projectId, "raro"), null);
  });

  test("editar uno que no existe es un 404; renombrarlo como otro, un 409", async () => {
    const missing = await api()
      .patch(`${base()}/environments/3fa85f64-5717-4562-b3fc-2c963f66afa6`)
      .set(as(owner))
      .send({ writesAllowed: true });
    problem(missing, 404, "environment-not-found");

    const staging = await api().post(`${base()}/environments`).set(as(owner)).send({ name: "staging", baseUrl: "https://s.test" });
    assert.equal(staging.status, 201);
    const clash = await api()
      .patch(`${base()}/environments/${staging.body.environmentId}`)
      .set(as(owner))
      .send({ name: "prod" });
    problem(clash, 409, "environment-name-taken");
    assert.equal((await context.repositories.environments.findById(staging.body.environmentId))?.name, "staging");
  });

  test("la máscara con `sensitive: false` destapa lo guardado; la URL del contrato se cambia si se manda", async () => {
    const id = await environmentId("prod");
    const stored = await context.repositories.environments.findById(id);
    assert.notEqual(stored?.variables.token.initial, "s3cr3t");

    const response = await api()
      .patch(`${base()}/environments/${id}`)
      .set(as(owner))
      .send({
        variables: { token: { initial: MASKED_VALUE, current: MASKED_VALUE, sensitive: false } },
        specUrl: "https://prod.test/docs/openapi.json",
      });
    assert.equal(response.status, 204, JSON.stringify(response.body));
    const after = await context.repositories.environments.findById(id);
    assert.deepEqual(after?.variables.token, { initial: "s3cr3t", current: "s3cr3t", sensitive: false });
    assert.equal(after?.specUrl, "https://prod.test/docs/openapi.json");
  });

  test("borrar el último entorno deja el proyecto sin entorno activo", async () => {
    const lonely = await createProject("Solitario");
    const created = await api().post(`${base(lonely)}/environments`).set(as(owner)).send({ name: "solo", baseUrl: "https://solo.test" });
    assert.equal(created.status, 201);
    assert.equal((await context.repositories.projects.findById(lonely))?.activeEnvironmentId, created.body.environmentId);

    const removed = await api().delete(`${base(lonely)}/environments/${created.body.environmentId}`).set(as(owner));
    assert.equal(removed.status, 204);
    assert.equal((await context.repositories.projects.findById(lonely))?.activeEnvironmentId, null);
  });
});

describe("importar un entorno de Postman", () => {
  test("un texto que no es JSON es un 422 postman-invalid", async () => {
    const response = await api().post(`${base()}/environments/import/postman`).set(as(owner)).send({ text: "no es json" });
    problem(response, 422, "postman-invalid");
  });

  test("sin nombre se llama «Entorno importado»; la segunda vez conserva la URL y el secreto que viene en blanco", async () => {
    const first = await api()
      .post(`${base()}/environments/import/postman`)
      .set(as(owner))
      .send({
        text: JSON.stringify({
          values: [
            { key: "baseUrl", value: "http://pm.test/", enabled: true },
            { key: "token", value: "tok-1", type: "secret", enabled: true },
          ],
        }),
      });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.name, "Entorno importado");
    assert.equal(first.body.action, "created");
    const id = first.body.id as string;
    const tokenBefore = (await context.repositories.environments.findById(id))?.variables.token;

    const second = await api()
      .post(`${base()}/environments/import/postman`)
      .set(as(owner))
      .send({
        text: JSON.stringify({ values: [{ key: "token", value: "", type: "default", enabled: true }] }),
      });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.action, "updated");
    assert.equal(second.body.id, id);
    assert.equal(second.body.baseUrl, "http://pm.test");
    assert.ok((second.body.notes as string[]).some((note) => /se conservó lo que ya había aquí: token/.test(note)));
    // Lo guardado sigue siendo el mismo cifrado, y sigue siendo secreto aunque el fichero no lo diga.
    assert.deepEqual((await context.repositories.environments.findById(id))?.variables.token, tokenBefore);
  });
});

describe("importar un entorno de Postman con su propio nombre", () => {
  test("el nombre del fichero se usa si no se da otro", async () => {
    const response = await api()
      .post(`${base()}/environments/import/postman`)
      .set(as(owner))
      .send({ text: JSON.stringify({ name: "  Del fichero ", values: [{ key: "host", value: "https://h.test" }] }) });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.name, "Del fichero");
    assert.equal(response.body.baseUrl, "https://h.test");
  });
});

describe("credenciales", () => {
  test("sin nombre toma el del rol; borrarla quita la fila, y borrar otra vez no es un error", async () => {
    const id = await environmentId("prod");
    const saved = await api()
      .put(`${base()}/environments/${id}/credentials`)
      .set(as(owner))
      .send({ name: "  ", role: "primary", kind: "bearer", secret: "tok" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await context.repositories.environments.findCredential(id, "primary"))?.name, "primary");

    const removed = await api().delete(`${base()}/environments/${id}/credentials/primary`).set(as(owner));
    assert.equal(removed.status, 204);
    assert.equal(await context.repositories.environments.findCredential(id, "primary"), null);

    const again = await api().delete(`${base()}/environments/${id}/credentials/primary`).set(as(owner));
    assert.equal(again.status, 204);
  });

  test("borrar la credencial de un entorno de otro proyecto es un 404", async () => {
    const other = await createProject("Ajeno");
    const response = await api().delete(`${base(other)}/environments/${await environmentId("prod")}/credentials/primary`).set(as(owner));
    problem(response, 404, "environment-not-found");
  });
});

describe("configuración", () => {
  test("restablecer una sección la borra; una sección que no existe es un 422", async () => {
    const saved = await api().put(`${base()}/config/budgets`).set(as(owner)).send({ budgets: [] });
    assert.equal(saved.status, 204, JSON.stringify(saved.body));
    assert.ok(await context.repositories.config.findSection(projectId, "budgets"));

    const reset = await api().delete(`${base()}/config/budgets`).set(as(owner));
    assert.equal(reset.status, 204);
    assert.equal(await context.repositories.config.findSection(projectId, "budgets"), null);

    const unknown = await api().delete(`${base()}/config/inventada`).set(as(owner));
    problem(unknown, 422, "config-section-unknown");
  });

  test("restablecer en un proyecto de otra organización es un 403 del guardia", async () => {
    const stranger = await signUp("authep-config-ajeno@example.com");
    const response = await api().delete(`${base()}/config/budgets`).set(as(stranger));
    problem(response, 403);
  });
});

describe("endpoints", () => {
  test("un .yaml que no se puede leer se importa como un salto con su motivo, no como un 500", async () => {
    const response = await api()
      .post(`${base()}/endpoints/import/file`)
      .set(as(owner))
      .attach("file", Buffer.from("openapi: [3.0\n  paths: {"), "roto.yaml");
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.format, "openapi");
    assert.deepEqual(response.body.imported, []);
    assert.equal(response.body.skipped.length, 1);
    assert.ok(response.body.skipped[0].reason.length > 0);
  });

  test("la lista pagina con page y limit en la query", async () => {
    for (const path of ["/a", "/b", "/c"]) {
      const created = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "GET", path });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    const page = await api().get(`${base()}/endpoints?page=2&limit=2`).set(as(owner));
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.data.length, 1);
    const bad = await api().get(`${base()}/endpoints?page=0`).set(as(owner));
    problem(bad, 422);
  });

  test("mover un ejemplo con orderIndex en el cuerpo; uno que no existe es un 404", async () => {
    const endpoint = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "POST", path: "/ejemplos" });
    assert.equal(endpoint.status, 201);
    const pair = {
      request: { method: "POST", url: "https://api.test/ejemplos", headers: [], body: { text: "{}", contentType: "application/json" } },
      response: { status: 201, headers: [], body: '{"id":1}', contentType: "application/json", durationMs: 4 },
    };
    const saved = await api().post(`${base()}/endpoints/${endpoint.body.id}/examples`).set(as(owner)).send(pair);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));

    const moved = await api()
      .patch(`${base()}/endpoints/${endpoint.body.id}/examples/${saved.body.example.id}`)
      .set(as(owner))
      .send({ orderIndex: "4" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.example.orderIndex, 4);

    const missing = await api()
      .patch(`${base()}/endpoints/${endpoint.body.id}/examples/3fa85f64-5717-4562-b3fc-2c963f66afa6`)
      .set(as(owner))
      .send({ name: "x" });
    problem(missing, 404, "example-not-found");
  });
});
