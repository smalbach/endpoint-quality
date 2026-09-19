/**
 * La documentación publicada por sus bordes: los cuerpos que no son JSON, la autenticación heredada
 * o por query, las filas antiguas sin campos opcionales, el orden de los grupos; y los comandos
 * cuando el nombre se repite, se llega al tope o el sitio no existe.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { blankEndpoint, type Endpoint, type EndpointBody } from "@/modules/endpoints/domain/model";
import { blankExample } from "@/modules/endpoints/domain/examples";
import { UNTAGGED_GROUP, buildDocPage, docAuth, docBody, docUrl } from "@/modules/docs/domain/doc-page";
import {
  CreateDocSiteCommand,
  CreateDocSiteHandler,
  DeleteDocSiteCommand,
  DeleteDocSiteHandler,
  RotateDocSiteKeyCommand,
  RotateDocSiteKeyHandler,
  UpdateDocSiteCommand,
  UpdateDocSiteHandler,
} from "@/modules/docs/application/commands/manage-doc-sites";
import { MAX_DOC_SITES_PER_PROJECT } from "@/modules/docs/domain/model";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import { InMemoryDocSiteRepository } from "../support/in-memory-doc-sites";
import { InMemoryProjectRepository } from "../support/in-memory-repositories";

const NOW = new Date("2026-03-01T10:00:00.000Z");
let sequence = 0;
function endpoint(patch: Partial<Endpoint> = {}): Endpoint {
  return {
    ...blankEndpoint({
      id: `e-${(sequence += 1)}`,
      projectId: "p-1",
      origin: "manual",
      orderIndex: 0,
      now: NOW,
      actorId: "u",
    }),
    ...patch,
  };
}
const body = (patch: Partial<EndpointBody>): EndpointBody => ({
  mode: "none",
  text: "",
  contentType: "",
  fields: [],
  ...patch,
});

describe("la página, por sus bordes", () => {
  test("form-data y urlencoded: sin filas apagadas ni sin nombre, y el fichero sin valor", () => {
    const fields = [
      { name: "nombre", value: "ana", kind: "text" as const, enabled: true },
      { name: "foto", value: "/tmp/foto.png", kind: "file" as const, enabled: true },
      { name: "apagado", value: "x", kind: "text" as const, enabled: false },
      { name: "  ", value: "x", kind: "text" as const, enabled: true },
    ];
    assert.deepEqual(docBody(body({ mode: "form-data", fields })), {
      mode: "form-data",
      contentType: "multipart/form-data",
      text: "",
      fields: [
        { name: "nombre", value: "ana", file: false },
        { name: "foto", value: "", file: true },
      ],
      masked: [],
    });
    assert.equal(docBody(body({ mode: "x-www-form-urlencoded", fields }))!.contentType, "application/x-www-form-urlencoded");
  });

  test("binario: solo que va un fichero", () => {
    assert.deepEqual(docBody(body({ mode: "binary", text: "bytes" })), {
      mode: "binary",
      contentType: "application/octet-stream",
      text: "",
      fields: [],
      masked: [],
    });
  });

  test("GraphQL: la operación tal cual y las variables tapadas; sin variables no hay campo", () => {
    const withVariables = docBody(
      body({ mode: "graphql", text: "query { me { id } }", variables: '{"token":"secreto-de-prueba","id":1}' }),
    )!;
    assert.equal(withVariables.text, "query { me { id } }");
    assert.equal(withVariables.contentType, "application/json");
    assert.ok(!withVariables.variables!.includes("secreto-de-prueba"));
    assert.ok(withVariables.masked.length > 0);
    for (const variables of [undefined, "   "]) {
      const without = docBody(body({ mode: "graphql", text: "{ a }", variables }))!;
      assert.equal("variables" in without, false);
      assert.deepEqual(without.masked, []);
    }
  });

  test("raw sin tipo es texto plano; con tipo, el suyo", () => {
    assert.equal(docBody(body({ mode: "raw", text: "hola" }))!.contentType, "text/plain");
    assert.equal(docBody(body({ mode: "raw", text: "<a/>", contentType: "application/xml" }))!.contentType, "application/xml");
  });

  test("la autenticación: la clave por query, la clave sin nombre, y un proyecto que dice «inherit»", () => {
    const byQuery = docAuth(endpoint({ auth: { type: "apikey", params: { key: " X-Key ", in: "query" } } }), {
      authType: "none",
      apiKeyName: "",
    });
    assert.equal(byQuery.in, "query");
    assert.equal(byQuery.keyName, "X-Key");
    assert.equal(docAuth(endpoint({ auth: { type: "apikey", params: {} } }), { authType: "none", apiKeyName: "" }).keyName, "");
    const inherited = docAuth(endpoint({ auth: { type: "inherit", params: {} } }), {
      authType: "inherit",
      apiKeyName: "",
    });
    assert.equal(inherited.type, "none");
    assert.equal(inherited.in, "header");
  });

  test("docUrl añade la barra que falta", () => {
    assert.equal(docUrl("https://api.test", "v1/x"), "https://api.test/v1/x");
  });

  test("una fila antigua sin campos opcionales sale con valores vacíos, y los grupos sin etiqueta van al final", () => {
    const old = {
      ...endpoint({ path: "/viejo", orderIndex: 0 }),
      description: undefined,
      tags: undefined,
      pathParameters: undefined,
      query: undefined,
      headers: undefined,
    } as unknown as Endpoint;
    const params = endpoint({
      path: "/con/{id}",
      orderIndex: 1,
      tags: [" "],
      pathParameters: [{ name: "id", type: "string", value: undefined, description: undefined } as never, { name: " ", type: "string", value: "", description: "" }],
      query: [
        { name: "page", type: "number", value: "1", description: "La página", required: false, enabled: true } as never,
        { name: "off", type: "string", value: "", description: "", enabled: false } as never,
      ],
    });
    const tagged = endpoint({ path: "/pedidos", orderIndex: 2, tags: ["Pedidos"] });
    const alsoTagged = endpoint({ path: "/clientes", orderIndex: 3, tags: ["Clientes"] });
    const inactive = endpoint({ path: "/borrador", orderIndex: 4, status: "draft" as never });
    const example = blankExample({
      projectId: "p-1",
      endpointId: tagged.id,
      name: "ok",
      request: { method: "GET", url: "https://x.test/pedidos", headers: [], body: { text: "", contentType: "" } },
      response: {
        status: 200,
        headers: undefined as never,
        body: "{}",
        contentType: "application/json",
        durationMs: 1,
      },
      origin: "manual",
      orderIndex: 0,
      now: NOW,
      actorId: "u",
    });
    const page = buildDocPage({
      project: { name: "P", description: undefined as unknown as string, authType: "none", apiKeyName: "" },
      site: { baseUrl: "", intro: "", includeExamples: true },
      endpoints: [alsoTagged, inactive, tagged, params, old],
      examplesOf: (id) => (id === tagged.id ? [example] : []),
      generatedAt: NOW,
    });
    assert.equal(page.description, "");
    assert.deepEqual(
      page.groups.map((group) => [group.tag, group.endpoints.map((entry) => entry.path)]),
      [
        ["Pedidos", ["/pedidos"]],
        ["Clientes", ["/clientes"]],
        [UNTAGGED_GROUP, ["/viejo", "/con/{id}"]],
      ],
    );
    const [oldDoc, paramsDoc] = page.groups[2]!.endpoints;
    assert.equal(oldDoc!.url, "/viejo");
    assert.equal(oldDoc!.description, "");
    assert.deepEqual(oldDoc!.tags, []);
    assert.deepEqual(oldDoc!.pathParameters, []);
    assert.deepEqual(oldDoc!.query, []);
    assert.deepEqual(oldDoc!.headers, []);
    assert.deepEqual(paramsDoc!.pathParameters, [{ name: "id", type: "string", required: true, description: "", example: "" }]);
    assert.deepEqual(paramsDoc!.query, [
      { name: "page", type: "number", required: false, description: "La página", example: "1" },
    ]);
    assert.deepEqual(page.groups[0]!.endpoints[0]!.examples[0]!.headers, []);
    assert.deepEqual(page.counts, { endpoints: 4, documented: 0, examples: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * Los comandos
 * ------------------------------------------------------------------ */

