/**
 * The generator against a project that is not Digital Catalog.
 *
 * The parity test proves nothing was lost. This one proves something was gained: the same
 * engine, handed a two-endpoint blog API with different parameter names, different envelope,
 * different scopes and no latency budgets at all, produces cases that make sense for *it*.
 *
 * If these two files ever disagree about what the engine does, the configuration is not
 * configuration — it is the old constants wearing a different hat.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig, type ProjectConfigInput } from "../src/config.ts";
import { resolveOperations, scenariosFor, runnableScenarios } from "../src/scenarios.ts";
import { budgetFor } from "../src/budgets.ts";
import type { Operation } from "../src/types.ts";

const operations: Operation[] = [
  {
    id: "listPosts",
    method: "GET",
    path: "/posts",
    summary: "List posts",
    tag: "Posts",
    statuses: [200, 401],
    parameters: ["author", "published", "page"],
  },
  {
    id: "getPost",
    method: "GET",
    path: "/posts/{slug}",
    summary: "Get a post",
    tag: "Posts",
    statuses: [200, 404],
    parameters: ["slug"],
  },
  {
    id: "createPost",
    method: "POST",
    path: "/posts",
    summary: "Create a post",
    tag: "Posts",
    statuses: [201, 401, 409, 422],
    parameters: [],
  },
  {
    id: "deletePost",
    method: "DELETE",
    path: "/posts/{slug}",
    summary: "Delete a post",
    tag: "Posts",
    statuses: [204, 401, 403, 404],
    parameters: ["slug"],
  },
];

/** Escrito aparte para poder derivar de él: una prueba de abajo lo reusa cambiando una sección.
 * Anotado, no inferido: sin el tipo, `methods: ["DELETE"]` se infiere como `string[]` y deja de
 * encajar donde el motor espera métodos HTTP. */
const blogInput: ProjectConfigInput = {
  locale: "en",
  parameterSamples: {
    author: ["ada", "nobody"],
    published: ["true", "false"],
    page: ["1", { value: "0", expectedStatus: 400, description: "Page numbering starts at 1." }],
  },
  pathDefaults: { slug: "hello-world" },
  missingIdValue: "does-not-exist",
  bodyTemplates: {
    createPost: {
      body: { slug: "new-post", title: "New post" },
      conflictBody: { slug: "hello-world", title: "Duplicate" },
    },
  },
  implemented: ["listPosts", "getPost"],
  scopes: { default: "posts:read" },
  envelope: {
    rules: [{ id: "delete", match: { methods: ["DELETE"] }, shape: "No body" }],
    fallbackShape: "{ post }",
    errorShape: "RFC7807",
  },
};
const blog = defineProjectConfig(blogInput);

const resolved = resolveOperations(operations, blog);
const byId = (id: string) => resolved.find((operation) => operation.id === id)!;
const caseIds = (id: string) => scenariosFor(byId(id), blog).map((scenario) => scenario.id);

test("una colección genera un caso por valor de cada filtro, en aislamiento", () => {
  assert.deepEqual(caseIds("listPosts"), [
    "default",
    "author-ada",
    "author-nobody",
    "published-true",
    "published-false",
    "page-1",
    "page-0",
    "auth-none",
  ]);
});

test("el estado esperado sale del sample, no de un if sobre el nombre del parámetro", () => {
  const cases = scenariosFor(byId("listPosts"), blog);
  assert.equal(cases.find((scenario) => scenario.id === "page-1")?.expectedStatus, 200);
  assert.equal(cases.find((scenario) => scenario.id === "page-0")?.expectedStatus, 400);
  assert.equal(cases.find((scenario) => scenario.id === "page-0")?.description, "Page numbering starts at 1.");
});

test("sin escenarios condicionales configurados no se inventa ninguno", () => {
  // The geographic block and the corrupt cursor were Digital Catalog's, and a blog gets neither.
  assert.ok(!caseIds("listPosts").some((id) => id.startsWith("geo-") || id.endsWith("-invalid")));
});

test("el 403 solo se genera donde el contrato lo declara", () => {
  // listPosts declares 401 but not 403; deletePost declares both.
  assert.ok(caseIds("listPosts").includes("auth-none"));
  assert.ok(!caseIds("listPosts").includes("auth-insufficient"));
  assert.ok(caseIds("deletePost").includes("auth-insufficient"));
});

