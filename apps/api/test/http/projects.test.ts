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
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

const SPEC_PATH =
  "/Users/smalbach/Documents/GiProjectos/geronimo-martings/digital-catalog-back-end/docs/openapi/bundled.yaml";
const HAS_REAL_SPEC = existsSync(SPEC_PATH);

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

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "una-contraseña-larga";
  const registered = await api()
    .post("/auth/register")
    .send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  // Asserted rather than trusted. When login fails the token is `undefined`, every later request
  // goes out as `Bearer undefined`, and the suite reports a 401 on whatever line happens to be
  // next — which describes the symptom and hides the cause.
  assert.equal(session.status, 200, `no se pudo iniciar sesión como ${email}: ${JSON.stringify(session.body)}`);
  assert.ok(session.body.accessToken, `el login de ${email} no devolvió token`);
  return {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    token: session.body.accessToken,
  };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let outsider: Actor;
let projectId: string;

before(async () => {
  context = await createTestApp();
  owner = await signUp("owner@example.com");
  outsider = await signUp("outsider@example.com");
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: "Digital Catalog" });
  projectId = created.body.projectId;
});
after(async () => {
  await context?.close();
});

describe("proyectos", () => {
  test("se crea con slug derivado del nombre y sin contrato", () => {
    // `contract: null` is a real state the UI has to render: importing can fail, and losing the
    // project along with a failed import would help nobody.
    assert.ok(projectId);
  });

  test("el listado muestra el proyecto con contrato nulo", async () => {
    const response = await api().get(`/orgs/${owner.organizationId}/projects`).set(as(owner));
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.equal(response.body[0].slug, "digital-catalog");
    assert.equal(response.body[0].contract, null);
  });

  test("dos proyectos con el mismo nombre reciben slugs distintos", async () => {
    const second = await api()
      .post(`/orgs/${owner.organizationId}/projects`)
      .set(as(owner))
      .send({ name: "Digital Catalog" });
    assert.equal(second.body.slug, "digital-catalog-2");
  });

  test("otra organización puede llamar el mismo proyecto igual", async () => {
    // Slugs are unique per organization, not globally: a global namespace would let one customer
    // discover that another exists by the suffix they get.
    const theirs = await api()
      .post(`/orgs/${outsider.organizationId}/projects`)
      .set(as(outsider))
      .send({ name: "Digital Catalog" });
    assert.equal(theirs.body.slug, "digital-catalog");
  });

  test("renombrar no cambia el slug", async () => {
    // The slug is in URLs the team has bookmarked and in whatever CI job launches their runs.
    await api()
      .patch(`/orgs/${owner.organizationId}/projects/${projectId}`)
      .set(as(owner))
      .send({ name: "Catálogo Digital" });
    const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner));
    assert.equal(response.body.name, "Catálogo Digital");
    assert.equal(response.body.slug, "digital-catalog");
  });

  test("archivar lo saca del listado sin borrar nada", async () => {
    const extra = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Temporal" });
    assert.equal(
      (
        await api()
          .patch(`/orgs/${owner.organizationId}/projects/${extra.body.projectId}/archived`)
          .set(as(owner))
          .send({ archived: true })
      ).status,
      204,
    );

    const visible = await api().get(`/orgs/${owner.organizationId}/projects`).set(as(owner));
    assert.equal(
      visible.body.some((project: { id: string }) => project.id === extra.body.projectId),
      false,
    );
    const all = await api().get(`/orgs/${owner.organizationId}/projects?includeArchived=true`).set(as(owner));
    assert.equal(
      all.body.some((project: { id: string }) => project.id === extra.body.projectId),
      true,
    );
  });

  test("un editor no puede archivar", async () => {
    const editor = await signUp("editor@example.com");
    await context.repositories.memberships.save({
      organizationId: owner.organizationId,
      userId: editor.userId,
      role: "editor",
      createdAt: new Date(),
    });
    const response = await api()
      .patch(`/orgs/${owner.organizationId}/projects/${projectId}/archived`)
      .set(as(editor))
      .send({ archived: true });
    assert.equal(response.status, 403);
  });
});