const ORG = "org-1";
const clock = { now: () => NOW };

async function setup() {
  const projects = new InMemoryProjectRepository();
  await projects.save({ id: "p-1", organizationId: ORG, archivedAt: null, deletedAt: null } as unknown as Project);
  const sites = new InMemoryDocSiteRepository();
  const create = new CreateDocSiteHandler(projects, sites, clock);
  const update = new UpdateDocSiteHandler(projects, sites, clock);
  const make = (name: string, visibility: "public" | "private" = "public") =>
    create.execute(new CreateDocSiteCommand(ORG, "p-1", name, visibility, {}, "u"));
  const change = (id: string, input: ConstructorParameters<typeof UpdateDocSiteCommand>[3]) =>
    update.execute(new UpdateDocSiteCommand(ORG, "p-1", id, input));
  return { projects, sites, make, change };
}
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ConflictError || error instanceof NotFoundError || error instanceof InvalidInputError);
  assert.equal((error as { code?: string }).code, expected);
  return true;
};

describe("gestionar documentaciones", () => {
  test("crear: nombre repetido y tope son 409", async () => {
    const { make } = await setup();
    await make(" api ");
    await assert.rejects(make("api"), code("doc-site-duplicate-name"));
    for (let index = 1; index < MAX_DOC_SITES_PER_PROJECT; index += 1) await make(`d${index}`);
    await assert.rejects(make("otra"), code("doc-sites-full"));
  });

  test("cambiar: 404 si no existe, 422 si no vale, 409 si el nombre es de otra", async () => {
    const { make, change } = await setup();
    await assert.rejects(change("no", { name: "x" }), code("doc-site-not-found"));
    const a = await make("a");
    await make("b");
    await assert.rejects(change(a.site.id, { name: "  " }), InvalidInputError);
    await assert.rejects(change(a.site.id, { name: "b" }), code("doc-site-duplicate-name"));
  });

  test("cambiar sin tocar nada deja todo; cambiar la base la normaliza, la intro se recorta", async () => {
    const { make, change } = await setup();
    const a = await make("a");
    const same = await change(a.site.id, { name: "a" });
    assert.equal(same.name, "a");
    assert.equal("apiKey" in same, false);
    const changed = await change(a.site.id, {
      baseUrl: "https://api.test/",
      intro: "  hola  ",
      includeExamples: true,
      enabled: false,
    });
    assert.equal(changed.baseUrl, "https://api.test");
    assert.equal(changed.intro, "hola");
    assert.equal(changed.includeExamples, true);
    assert.equal(changed.enabled, false);
    const kept = await change(a.site.id, {});
    assert.equal(kept.baseUrl, "https://api.test");
    assert.equal(kept.intro, "hola");
    assert.equal(kept.enabled, false);
  });

  test("pasar a privada crea la clave una vez; volver a privada no la vuelve a enseñar", async () => {
    const { make, change, sites } = await setup();
    const a = await make("a");
    const closed = await change(a.site.id, { visibility: "private" });
    assert.ok(closed.apiKey);
    const hash = (await sites.findById("p-1", a.site.id))!.apiKeyHash;
    await change(a.site.id, { visibility: "public" });
    const again = await change(a.site.id, { visibility: "private" });
    assert.equal("apiKey" in again, false);
    assert.equal((await sites.findById("p-1", a.site.id))!.apiKeyHash, hash);
  });

  test("rotar o borrar una que no existe es un 404; rotar la de una privada cambia la clave", async () => {
    const { projects, sites, make } = await setup();
    const rotate = new RotateDocSiteKeyHandler(projects, sites, clock);
    await assert.rejects(rotate.execute(new RotateDocSiteKeyCommand(ORG, "p-1", "no")), code("doc-site-not-found"));
    await assert.rejects(
      new DeleteDocSiteHandler(projects, sites).execute(new DeleteDocSiteCommand(ORG, "p-1", "no")),
      code("doc-site-not-found"),
    );
    const created = await make("privada", "private");
    const rotated = await rotate.execute(new RotateDocSiteKeyCommand(ORG, "p-1", created.site.id));
    assert.ok(rotated.apiKey);
    assert.notEqual(rotated.apiKey, created.apiKey);
  });
});
