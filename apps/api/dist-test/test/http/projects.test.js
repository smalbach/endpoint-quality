"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Projects and contracts over HTTP, against the real Digital Catalog document.
 *
 * The point of the file is the last block: the same `bundled.yaml` the coupled dashboard had
 * compiled into its bundle is imported through the API, at runtime, and comes back as 46
 * operations. That is what makes the generator in the other repository redundant.
 *
 * The rest is the tenancy and lifecycle around it, checked from the attacker's side where it
 * matters: a project id belonging to another organization has to be a 404 and not a 403.
 */
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const supertest_1 = __importDefault(require("supertest"));
const test_app_1 = require("../support/test-app");
const SPEC_PATH = "/Users/smalbach/Documents/GiProjectos/geronimo-martings/digital-catalog-back-end/docs/openapi/bundled.yaml";
const HAS_REAL_SPEC = (0, node_fs_1.existsSync)(SPEC_PATH);
const tinySpec = `
openapi: 3.1.0
info: { title: Blog, version: "1.0.0" }
paths:
  /posts:
    get:
      operationId: listPosts
      tags: [Posts]
      responses: { "200": {}, "401": {} }
  /posts/{slug}:
    parameters:
      - { name: slug, in: path, required: true, schema: { type: string } }
    get:
      operationId: getPost
      responses: { "200": {}, "404": {} }
`;
let context;
const api = () => (0, supertest_1.default)(context.app.getHttpServer());
async function signUp(email) {
    const password = "una-contraseña-larga";
    const registered = await api().post("/auth/register").send({ email, password, name: email.split("@")[0] });
    const session = await api().post("/auth/login").send({ email, password });
    // Asserted rather than trusted. When login fails the token is `undefined`, every later request
    // goes out as `Bearer undefined`, and the suite reports a 401 on whatever line happens to be
    // next — which describes the symptom and hides the cause.
    strict_1.default.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
    strict_1.default.ok(session.body.accessToken, `el login de ${email} no devolvió token`);
    return { userId: registered.body.userId, organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor) => ({ Authorization: `Bearer ${actor.token}` });
let owner;
let outsider;
let projectId;
(0, node_test_1.before)(async () => {
    context = await (0, test_app_1.createTestApp)();
    owner = await signUp("owner@example.com");
    outsider = await signUp("outsider@example.com");
    const created = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Digital Catalog" });
    projectId = created.body.projectId;
});
(0, node_test_1.after)(async () => {
    await context?.close();
});
(0, node_test_1.describe)("proyectos", () => {
    (0, node_test_1.test)("se crea con slug derivado del nombre y sin contrato", () => {
        // `contract: null` is a real state the UI has to render: importing can fail, and losing the
        // project along with a failed import would help nobody.
        strict_1.default.ok(projectId);
    });
    (0, node_test_1.test)("el listado muestra el proyecto con contrato nulo", async () => {
        const response = await api().get(`/orgs/${owner.organizationId}/projects`).set(as(owner));
        strict_1.default.equal(response.status, 200);
        strict_1.default.equal(response.body.length, 1);
        strict_1.default.equal(response.body[0].slug, "digital-catalog");
        strict_1.default.equal(response.body[0].contract, null);
    });
    (0, node_test_1.test)("dos proyectos con el mismo nombre reciben slugs distintos", async () => {
        const second = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Digital Catalog" });
        strict_1.default.equal(second.body.slug, "digital-catalog-2");
    });
    (0, node_test_1.test)("otra organización puede llamar el mismo proyecto igual", async () => {
        // Slugs are unique per organization, not globally: a global namespace would let one customer
        // discover that another exists by the suffix they get.
        const theirs = await api().post(`/orgs/${outsider.organizationId}/projects`).set(as(outsider)).send({ name: "Digital Catalog" });
        strict_1.default.equal(theirs.body.slug, "digital-catalog");
    });
    (0, node_test_1.test)("renombrar no cambia el slug", async () => {
        // The slug is in URLs the team has bookmarked and in whatever CI job launches their runs.
        await api().patch(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner)).send({ name: "Catálogo Digital" });
        const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner));
        strict_1.default.equal(response.body.name, "Catálogo Digital");
        strict_1.default.equal(response.body.slug, "digital-catalog");
    });
    (0, node_test_1.test)("archivar lo saca del listado sin borrar nada", async () => {
        const extra = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Temporal" });
        strict_1.default.equal((await api().patch(`/orgs/${owner.organizationId}/projects/${extra.body.projectId}/archived`).set(as(owner)).send({ archived: true })).status, 204);
        const visible = await api().get(`/orgs/${owner.organizationId}/projects`).set(as(owner));
        strict_1.default.equal(visible.body.some((project) => project.id === extra.body.projectId), false);
        const all = await api().get(`/orgs/${owner.organizationId}/projects?includeArchived=true`).set(as(owner));
        strict_1.default.equal(all.body.some((project) => project.id === extra.body.projectId), true);
    });
    (0, node_test_1.test)("un editor no puede archivar", async () => {
        const editor = await signUp("editor@example.com");
        await context.repositories.memberships.save({ organizationId: owner.organizationId, userId: editor.userId, role: "editor", createdAt: new Date() });
        const response = await api().patch(`/orgs/${owner.organizationId}/projects/${projectId}/archived`).set(as(editor)).send({ archived: true });
        strict_1.default.equal(response.status, 403);
    });
});
(0, node_test_1.describe)("aislamiento de proyectos entre organizaciones", () => {
    (0, node_test_1.test)("un id de otra organización es 404 y no 403", async () => {
        // 403 would confirm the id is real, which is a cross-tenant oracle: an attacker enumerating
        // ids could map another customer's projects without ever reading one.
        const response = await api().get(`/orgs/${outsider.organizationId}/projects/${projectId}`).set(as(outsider));
        strict_1.default.equal(response.status, 404);
        strict_1.default.match(response.body.type, /project-not-found$/);
    });
    (0, node_test_1.test)("tampoco se puede importar un contrato en un proyecto ajeno", async () => {
        const response = await api()
            .post(`/orgs/${outsider.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(outsider))
            .send({ source: { kind: "inline", raw: tinySpec } });
        strict_1.default.equal(response.status, 404);
        strict_1.default.equal(context.repositories.specs.versions.size, 0);
    });
    (0, node_test_1.test)("y un ajeno sin membresía recibe 403 antes de llegar al proyecto", async () => {
        const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(outsider));
        strict_1.default.equal(response.status, 403);
    });
});
(0, node_test_1.describe)("importación de un contrato", () => {
    (0, node_test_1.test)("un documento inline se importa y se activa solo", async () => {
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: tinySpec } });
        strict_1.default.equal(response.status, 201);
        strict_1.default.equal(response.body.operationCount, 2);
        strict_1.default.equal(response.body.unchanged, false);
        // The first import activates itself whatever the flag says: a project whose only contract is
        // not the active one has nothing to run, and nobody ever means that.
        strict_1.default.equal(response.body.activated, true);
    });
    (0, node_test_1.test)("las operaciones quedan consultables con sus parámetros compartidos", async () => {
        const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/operations`).set(as(owner));
        strict_1.default.equal(response.status, 200);
        strict_1.default.deepEqual(response.body.operations.map((operation) => operation.id), ["listPosts", "getPost"]);
        const detail = response.body.operations.find((operation) => operation.id === "getPost");
        strict_1.default.deepEqual(detail.parameters, ["slug"]);
    });
    (0, node_test_1.test)("reimportar el mismo documento no crea una segunda versión", async () => {
        // Identical bytes resolve to the existing row, which is what lets a scheduled drift check
        // run often without growing the table.
        const before = context.repositories.specs.versions.size;
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: tinySpec } });
        strict_1.default.equal(response.body.unchanged, true);
        strict_1.default.equal(context.repositories.specs.versions.size, before);
    });
    (0, node_test_1.test)("un documento que no es OpenAPI 3 se rechaza con 422 y campos nombrados", async () => {
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: 'swagger: "2.0"\ninfo: {}\npaths: {}\n' } });
        strict_1.default.equal(response.status, 422);
        strict_1.default.match(response.body.type, /spec-invalid$/);
        strict_1.default.ok(response.body.errors.some((error) => /Swagger 2.0/.test(error.detail)));
    });
    (0, node_test_1.test)("un documento vacío se rechaza", async () => {
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: "   " } });
        strict_1.default.equal(response.status, 422);
    });
    (0, node_test_1.test)("kind url sin url es 422, no un 500 más adelante", async () => {
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "url" } });
        strict_1.default.equal(response.status, 422);
        strict_1.default.ok(response.body.errors.some((error) => error.field === "source.url"));
    });
    (0, node_test_1.test)("importar por URL pasa por el guard de red", async () => {
        context.http.reply("https://api.example.com/openapi.json", tinySpec);
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "url", url: "https://api.example.com/openapi.json" }, activate: false });
        strict_1.default.equal(response.status, 201);
        // Not `fetch` directly: every outbound request a customer can aim goes through the one
        // place where the SSRF policy is applied.
        strict_1.default.ok(context.http.requested.includes("https://api.example.com/openapi.json"));
    });
    (0, node_test_1.test)("el listado de versiones no incluye el documento crudo", async () => {
        // Ten versions of a 120 KB contract is 1.2 MB the browser has no use for.
        const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner));
        strict_1.default.equal(response.status, 200);
        strict_1.default.ok(response.body.versions.length > 0);
        strict_1.default.equal("raw" in response.body.versions[0], false);
    });
    (0, node_test_1.test)("un contrato de 118 KB entra: el tope de Express por defecto no alcanzaba", async () => {
        // Express parses at most 100 KB by default, and Digital Catalog's contract is 118 KB, so the
        // 8 MB the DTO advertised was a lie the first real document exposed.
        const padded = `${tinySpec}# ${"x".repeat(150 * 1024)}\n`;
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: padded }, activate: false });
        strict_1.default.equal(response.status, 201);
    });
    (0, node_test_1.test)("y uno que supera el tope responde 413, no 500", async () => {
        // `body-parser` rejects with a plain Error carrying `status`, not a Nest HttpException:
        // without the filter branch this arrived as an internal error, which tells the caller
        // nothing about what to do.
        const enormous = `${tinySpec}# ${"x".repeat(9 * 1024 * 1024)}\n`;
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: enormous } });
        strict_1.default.equal(response.status, 413);
        strict_1.default.equal(response.body.title, "Cuerpo demasiado grande");
    });
    (0, node_test_1.test)("un viewer puede leer operaciones pero no importar", async () => {
        const viewer = await signUp("viewer-projects@example.com");
        await context.repositories.memberships.save({ organizationId: owner.organizationId, userId: viewer.userId, role: "viewer", createdAt: new Date() });
        strict_1.default.equal((await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/operations`).set(as(viewer))).status, 200);
        const attempt = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
            .set(as(viewer))
            .send({ source: { kind: "inline", raw: tinySpec } });
        strict_1.default.equal(attempt.status, 403);
    });
});
(0, node_test_1.describe)("drift del contrato", () => {
    (0, node_test_1.test)("el mismo documento no reporta cambios", async () => {
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-drift-check`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: tinySpec } });
        strict_1.default.equal(response.status, 200);
        strict_1.default.equal(response.body.unchanged, true);
    });
    (0, node_test_1.test)("una operación que desaparece se reporta como rompedora y no se activa nada", async () => {
        // This is the capability the coupled dashboard structurally could not have: with the
        // operation table compiled into the bundle, "the contract changed" and "the contract is
        // fine" produced identical output — a green matrix.
        const shrunk = tinySpec.replace(/  \/posts\/\{slug\}:[\s\S]*$/, "");
        const before = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner))).body.contract.versionId;
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-drift-check`)
            .set(as(owner))
            .send({ source: { kind: "inline", raw: shrunk } });
        strict_1.default.equal(response.status, 200);
        strict_1.default.equal(response.body.unchanged, false);
        strict_1.default.equal(response.body.breaking.length, 1);
        strict_1.default.equal(response.body.breaking[0].id, "getPost");
        const after = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner))).body.contract.versionId;
        strict_1.default.equal(after, before, "un drift check no debe cambiar el contrato activo");
    });
    (0, node_test_1.test)("volver a una versión anterior es un solo comando", async () => {
        // When v1.9 turns the matrix red, the first question is whether the API broke or the
        // contract moved. Switching the active version answers it without a re-import.
        const versions = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner))).body;
        const target = versions.versions.find((version) => version.id !== versions.active);
        strict_1.default.equal((await api().post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions/${target.id}/activate`).set(as(owner))).status, 204);
        const now = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner))).body;
        strict_1.default.equal(now.active, target.id);
    });
    (0, node_test_1.test)("activar una versión de otro proyecto es 404", async () => {
        const other = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Otro" });
        const versions = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner))).body;
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${other.body.projectId}/spec-versions/${versions.active}/activate`)
            .set(as(owner));
        strict_1.default.equal(response.status, 404);
    });
});
(0, node_test_1.describe)("el contrato real de Digital Catalog", { skip: HAS_REAL_SPEC ? false : `sin ${SPEC_PATH}` }, () => {
    (0, node_test_1.test)("se importa por la API y produce las 46 operaciones", async () => {
        // The criterion of this phase. The same document the coupled dashboard had compiled into
        // its bundle, read at runtime, through the HTTP surface, into a project that owns it.
        const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Ara" });
        const response = await api()
            .post(`/orgs/${owner.organizationId}/projects/${project.body.projectId}/spec-versions`)
            .set(as(owner))
            .send({ source: { kind: "upload", filename: "bundled.yaml", raw: (0, node_fs_1.readFileSync)(SPEC_PATH, "utf8") } });
        strict_1.default.equal(response.status, 201);
        strict_1.default.equal(response.body.operationCount, 46);
        strict_1.default.deepEqual(response.body.problems, [], "el contrato del cliente no debería producir avisos");
        const operations = await api().get(`/orgs/${owner.organizationId}/projects/${project.body.projectId}/operations`).set(as(owner));
        strict_1.default.equal(operations.body.operations.length, 46);
        strict_1.default.equal(operations.body.contractVersion, "1.8.0");
        strict_1.default.deepEqual(operations.body.tags.sort(), ["Categories", "Health", "Prices", "Product Categories", "Product Projections", "Products", "Store Assortments", "Stores"]);
    });
});
//# sourceMappingURL=projects.test.js.map