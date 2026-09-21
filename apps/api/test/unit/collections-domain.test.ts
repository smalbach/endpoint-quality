/**
 * El árbol de una colección y su traducción desde y hacia el fichero de Postman.
 *
 * Es la parte que decide si una colección de alguien sobrevive al viaje: el orden, las carpetas,
 * los scripts, de quién hereda cada petición, y qué no se guarda porque es un secreto escrito a
 * mano. Todo puro, así que se prueba sin base de datos y sin red.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { RequestAuth } from "@eq/runner-core";
import type { BodyMode } from "@/modules/endpoints/domain/model";

import {
  contains,
  countItems,
  emptyFolder,
  emptyRequest,
  findItem,
  flatten,
  insertItem,
  replaceItem,
  requestsOf,
  resolveItemAuth,
  trailName,
  type CollectionItem,
} from "@/modules/collections/domain/model";
import { readPostmanFile, splitUrl, writePostmanFile } from "@/modules/collections/domain/postman";
import {
  MAX_COLLECTION_DEPTH,
  safeParseCollectionDocument,
  collectionRequestSchema,
} from "@/modules/collections/domain/schema";
import { composeScript } from "@/modules/collections/infrastructure/collection-runner";

const request = (id: string, name = id): CollectionItem => ({
  id,
  kind: "request",
  name,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: null,
  request: emptyRequest(),
  items: [],
});

const folder = (id: string, items: CollectionItem[] = []): CollectionItem => ({ ...emptyFolder(id, id), items });

describe("el árbol", () => {
  const tree = [folder("f1", [request("a"), folder("f2", [request("b")])]), request("c")];

  test("cuenta lo que hay dentro a cualquier profundidad", () => {
    assert.deepEqual(countItems(tree), { folders: 2, requests: 3 });
  });

  test("se recorre en el orden en que se corre: profundidad primero", () => {
    assert.deepEqual(
      flatten(tree).map((entry) => entry.item.id),
      ["f1", "a", "f2", "b", "c"],
    );
    assert.deepEqual(
      requestsOf(tree).map((entry) => entry.item.id),
      ["a", "b", "c"],
    );
  });

  test("un nodo se encuentra con el camino de carpetas que lo contiene", () => {
    const found = findItem(tree, "b");
    assert.deepEqual(found?.trail.map((item) => item.id), ["f1", "f2"]);
    assert.equal(trailName(found!.trail), "f1 / f2");
    assert.equal(findItem(tree, "no-está"), null);
    assert.equal(trailName([]), "");
  });

  test("reemplazar cambia un nodo donde esté, y devolver null lo quita", () => {
    const renamed = replaceItem(tree, "b", (item) => ({ ...item, name: "otro" }));
    assert.equal(findItem(renamed, "b")?.item.name, "otro");
    const without = replaceItem(tree, "f2", () => null);
    assert.equal(findItem(without, "f2"), null);
    assert.equal(findItem(without, "b"), null, "se lleva lo que tenía dentro");
    // Un id que no está deja el árbol igual.
    assert.deepEqual(replaceItem(tree, "nada", (item) => item), tree);
  });

  test("insertar mete en la carpeta que se diga, o al final de la raíz", () => {
    const inRoot = insertItem(tree, null, request("nuevo"));
    assert.equal(inRoot[inRoot.length - 1].id, "nuevo");
    const inside = insertItem(tree, "f2", request("dentro"));
    assert.deepEqual(findItem(inside, "dentro")?.trail.map((item) => item.id), ["f1", "f2"]);
    // Una petición no contiene nada: pedirlo no mete el nodo en ningún sitio.
    assert.equal(findItem(insertItem(tree, "c", request("x")), "x"), null);
  });

  test("contains dice si una carpeta tiene dentro a otro nodo", () => {
    assert.equal(contains(tree, "f1", "b"), true);
    assert.equal(contains(tree, "f2", "a"), false);
    assert.equal(contains(tree, "f1", "no-está"), false);
  });
});

describe("de quién hereda la autenticación", () => {
  const collection = { type: "bearer" as const, params: { token: "{{t}}" } };

  test("la suya manda; si hereda, la carpeta más interna que diga algo; si no, la colección", () => {
    const outer = { ...emptyFolder("out", "out"), auth: { type: "basic" as const, params: {} } };
    const inner = { ...emptyFolder("in", "in"), auth: { type: "inherit" as const, params: {} } };
    assert.equal(resolveItemAuth({ type: "apikey", params: {} }, [outer, inner], collection).type, "apikey");
    assert.equal(resolveItemAuth({ type: "inherit", params: {} }, [outer, inner], collection).type, "basic");
    assert.equal(resolveItemAuth({ type: "inherit", params: {} }, [], collection).type, "bearer");
  });

  test("una carpeta con `none` corta la herencia: es una decisión, no un hueco", () => {
    const off = { ...emptyFolder("off", "off"), auth: { type: "none" as const, params: {} } };
    assert.equal(resolveItemAuth({ type: "inherit", params: {} }, [off], collection).type, "none");
  });

  test("sin nada arriba queda `inherit`, que aquí es la del proyecto", () => {
    const plain = { ...emptyFolder("p", "p"), auth: null };
    assert.equal(
      resolveItemAuth({ type: "inherit", params: {} }, [plain], { type: "inherit", params: {} }).type,
      "inherit",
    );
  });
});

describe("la URL, partida como la parte Postman", () => {
  test("las filas del objeto mandan: traen el apagado que la cadena no puede decir", () => {
    assert.deepEqual(
      splitUrl({
        raw: "{{base}}/x?a=1&b=2",
        query: [
          { key: "a", value: "1" },
          { key: "b", value: "2", disabled: true },
        ],
      }),
      { url: "{{base}}/x", query: [{ name: "a", value: "1", enabled: true }, { name: "b", value: "2", enabled: false }] },
    );
  });

  test("sin filas se lee de la cadena, con los escapes deshechos", () => {
    assert.deepEqual(splitUrl("https://api/x?q=hola+mundo&t=a%20b"), {
      url: "https://api/x",
      query: [
        { name: "q", value: "hola mundo", enabled: true },
        { name: "t", value: "a b", enabled: true },
      ],
    });
  });

  test("un escape roto se deja como está, y una URL sin query no trae filas", () => {
    assert.deepEqual(splitUrl("https://api/x?q=%E0%A4%A"), {
      url: "https://api/x",
      query: [{ name: "q", value: "%E0%A4%A", enabled: true }],
    });
    assert.deepEqual(splitUrl("https://api/x"), { url: "https://api/x", query: [] });
    assert.deepEqual(splitUrl(42), { url: "", query: [] });
  });
});

describe("leer un fichero de Postman", () => {
  const file = {
    info: { name: "Tienda", description: { content: "Con descripción de objeto" } },
    auth: { type: "bearer", bearer: [{ key: "token", value: "escrito-a-mano" }] },
    variable: [{ key: "base", value: "https://api", disabled: true }],
    event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }],
    item: [
      {
        name: "Carpeta",
        description: "Texto suelto",
        auth: { type: "noauth" },
        event: [{ listen: "test", script: { exec: ["pm.test('x', () => {})"] } }],
        item: [
          {
            name: "Crear",
            request: {
              method: "post",
              header: [{ key: "X-Uno", value: "1" }, { key: "X-Dos", value: "2", disabled: true }],
              url: { raw: "{{base}}/x/:id", variable: [{ key: "id", value: "7" }] },
              body: { mode: "raw", raw: '{"a":1}', options: { raw: { language: "json" } } },
            },
          },
          { name: "Sin URL", request: { method: "GET" } },
          { name: "Raro", request: { method: "PURGE", url: { raw: "{{base}}/x" } } },
          { name: "Desconocida", request: { method: "GET", url: "{{base}}/y", auth: { type: "inventada" } } },
        ],
      },
    ],
  };

  test("el árbol es el árbol: carpeta, peticiones, scripts y descripciones", () => {
    const read = readPostmanFile(JSON.stringify(file))!;
    assert.equal(read.name, "Tienda");
    assert.equal(read.description, "Con descripción de objeto");
    assert.equal(read.document.preRequestScript, "console.log(1)");
    assert.equal(read.document.items.length, 1);
    const [carpeta] = read.document.items;
    assert.equal(carpeta.kind, "folder");
    assert.equal(carpeta.description, "Texto suelto");
    assert.equal(carpeta.auth?.type, "none");
    assert.equal(carpeta.postResponseScript, "pm.test('x', () => {})");
    assert.equal(carpeta.items.length, 2, "la que no lleva URL y el método raro se quedan fuera");
  });

  test("una petición trae su método, sus cabeceras con el apagado, su ruta y su cuerpo", () => {
    const read = readPostmanFile(JSON.stringify(file))!;
    const crear = read.document.items[0].items[0];
    assert.equal(crear.request?.method, "POST");
    assert.deepEqual(crear.request?.headers, [
      { name: "X-Uno", value: "1", enabled: true },
      { name: "X-Dos", value: "2", enabled: false },
    ]);
    assert.deepEqual(crear.request?.pathParameters, [{ name: "id", type: "string", description: "", value: "7" }]);
    assert.equal(crear.request?.body.mode, "json");
    assert.equal(crear.auth, null, "la de una petición vive en `request.auth`");
  });

  test("lo que no entra se dice: sin URL, método raro, autenticación desconocida y secreto a mano", () => {
    const read = readPostmanFile(JSON.stringify(file))!;
    assert.deepEqual(
      read.skipped.map((entry) => [entry.name, entry.reason]),
      [
        ["Carpeta / Sin URL", "la petición no lleva URL"],
        ["Carpeta / Raro", "el método PURGE no se admite"],
      ],
    );
    assert.ok(read.notes.some((note) => /autenticación «inventada»/.test(note)));
    assert.ok(read.notes.some((note) => /no se guardan en claro/.test(note)));
    // El hueco queda marcado: el secreto no está, y se ve que falta.
    assert.equal(read.document.auth.params.token, "");
  });

  test("una variable que solo nombra un sitio sí se guarda entera", () => {
    const read = readPostmanFile(
      JSON.stringify({ info: { name: "x" }, auth: { type: "bearer", bearer: { token: "{{token}}" } }, item: [] }),
    )!;
    assert.equal(read.document.auth.params.token, "{{token}}");
    assert.deepEqual(read.skipped, []);
    assert.deepEqual(read.notes, []);
  });

  test("lo que no es JSON no se lee, y un nombre vacío tiene uno por defecto", () => {
    assert.equal(readPostmanFile("no soy json"), null);
    const read = readPostmanFile(JSON.stringify({ item: [{ request: { method: "GET", url: "https://a/b" } }, 7] }))!;
    assert.equal(read.name, "Colección importada");
    assert.equal(read.document.items[0].name, "Sin nombre");
    assert.equal(read.document.items.length, 1, "lo que no es un objeto se salta");
  });
});

describe("escribir el fichero de vuelta", () => {
  const withBody = (mode: BodyMode, extra: Record<string, unknown> = {}): CollectionItem => ({
    ...request("uno"),
    request: { ...emptyRequest(), url: "{{base}}/x", body: { ...emptyRequest().body, mode, ...extra } },
  });

  const write = (items: CollectionItem[], auth: RequestAuth = { type: "inherit", params: {} }) =>
    writePostmanFile({
      id: "id",
      name: "Tienda",
      description: "",
      document: { auth, variables: [], preRequestScript: "", postResponseScript: "", items },
    });

  test("cada modo de cuerpo sale como Postman lo escribe", () => {
    const json = write([withBody("json", { text: '{"a":1}' })]).file.item[0] as { request: { body: unknown } };
    assert.deepEqual(json.request.body, { mode: "raw", raw: '{"a":1}', options: { raw: { language: "json" } } });
    const raw = write([withBody("raw", { text: "hola" })]).file.item[0] as { request: { body: unknown } };
    assert.deepEqual(raw.request.body, { mode: "raw", raw: "hola" });
    const graphql = write([withBody("graphql", { text: "query { x }", variables: "{}" })]).file.item[0] as {
      request: { body: unknown };
    };
    assert.deepEqual(graphql.request.body, { mode: "graphql", graphql: { query: "query { x }", variables: "{}" } });
    const form = write([
      withBody("form-data", {
        fields: [
          { name: "a", value: "1", kind: "text", enabled: true },
          { name: "f", value: "", kind: "file", enabled: false },
        ],
      }),
    ]).file.item[0] as { request: { body: { mode: string; formdata: unknown[] } } };
    assert.equal(form.request.body.mode, "formdata");
    assert.deepEqual(form.request.body.formdata, [
      { key: "a", type: "text", value: "1" },
      { key: "f", type: "file", disabled: true },
    ]);
    const none = write([withBody("none")]).file.item[0] as { request: Record<string, unknown> };
    assert.equal("body" in none.request, false);
  });

  test("una carpeta lleva su autenticación, sus scripts y lo que tiene dentro", () => {
    const inner = { ...folder("f"), auth: { type: "basic" as const, params: { username: "u" } }, preRequestScript: "x" };
    const written = write([{ ...inner, items: [request("uno")] }]).file.item[0] as {
      name: string;
      auth: { type: string };
      event: { listen: string }[];
      item: unknown[];
    };
    assert.equal(written.name, "f");
    assert.equal(written.auth.type, "basic");
    assert.deepEqual(written.event.map((event) => event.listen), ["prerequest"]);
    assert.equal(written.item.length, 1);
  });

  test("un secreto escrito a mano sale vacío y se dice de quién era", () => {
    const written = write([request("uno")], { type: "bearer", params: { token: "literal" } });
    assert.deepEqual(written.redacted, ["La colección (token)"]);
  });

  test("lo escrito se vuelve a leer igual: ida y vuelta", () => {
    const items = [
      {
        ...folder("Carpeta"),
        items: [
          {
            ...request("Crear"),
            postResponseScript: "pm.test('x', () => {})",
            request: {
              ...emptyRequest(),
              method: "POST" as const,
              url: "{{base}}/x",
              query: [
                { name: "a", type: "string" as const, required: false, description: "", value: "1", enabled: true },
                { name: "b", type: "string" as const, required: false, description: "", value: "2", enabled: false },
              ],
              headers: [{ name: "X-Uno", value: "1", enabled: true }],
            },
          },
        ],
      },
    ];
    const written = write(items);
    const back = readPostmanFile(JSON.stringify(written.file))!;
    assert.deepEqual(countItems(back.document.items), { folders: 1, requests: 1 });
    const crear = back.document.items[0].items[0];
    assert.equal(crear.request?.url, "{{base}}/x");
    assert.deepEqual(
      crear.request?.query.map((row) => [row.name, row.value, row.enabled]),
      [
        ["a", "1", true],
        ["b", "2", false],
      ],
    );
    assert.equal(crear.postResponseScript, "pm.test('x', () => {})");
  });
});

describe("el esquema del documento", () => {
  const document = (items: CollectionItem[]) => ({
    auth: { type: "inherit", params: {} },
    variables: [],
    preRequestScript: "",
    postResponseScript: "",
    items,
  });

  test("acepta un árbol normal", () => {
    assert.deepEqual(safeParseCollectionDocument(document([folder("f", [request("a")])])), { ok: true });
  });

  test("una petición sin `request` y una carpeta con él se rechazan por su campo", () => {
    const badRequest = safeParseCollectionDocument(document([{ ...request("a"), request: null }]));
    assert.equal(badRequest.ok, false);
    assert.ok(!badRequest.ok && badRequest.issues.some((issue) => issue.field.endsWith("request")));
    const badFolder = safeParseCollectionDocument(document([{ ...folder("f"), request: emptyRequest() }]));
    assert.equal(badFolder.ok, false);
  });

  test("una petición con hijos, o con autenticación de carpeta, se rechaza", () => {
    const withChildren = safeParseCollectionDocument(document([{ ...request("a"), items: [request("b")] }]));
    assert.equal(withChildren.ok, false);
    const withAuth = safeParseCollectionDocument(
      document([{ ...request("a"), auth: { type: "none", params: {} } }]),
    );
    assert.equal(withAuth.ok, false);
  });

  test("un árbol más hondo que el tope se rechaza en palabras", () => {
    let deep = request("hoja");
    for (let level = 0; level <= MAX_COLLECTION_DEPTH + 1; level += 1) deep = folder(`f${level}`, [deep]);
    const parsed = safeParseCollectionDocument(document([deep]));
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && /niveles de carpetas/.test(parsed.issues[0].detail));
  });

  test("lo que no es un documento se rechaza sin reventar", () => {
    const parsed = safeParseCollectionDocument("nada");
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.issues[0].field === "document");
  });

  test("una petición suelta se valida con el mismo esquema", () => {
    assert.equal(collectionRequestSchema.safeParse(emptyRequest()).success, true);
    assert.equal(collectionRequestSchema.safeParse({ ...emptyRequest(), method: "PURGE" }).success, false);
  });
});

describe("componer los scripts", () => {
  test("cada trozo va en su propia función, con la etiqueta de dónde salió", () => {
    const composed = composeScript([
      { label: "Colección", code: "const a = 1;" },
      { label: "Vacío", code: "   " },
      { label: "Petición", code: "const a = 2;" },
    ]);
    assert.match(composed, /\/\/ Colección/);
    assert.match(composed, /\/\/ Petición/);
    assert.doesNotMatch(composed, /Vacío/);
    // Dos `const a` conviven, que es lo que pasa en Postman: son ejecuciones distintas.
    assert.equal(composed.split("(function () {").length - 1, 2);
  });

  test("sin nada que componer no hay script", () => {
    assert.equal(composeScript([{ label: "x", code: "" }]), "");
  });
});