test("el 409 necesita que el contrato lo declare y que exista un payload que colisione", () => {
  assert.ok(caseIds("createPost").includes("conflict"));
  const withoutConflictBody = defineProjectConfig({
    ...blog,
    bodyTemplates: { createPost: { body: { slug: "new-post" } } },
  });
  const operation = resolveOperations(operations, withoutConflictBody).find((item) => item.id === "createPost")!;
  assert.ok(
    !scenariosFor(operation, withoutConflictBody)
      .map((scenario) => scenario.id)
      .includes("conflict"),
  );
});

test("los identificadores del proyecto se usan tal cual, sin asumir enteros", () => {
  const cases = scenariosFor(byId("getPost"), blog);
  assert.deepEqual(cases.find((scenario) => scenario.id === "found")?.parameters, { slug: "hello-world" });
  assert.deepEqual(cases.find((scenario) => scenario.id === "not-found")?.parameters, { slug: "does-not-exist" });
});

test("los textos siguen el locale del proyecto", () => {
  const found = scenariosFor(byId("getPost"), blog).find((scenario) => scenario.id === "found");
  assert.equal(found?.name, "Existing resource");
  const insufficient = scenariosFor(byId("deletePost"), blog).find((scenario) => scenario.id === "auth-insufficient");
  assert.equal(insufficient?.description, "A posts:read token does not reach this operation.");
});

test("sin presupuestos configurados no hay aserción de latencia", () => {
  // The decision that survives from the coupled version: a target nobody published is not a
  // target that passes.
  assert.equal(budgetFor(blog, "GET", "/posts", "/posts"), null);
});

test("implemented es un hecho sobre el código, no sobre el contrato", () => {
  assert.equal(byId("listPosts").implemented, true);
  assert.equal(byId("createPost").implemented, false);
  // A project that has not said assumes everything is routed rather than inventing a set.
  const unsaid = defineProjectConfig({ implemented: null });
  assert.ok(resolveOperations(operations, unsaid).every((operation) => operation.implemented));
});

test("el envelope cae al fallback del proyecto cuando ninguna regla casa", () => {
  assert.equal(byId("getPost").responseShape, "{ post }");
  assert.equal(byId("deletePost").responseShape, "No body");
});

test("los casos de autorización se ocultan contra un entorno que no la aplica", () => {
  const withAuth = runnableScenarios(byId("deletePost"), blog, true).map((scenario) => scenario.id);
  const withoutAuth = runnableScenarios(byId("deletePost"), blog, false).map((scenario) => scenario.id);
  assert.ok(withAuth.includes("auth-none"));
  assert.ok(!withoutAuth.some((id) => id.startsWith("auth-")));
});

test("un caso duplicado por id se descarta quedándose con el primero", () => {
  // `getPost` declares 404 and has a path parameter, so the write-edge generator would emit a
  // second `not-found` on top of the one the detail GET already produced.
  const ids = caseIds("getPost");
  assert.equal(ids.filter((id) => id === "not-found").length, 1);
  const notFound = scenariosFor(byId("getPost"), blog).find((scenario) => scenario.id === "not-found");
  assert.equal(notFound?.description, "Checks the 404 and the Problem Details format.");
});

/**
 * A GET with no identifier in its path gets no `not-found` case.
 *
 * Every contract has a `/health`, and it used to come back with a `not-found` case whose request
 * was byte for byte the `found` one: there is no placeholder to substitute, so both asked the same
 * URL and expected 200 and 404 of it. One had to be red on every run of every project — a fault
 * reported against an endpoint that was answering correctly, which is the exact failure this
 * product exists to remove from somebody's suite.
 */
test("un GET sin identificador en la ruta no genera un caso not-found", () => {
  const health: Operation = {
    id: "healthCheck",
    method: "GET",
    path: "/health",
    summary: "Health",
    tag: "Health",
    statuses: [200, 503],
    parameters: [],
  };
  const [resolved] = resolveOperations([health], blog);
  assert.deepEqual(
    scenariosFor(resolved, blog).map((scenario) => scenario.id),
    ["found"],
  );
});