describe("aislamiento de proyectos entre organizaciones", () => {
  test("un id de otra organización es 404 y no 403", async () => {
    // 403 would confirm the id is real, which is a cross-tenant oracle: an attacker enumerating
    // ids could map another customer's projects without ever reading one.
    const response = await api().get(`/orgs/${outsider.organizationId}/projects/${projectId}`).set(as(outsider));
    assert.equal(response.status, 404);
    assert.match(response.body.type, /project-not-found$/);
  });

  test("tampoco se puede importar un contrato en un proyecto ajeno", async () => {
    const response = await api()
      .post(`/orgs/${outsider.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(outsider))
      .send({ source: { kind: "inline", raw: tinySpec } });
    assert.equal(response.status, 404);
    assert.equal(context.repositories.specs.versions.size, 0);
  });

  test("y un ajeno sin membresía recibe 403 antes de llegar al proyecto", async () => {
    const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(outsider));
    assert.equal(response.status, 403);
  });
});

describe("importación de un contrato", () => {
  test("un documento inline se importa y se activa solo", async () => {
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: tinySpec } });
    assert.equal(response.status, 201);
    assert.equal(response.body.operationCount, 2);
    assert.equal(response.body.unchanged, false);
    // The first import activates itself whatever the flag says: a project whose only contract is
    // not the active one has nothing to run, and nobody ever means that.
    assert.equal(response.body.activated, true);
  });

  test("las operaciones quedan consultables con sus parámetros compartidos", async () => {
    const response = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/operations`).set(as(owner));
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.operations.map((operation: { id: string }) => operation.id),
      ["listPosts", "getPost"],
    );
    const detail = response.body.operations.find((operation: { id: string }) => operation.id === "getPost");
    assert.deepEqual(detail.parameters, ["slug"]);
  });

  test("reimportar el mismo documento no crea una segunda versión", async () => {
    // Identical bytes resolve to the existing row, which is what lets a scheduled drift check
    // run often without growing the table.
    const before = context.repositories.specs.versions.size;
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: tinySpec } });
    assert.equal(response.body.unchanged, true);
    assert.equal(context.repositories.specs.versions.size, before);
  });

  test("un documento que no es OpenAPI 3 se rechaza con 422 y campos nombrados", async () => {
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: 'swagger: "2.0"\ninfo: {}\npaths: {}\n' } });
    assert.equal(response.status, 422);
    assert.match(response.body.type, /spec-invalid$/);
    assert.ok(response.body.errors.some((error: { detail: string }) => /Swagger 2.0/.test(error.detail)));
  });

  test("un documento vacío se rechaza", async () => {
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: "   " } });
    assert.equal(response.status, 422);
  });

  test("kind url sin url es 422, no un 500 más adelante", async () => {
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "url" } });
    assert.equal(response.status, 422);
    assert.ok(response.body.errors.some((error: { field: string }) => error.field === "source.url"));
  });

  test("importar por URL pasa por el guard de red", async () => {
    context.http.reply("https://api.example.com/openapi.json", tinySpec);
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "url", url: "https://api.example.com/openapi.json" }, activate: false });
    assert.equal(response.status, 201);
    // Not `fetch` directly: every outbound request a customer can aim goes through the one
    // place where the SSRF policy is applied.
    assert.ok(context.http.requested.includes("https://api.example.com/openapi.json"));
  });

  test("el listado de versiones no incluye el documento crudo", async () => {
    // Ten versions of a 120 KB contract is 1.2 MB the browser has no use for.
    const response = await api()
      .get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner));
    assert.equal(response.status, 200);
    assert.ok(response.body.versions.length > 0);
    assert.equal("raw" in response.body.versions[0], false);
  });

  test("un contrato de 118 KB entra: el tope de Express por defecto no alcanzaba", async () => {
    // Express parses at most 100 KB by default, and Digital Catalog's contract is 118 KB, so the
    // 8 MB the DTO advertised was a lie the first real document exposed.
    const padded = `${tinySpec}# ${"x".repeat(150 * 1024)}\n`;
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: padded }, activate: false });
    assert.equal(response.status, 201);
  });

  test("y uno que supera el tope responde 413, no 500", async () => {
    // `body-parser` rejects with a plain Error carrying `status`, not a Nest HttpException:
    // without the filter branch this arrived as an internal error, which tells the caller
    // nothing about what to do.
    const enormous = `${tinySpec}# ${"x".repeat(9 * 1024 * 1024)}\n`;
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: enormous } });
    assert.equal(response.status, 413);
    assert.equal(response.body.title, "Cuerpo demasiado grande");
  });

  test("un viewer puede leer operaciones pero no importar", async () => {
    const viewer = await signUp("viewer-projects@example.com");
    await context.repositories.memberships.save({
      organizationId: owner.organizationId,
      userId: viewer.userId,
      role: "viewer",
      createdAt: new Date(),
    });
    assert.equal(
      (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/operations`).set(as(viewer))).status,
      200,
    );
    const attempt = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`)
      .set(as(viewer))
      .send({ source: { kind: "inline", raw: tinySpec } });
    assert.equal(attempt.status, 403);
  });
});

