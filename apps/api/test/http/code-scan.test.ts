/**
 * Code scan through the API: an upload is parsed and diffed, a connector's token is stored but never
 * returned, a GitHub scan reads the repo through the stubbed guard, and an import writes endpoints.
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
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let projectId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

const CONTROLLER = `
  @Controller("orders")
  @UseGuards(AuthGuard)
  export class OrdersController {
    @Get() list() {}
    @Post() @Roles("editor") create() {}
    @Get(":id") @Public() get() {}
  }
`;

before(async () => {
  context = await createTestApp();
  owner = await signUp("scan@example.com");
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Tienda" });
  projectId = project.body.projectId;
});

after(async () => {
  await context?.close();
});

describe("el escáner de código", () => {
  test("escaneo por subida: diff con añadidos e importar crea los endpoints", async () => {
    const scan = await api()
      .post(`${base()}/code-scan/scans/upload`)
      .set(as(owner))
      .send({ files: [{ path: "orders.controller.ts", content: CONTROLLER }], prefix: "api" });
    assert.equal(scan.status, 201, JSON.stringify(scan.body));

    const detail = (await api().get(`${base()}/code-scan/scans/${scan.body.scanId}`).set(as(owner))).body;
    assert.equal(detail.status, "ok");
    assert.equal(detail.result.controllers, 1);
    // GET /api/orders, POST /api/orders (rol editor), GET /api/orders/{id} (público).
    assert.equal(detail.diff.added.length, 3);
    assert.deepEqual(detail.impact.unknownRoles, ["editor"]);

    const imported = await api()
      .post(`${base()}/code-scan/scans/${scan.body.scanId}/import`)
      .set(as(owner))
      .send({ createRoles: true });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.created, 3);
    assert.equal(imported.body.rolesCreated, 1);

    const endpoints = (await api().get(`${base()}/endpoints`).set(as(owner))).body;
    const paths = endpoints.data.map((row: { method: string; path: string }) => `${row.method} ${row.path}`);
    assert.ok(paths.includes("POST /api/orders"));
    assert.ok(paths.includes("GET /api/orders/{id}"));

    // Un segundo import no duplica: las rutas ya existen.
    const again = await api().post(`${base()}/code-scan/scans/${scan.body.scanId}/import`).set(as(owner)).send({});
    assert.equal(again.body.created, 0);
  });

  test("el conector guarda el token pero no lo devuelve", async () => {
    const saved = await api()
      .put(`${base()}/code-scan/connector`)
      .set(as(owner))
      .send({ repo: "acme/api", branch: "main", basePath: "src", prefix: "api", token: "ghp_secreto" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const view = (await api().get(`${base()}/code-scan/connector`).set(as(owner))).body;
    assert.equal(view.repo, "acme/api");
    assert.equal(view.tokenSet, true);
    assert.equal(view.token, undefined, "el token no viaja de vuelta");
    assert.equal(JSON.stringify(view).includes("ghp_secreto"), false);
  });

  test("escaneo por GitHub: lee el repo por el guard y guarda el resultado", async () => {
    await api()
      .put(`${base()}/code-scan/connector`)
      .set(as(owner))
      .send({ repo: "acme/api", branch: "main", basePath: "src", prefix: "api" });

    context.http.reply(
      "https://api.github.com/repos/acme/api/git/trees/main?recursive=1",
      JSON.stringify({ sha: "abcdef123456", tree: [{ path: "src/orders.controller.ts", type: "blob" }] }),
    );
    context.http.reply(
      "https://api.github.com/repos/acme/api/contents/src/orders.controller.ts?ref=main",
      JSON.stringify({ encoding: "base64", content: Buffer.from(CONTROLLER, "utf8").toString("base64") }),
    );

    const scan = await api().post(`${base()}/code-scan/scans`).set(as(owner)).send({});
    assert.equal(scan.status, 201, JSON.stringify(scan.body));
    const detail = (await api().get(`${base()}/code-scan/scans/${scan.body.scanId}`).set(as(owner))).body;
    assert.equal(detail.status, "ok", detail.error ?? "");
    assert.equal(detail.source, "github");
    assert.equal(detail.result.controllers, 1);
    assert.ok(detail.ref.startsWith("main@"));
  });
});