test("un GET con identificador pero sin 404 declarado tampoco lo genera", () => {
  // The rule the list scenarios already followed. Asserting a status the contract never promised
  // is a test of the document, not of the API.
  const singleton: Operation = {
    id: "getSettings",
    method: "GET",
    path: "/tenants/{tenant}/settings",
    summary: "Settings",
    tag: "Admin",
    statuses: [200],
    parameters: ["tenant"],
  };
  const [resolved] = resolveOperations([singleton], blog);
  assert.deepEqual(
    scenariosFor(resolved, blog).map((scenario) => scenario.id),
    ["found"],
  );
});

test("y con las dos cosas sí lo genera, con el identificador inexistente del proyecto", () => {
  const [resolved] = resolveOperations([operations[1]], blog);
  const notFound = scenariosFor(resolved, blog).find((scenario) => scenario.id === "not-found");
  assert.ok(notFound, "getPost declara 404 y tiene {slug}: el caso debe existir");
  assert.equal(notFound.parameters?.slug, "does-not-exist");
});

/**
 * Lo que un endpoint dice de sus propios parámetros.
 *
 * Las listas del proyecto van por **nombre de parámetro**, y eso vale hasta que dos endpoints usan
 * el mismo nombre para cosas distintas — que es siempre, en cuanto el contrato crece—. `slug` en
 * un blog es un artículo; `slug` en su sección de autores es una persona. Una sola lista tiene que
 * estar mal para uno de los dos, y el caso que sale es un 404 achacado a la API.
 *
 * Lo mismo con los marcadores de ruta: `pathDefaults.slug` es un único recurso que existe, para un
 * contrato con una docena que se llaman igual.
 */
describe("un endpoint puede decir lo suyo sobre sus parámetros", () => {
  const authors: Operation[] = [
    ...operations,
    {
      id: "getAuthor",
      method: "GET",
      path: "/authors/{slug}",
      summary: "Get",
      tag: "Authors",
      statuses: [200, 404],
      parameters: ["slug"],
    },
  ];
  const withOverrides = defineProjectConfig({
    ...blogInput,
    operationParameters: {
      // El mismo nombre, otro recurso: el autor que existe no es el artículo que existe.
      getAuthor: { pathDefaults: { slug: "ada-lovelace" }, missingIdValue: "nadie" },
      // Y el mismo nombre de filtro, otros valores.
      listPosts: { parameterSamples: { author: ["turing"] } },
    },
  });

  const caseFor = (config: typeof blog, list: Operation[], operationId: string, scenarioId: string) => {
    const operation = resolveOperations(list, config).find((entry) => entry.id === operationId)!;
    return scenariosFor(operation, config).find((entry) => entry.id === scenarioId)!;
  };

  test("el recurso que existe es el suyo, no el del proyecto", () => {
    assert.equal(caseFor(withOverrides, authors, "getAuthor", "found").parameters?.slug, "ada-lovelace");
    // Y el del proyecto sigue valiendo para quien no dice nada.
    assert.equal(caseFor(withOverrides, authors, "getPost", "found").parameters?.slug, "hello-world");
  });

  test("el que no existe también es suyo: un id libre en una colección está cogido en otra", () => {
    assert.equal(caseFor(withOverrides, authors, "getAuthor", "not-found").parameters?.slug, "nadie");
    assert.equal(caseFor(withOverrides, authors, "getPost", "not-found").parameters?.slug, "does-not-exist");
  });

  test("los valores de un filtro también", () => {
    const ids = resolveOperations(authors, withOverrides)
      .filter((entry) => entry.id === "listPosts")
      .flatMap((entry) => scenariosFor(entry, withOverrides).map((scenario) => scenario.id));
    assert.ok(ids.includes("author-turing"), ids.join(", "));
    assert.ok(!ids.includes("author-ada"), "la lista del proyecto no se acumula con la del endpoint");
  });

  test("sin decir nada, nada cambia", () => {
    assert.equal(caseFor(blog, operations, "getPost", "found").parameters?.slug, "hello-world");
    assert.equal(caseFor(blog, operations, "getPost", "not-found").parameters?.slug, "does-not-exist");
  });
});