describe("drift del contrato", () => {
  test("el mismo documento no reporta cambios", async () => {
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-drift-check`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: tinySpec } });
    assert.equal(response.status, 200);
    assert.equal(response.body.unchanged, true);
  });

  test("una operación que desaparece se reporta como rompedora y no se activa nada", async () => {
    // This is the capability the coupled dashboard structurally could not have: with the
    // operation table compiled into the bundle, "the contract changed" and "the contract is
    // fine" produced identical output — a green matrix.
    const shrunk = tinySpec.replace(/ {2}\/posts\/\{slug\}:[\s\S]*$/, "");
    const before = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner))).body.contract
      .versionId;

    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-drift-check`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: shrunk } });
    assert.equal(response.status, 200);
    assert.equal(response.body.unchanged, false);
    assert.equal(response.body.breaking.length, 1);
    assert.equal(response.body.breaking[0].id, "getPost");

    const after = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}`).set(as(owner))).body.contract
      .versionId;
    assert.equal(after, before, "un drift check no debe cambiar el contrato activo");
  });

  test("volver a una versión anterior es un solo comando", async () => {
    // When v1.9 turns the matrix red, the first question is whether the API broke or the
    // contract moved. Switching the active version answers it without a re-import.
    const versions = (
      await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner))
    ).body;
    const target = versions.versions.find((version: { id: string }) => version.id !== versions.active);
    assert.equal(
      (
        await api()
          .post(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions/${target.id}/activate`)
          .set(as(owner))
      ).status,
      204,
    );
    const now = (await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner)))
      .body;
    assert.equal(now.active, target.id);
  });

  test("activar una versión de otro proyecto es 404", async () => {
    const other = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Otro" });
    const versions = (
      await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/spec-versions`).set(as(owner))
    ).body;
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${other.body.projectId}/spec-versions/${versions.active}/activate`)
      .set(as(owner));
    assert.equal(response.status, 404);
  });
});

/**
 * A contract behind authentication, and what the project remembers about it.
 *
 * Before this the headers were sent and thrown away, so every re-import and every drift check
 * needed somebody to type the credential again — which meant a scheduled drift check either did
 * not exist or carried a bearer token in its request body.
 */
