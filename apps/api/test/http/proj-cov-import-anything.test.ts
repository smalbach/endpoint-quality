/**
 * La puerta única de import: lo que dice cada resultado la segunda vez, un fichero del proyecto que
 * no trae nada nuevo o que no vale, un texto pegado sin nombre, y las URL que no contestan.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
const api = () => request(context.app.getHttpServer());
let token: string;
let organizationId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  context = await createTestApp();
  const email = "proj-cov-import-anything@example.com";
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  organizationId = registered.body.organizationId;
  token = (await api().post("/auth/login").send({ email, password })).body.accessToken;
});
after(async () => {
  await context?.close();
});

async function project(): Promise<string> {
  const created = await api()
    .post(`/orgs/${organizationId}/projects`)
    .set(auth())
    .send({ name: `p-${Math.random().toString(36).slice(2, 8)}`, baseUrl: "https://api.test" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return `/orgs/${organizationId}/projects/${created.body.projectId}`;
}
type Result = { target: string; name: string; summary: string | null; error: string | null; notes?: string[] };
async function importOne(base: string, body: Record<string, unknown>) {
  const response = await api().post(`${base}/import`).set(auth()).send(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as { items: { kind: string; results: Result[] }[] };
}
const results = (body: { items: { results: Result[] }[] }) => body.items.flatMap((item) => item.results);

const ENVIRONMENT = JSON.stringify({
  name: "local",
  values: [{ key: "baseUrl", value: "http://localhost:9999", type: "default", enabled: true }],
  _postman_variable_scope: "environment",
});
const BUNDLE = JSON.stringify({
  format: "endpoint-quality/project",
  version: 1,
  project: { name: "Exportado" },
  endpoints: [{ method: "GET", path: "/desde-fichero" }],
});

describe("la segunda vez", () => {
  test("un contrato igual sale «sin cambios» y un entorno que ya existe, «actualizado»", async () => {
    const base = await project();
    const sources = [
      { name: "contrato.yaml", text: STUB_SPEC_YAML },
      { name: "local.postman_environment.json", text: ENVIRONMENT },
    ];
    const first = results(await importOne(base, { sources }));
    assert.match(first.find((entry) => entry.target === "contract")!.summary!, /operaciones · activado$/);
    assert.match(first.find((entry) => entry.target === "environment")!.summary!, /^nuevo · /);

    const second = results(await importOne(base, { sources }));
    assert.match(second.find((entry) => entry.target === "contract")!.summary!, /^sin cambios · \d+ operaciones$/);
    assert.match(second.find((entry) => entry.target === "environment")!.summary!, /^actualizado · /);
  });

  test("un proyecto exportado cuenta lo que trae; otra vez, «no trajo nada nuevo» y dice por qué", async () => {
    const base = await project();
    const [first] = results(await importOne(base, { sources: [{ name: "p.eq.json", text: BUNDLE }] }));
    assert.equal(first!.target, "project");
    assert.equal(first!.summary, "1 endpoints");
    assert.equal(first!.notes, undefined);

    const [again] = results(await importOne(base, { sources: [{ name: "p.eq.json", text: BUNDLE }] }));
    assert.equal(again!.summary, "no trajo nada nuevo");
    assert.deepEqual(again!.notes, ["endpoint: GET /desde-fichero ya existe"]);
    assert.equal(again!.error, null);
  });

  test("un proyecto exportado inválido no hunde el lote: su resultado lleva el error", async () => {
    const base = await project();
    const broken = JSON.stringify({ format: "endpoint-quality/project", version: 1, endpoints: [{ method: "NADA" }] });
    const body = await importOne(base, {
      sources: [
        { name: "roto.eq.json", text: broken },
        { name: "local.postman_environment.json", text: ENVIRONMENT },
      ],
    });
    const all = results(body);
    const failed = all.find((entry) => entry.target === "project")!;
    assert.equal(failed.summary, null);
    assert.match(failed.error!, /no es un proyecto exportado válido/);
    assert.equal(all.find((entry) => entry.target === "environment")!.error, null);
  });
});

describe("texto pegado", () => {
  test("un curl pegado sin nombre entra como endpoints", async () => {
    const base = await project();
    const body = await importOne(base, { sources: [{ text: "curl -X POST https://api.test/pedidos -d '{}'" }] });
    assert.equal(body.items[0]!.kind, "curl");
    const [endpoints] = results(body);
    assert.equal(endpoints!.target, "endpoints");
    assert.equal(endpoints!.error, null, JSON.stringify(endpoints));
    assert.match(endpoints!.summary!, /^1 nuevos/);
  });

  test("un HAR entra como endpoints", async () => {
    const base = await project();
    const har = JSON.stringify({
      log: {
        version: "1.2",
        creator: { name: "Chrome DevTools", version: "1" },
        entries: [
          {
            startedDateTime: "2026-01-01T00:00:00.000Z",
            time: 1,
            request: {
              method: "GET",
              url: "https://api.test/grabado",
              httpVersion: "HTTP/1.1",
              headers: [],
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/1.1",
              headers: [{ name: "content-type", value: "application/json" }],
              cookies: [],
              content: { size: 2, mimeType: "application/json", text: "{}" },
              redirectURL: "",
              headersSize: -1,
              bodySize: 2,
            },
            cache: {},
            timings: { send: 0, wait: 1, receive: 0 },
          },
        ],
      },
    });
    const body = await importOne(base, { sources: [{ name: "red.har", text: har }] });
    assert.equal(body.items[0]!.kind, "har");
    const [endpoints] = results(body);
    assert.equal(endpoints!.target, "endpoints");
    assert.equal(endpoints!.error, null, JSON.stringify(endpoints));
  });

  test("una colección sin peticiones: los dos resultados llevan su error, y el lote sigue", async () => {
    const base = await project();
    const empty = JSON.stringify({
      info: { name: "Vacía", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [],
    });
    const body = await importOne(base, { sources: [{ name: "vacia.json", text: empty }] });
    const all = results(body);
    assert.deepEqual(
      all.map((entry) => entry.target),
      ["endpoints", "flows"],
    );
    for (const entry of all) {
      assert.equal(entry.summary, null, JSON.stringify(entry));
      assert.ok(entry.error, JSON.stringify(entry));
    }
  });
});

describe("una URL que no contesta con el documento", () => {
  test("un 404 dice el estado; un 403 sin credencial no culpa a la credencial", async () => {
    const base = await project();
    context.http.reply("https://docs.test/no-esta.json", "no", 404);
    const missing = await api().post(`${base}/import`).set(auth()).send({ url: "https://docs.test/no-esta.json" });
    assert.equal(missing.status, 422);
    assert.match(String(missing.body.type), /url-unreadable$/);
    assert.deepEqual(missing.body.errors, [{ field: "url", detail: "Contestó 404" }]);

    context.http.reply("https://docs.test/prohibido.json", "no", 403);
    const forbidden = await api().post(`${base}/import`).set(auth()).send({ url: "https://docs.test/prohibido.json" });
    assert.deepEqual(forbidden.body.errors, [{ field: "url", detail: "Contestó 403" }]);

    context.http.reply("https://docs.test/prohibido-con.json", "no", 403);
    const withCredential = await api()
      .post(`${base}/import`)
      .set(auth())
      .send({ url: "https://docs.test/prohibido-con.json", urlAuth: { kind: "bearer", token: "t" } });
    assert.deepEqual(withCredential.body.errors, [
      { field: "url", detail: "Contestó 403 con la credencial que se envió" },
    ]);
  });

  test("una URL que la guarda de red no deja leer es ilegible, antes de importar nada", async () => {
    const base = await project();
    const response = await api().post(`${base}/import`).set(auth()).send({ url: "http://127.0.0.1:1/privado.json" });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.match(String(response.body.type), /url-unreadable$/);
    assert.equal(response.body.errors[0].field, "url");
  });

  test("una URL con consulta se nombra por su último tramo, y se suma a lo adjuntado", async () => {
    const base = await project();
    context.http.reply("https://docs.test/entornos/local.json?v=2", ENVIRONMENT);
    const body = await importOne(base, {
      url: "https://docs.test/entornos/local.json?v=2",
      sources: [{ name: "contrato.yaml", text: STUB_SPEC_YAML }],
    });
    assert.deepEqual(
      body.items.map((item) => item.kind),
      ["openapi", "postman-environment"],
    );
    assert.ok(results(body).every((entry) => entry.error === null), JSON.stringify(body));
  });
});