describe("un contrato detrás de autenticación", () => {
  const url = "https://privado.example.com/openapi.yaml";
  let secured: string;

  before(async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Privado" });
    secured = created.body.projectId;
    context.http.replyBehindAuth(url, tinySpec, "Authorization", "Bearer secreto-del-contrato");
  });

  const importSpec = (body: object) =>
    api().post(`/orgs/${owner.organizationId}/projects/${secured}/spec-versions`).set(as(owner)).send(body);

  test("sin cabeceras no se puede leer, y el error habla del contrato", async () => {
    const response = await importSpec({ source: { kind: "url", url } });
    assert.equal(response.status, 422);
    assert.match(response.body.type, /spec-unreachable$/);
    assert.match(response.body.errors[0].detail, /401/);
  });

  test("con cabeceras se importa, y la siguiente vez ya no hacen falta", async () => {
    assert.equal(
      (await importSpec({ source: { kind: "url", url, headers: { Authorization: "Bearer secreto-del-contrato" } } }))
        .status,
      201,
    );

    // La segunda importación no las lleva y funciona igual: es lo que permite un drift check
    // programado sin un secreto dentro de la petición.
    const repeat = await importSpec({ source: { kind: "url", url } });
    assert.equal(repeat.status, 201);
    assert.equal(repeat.body.unchanged, true);
    assert.equal(context.http.calls.at(-1)?.headers.authorization, "Bearer secreto-del-contrato");
  });

  test("se guardan cifradas y no salen por ninguna consulta", async () => {
    const stored = [...context.repositories.specs.sources.values()].find((source) => source.location === url);
    assert.ok(stored?.headersCiphertext, "la cabecera tiene que quedar guardada");
    assert.doesNotMatch(stored.headersCiphertext, /secreto-del-contrato/, "cifrada, no en claro");
    // El proyecto se puede leer entero sin que aparezca.
    const project = JSON.stringify(
      (await api().get(`/orgs/${owner.organizationId}/projects/${secured}`).set(as(owner))).body,
    );
    assert.doesNotMatch(project, /secreto-del-contrato|headersCiphertext/);
  });

  test("una URL distinta no hereda la credencial de otra", async () => {
    // Si no, cualquiera con permiso de editor apunta la importación a su propio servidor y recibe
    // el token de staging de otro en la petición.
    const ajena = "https://atacante.example.com/openapi.yaml";
    context.http.reply(ajena, tinySpec);
    await importSpec({ source: { kind: "url", url: ajena } });
    assert.deepEqual(context.http.calls.at(-1)?.headers, {}, "no se manda nada guardado contra otra dirección");
  });

  test("una sola fila por origen, no una por importación", async () => {
    // Si no, un proyecto que reimporta cada noche acumula una fila por noche apuntando al mismo
    // sitio, y las cabeceras guardadas contra la última son las únicas que alguien encuentra.
    const rows = [...context.repositories.specs.sources.values()].filter(
      (source) => source.projectId === secured && source.location === url,
    );
    assert.equal(rows.length, 1);
  });

  test("sin decir de dónde, el proyecto relee donde leyó la última vez", async () => {
    const drift = await api()
      .post(`/orgs/${owner.organizationId}/projects/${secured}/spec-drift-check`)
      .set(as(owner))
      .send({});
    assert.equal(drift.status, 200, JSON.stringify(drift.body));
    assert.equal(drift.body.unchanged, true);
  });

  test("y un proyecto cuya última fuente fue un pegado lo dice en vez de leer la nada", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Pegado" });
    await api()
      .post(`/orgs/${owner.organizationId}/projects/${created.body.projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: tinySpec } });
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${created.body.projectId}/spec-drift-check`)
      .set(as(owner))
      .send({});
    assert.equal(response.status, 409);
    assert.match(response.body.type, /spec-source-not-repeatable$/);
  });

  test("un proyecto sin ninguna fuente pide que le digan de dónde leer", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Vacío" });
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${created.body.projectId}/spec-versions`)
      .set(as(owner))
      .send({});
    assert.equal(response.status, 409);
    assert.match(response.body.type, /no-spec-source$/);
  });
});

describe("el contrato real de Digital Catalog", { skip: HAS_REAL_SPEC ? false : `sin ${SPEC_PATH}` }, () => {
  test("se importa por la API y produce las 46 operaciones", async () => {
    // The criterion of this phase. The same document the coupled dashboard had compiled into
    // its bundle, read at runtime, through the HTTP surface, into a project that owns it.
    const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Ara" });
    const response = await api()
      .post(`/orgs/${owner.organizationId}/projects/${project.body.projectId}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "upload", filename: "bundled.yaml", raw: readFileSync(SPEC_PATH, "utf8") } });

    assert.equal(response.status, 201);
    assert.equal(response.body.operationCount, 46);
    assert.deepEqual(response.body.problems, [], "el contrato del cliente no debería producir avisos");

    const operations = await api()
      .get(`/orgs/${owner.organizationId}/projects/${project.body.projectId}/operations`)
      .set(as(owner));
    assert.equal(operations.body.operations.length, 46);
    assert.equal(operations.body.contractVersion, "1.8.0");
    assert.deepEqual(operations.body.tags.sort(), [
      "Categories",
      "Health",
      "Prices",
      "Product Categories",
      "Product Projections",
      "Products",
      "Store Assortments",
      "Stores",
    ]);
  });
});
