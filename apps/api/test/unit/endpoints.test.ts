/**
 * The endpoint as data: paths, imports and what «Send» puts on the wire. No database, no network.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_BODY,
  applyEndpointInput,
  blankEndpoint,
  endpointProblems,
  normalizePath,
  pathParameterNames,
  reconcilePathParameters,
} from "@/modules/endpoints/domain/model";
import { detectFormat, draftFromCurl, parseEndpointFile } from "@/modules/endpoints/domain/import-endpoints";
import {
  BINARY_PART,
  blockedUpload,
  buildUrl,
  filePartName,
  maskHeaders,
  readSendInput,
  serializeBody,
  unfilledPlaceholders,
  type UploadedPart,
} from "@/modules/endpoints/domain/send-request";

const same = (value: string) => value;
const file = (fieldname: string, originalname: string, content: string, mimetype = "text/plain"): UploadedPart => ({
  fieldname,
  originalname,
  mimetype,
  size: Buffer.byteLength(content),
  buffer: Buffer.from(content),
});

describe("rutas", () => {
  test("cada herramienta escribe el parámetro a su manera y todas quedan en {nombre}", () => {
    assert.equal(normalizePath("/users/:id/posts/<int:postId>/[slug]"), "/users/{id}/posts/{postId}/{slug}");
    assert.equal(normalizePath("users//{id}/"), "/users/{id}");
    assert.equal(normalizePath("/search?q=1#top"), "/search");
    assert.equal(normalizePath(""), "/");
  });

  test("un UUID pegado se convierte en parámetro con el nombre del segmento anterior", () => {
    assert.equal(
      normalizePath("/categories/0b3c2a52-8f5e-4c3e-9a0f-5f6b7c8d9e10/items/3fa85f64-5717-4562-b3fc-2c963f66afa6"),
      "/categories/{categoryId}/items/{itemId}",
    );
  });

  test("las {{variables}} no son parámetros ni se tocan", () => {
    assert.equal(normalizePath("/{{version}}/users/{id}"), "/{{version}}/users/{id}");
    assert.deepEqual(pathParameterNames("/{{version}}/users/{id}/x/{other}"), ["id", "other"]);
  });

  test("reconciliar conserva lo escrito y añade lo nuevo", () => {
    const next = reconcilePathParameters("/orders/{orderId}/lines/{lineUuid}", [
      { name: "orderId", type: "string", description: "el pedido", value: "42" },
      { name: "gone", type: "string", description: "", value: "x" },
    ]);
    assert.deepEqual(next, [
      { name: "orderId", type: "string", description: "el pedido", value: "42" },
      { name: "lineUuid", type: "uuid", description: "", value: "" },
    ]);
  });
});

describe("validación y guardado", () => {
  test("señala el campo exacto", () => {
    const problems = endpointProblems({
      method: "FETCH" as never,
      path: "users",
      query: [
        { name: "page", type: "string", required: false, description: "", value: "1", enabled: true },
        { name: "page", type: "string", required: false, description: "", value: "2", enabled: true },
      ],
      headers: [{ name: "X Bad", value: "a\nb", enabled: true }],
      body: { ...EMPTY_BODY, mode: "xml" as never },
    });
    const fields = problems.map((problem) => problem.field);
    assert.deepEqual(
      fields.sort(),
      ["body.mode", "headers.0.name", "headers.0.value", "method", "path", "query.1.name"].sort(),
    );
  });

  test("aplicar limpia filas vacías, normaliza la ruta y no guarda el valor de un campo fichero", () => {
    const base = blankEndpoint({
      id: "e",
      projectId: "p",
      origin: "manual",
      orderIndex: 0,
      now: new Date(0),
      actorId: "u",
    });
    const next = applyEndpointInput(base, {
      method: "POST",
      path: "/users/:id/avatar",
      headers: [
        { name: "  X-Trace ", value: "1", enabled: true },
        { name: " ", value: "ignored", enabled: true },
      ],
      body: {
        mode: "form-data",
        text: "",
        contentType: "",
        fields: [
          { name: "caption", value: "hola", kind: "text", enabled: true },
          { name: "avatar", value: "C:\\fakepath\\me.png", kind: "file", enabled: true },
        ],
      },
      tags: ["a", " a ", "b", ""],
    });
    assert.equal(next.path, "/users/{id}/avatar");
    assert.deepEqual(
      next.pathParameters.map((parameter) => parameter.name),
      ["id"],
    );
    assert.deepEqual(next.headers, [{ name: "X-Trace", value: "1", enabled: true }]);
    assert.equal(next.body.fields[1].value, "");
    assert.equal(next.body.contentType, "text/plain");
    assert.deepEqual(next.tags, ["a", "b"]);
  });
});

describe("importar", () => {
  test("detecta el formato por nombre y por contenido", () => {
    assert.equal(detectFormat("api.yaml", "whatever"), "openapi");
    assert.equal(detectFormat("notas.md", ""), "markdown");
    assert.equal(
      detectFormat(
        "x.json",
        JSON.stringify({ info: { schema: "https://schema.getpostman.com/json/collection/v2.1.0/" } }),
      ),
      "postman",
    );
    assert.equal(detectFormat("x.json", JSON.stringify({ _type: "export", resources: [] })), "insomnia");
    assert.equal(detectFormat("x.json", JSON.stringify({ openapi: "3.1.0" })), "openapi");
    assert.equal(detectFormat("x", "curl https://a.example/x"), "markdown");
    assert.equal(detectFormat("x.json", "{ not json"), null);
    assert.equal(detectFormat("x.json", "{}"), null);
  });

  test("OpenAPI: parámetros de ruta, query apagada, cuerpo de ejemplo y si pide autenticación", () => {
    const parsed = parseEndpointFile(
      "openapi",
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "T", version: "1" },
        security: [{ bearer: [] }],
        components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
        paths: {
          "/users/{id}": {
            put: {
              operationId: "updateUser",
              summary: "Cambiar usuario",
              tags: ["Users"],
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "string" } },
                { name: "notify", in: "query", schema: { type: "boolean" } },
              ],
              requestBody: {
                content: {
                  "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
          "/health": { get: { operationId: "health", security: [], responses: { "200": { description: "ok" } } } },
        },
      }),
    );
    assert.equal(parsed.drafts.length, 2);
    const update = parsed.drafts.find((draft) => draft.method === "PUT")!;
    assert.equal(update.path, "/users/{id}");
    assert.equal(update.description, "Cambiar usuario");
    assert.deepEqual(update.tags, ["Users"]);
    assert.equal(update.requiresAuth, true);
    assert.deepEqual(
      update.pathParameters?.map((parameter) => parameter.name),
      ["id"],
    );
    assert.deepEqual(
      update.query?.map((row) => [row.name, row.enabled]),
      [["notify", false]],
    );
    assert.equal(update.body?.mode, "json");
    assert.ok("name" in JSON.parse(update.body!.text));
    // A file import is not the project's contract, so nothing is linked.
    assert.equal(update.operationId, null);
    assert.equal(parsed.drafts.find((draft) => draft.method === "GET")!.requiresAuth, false);
  });

  test("markdown con curls: ruta normalizada, query, cabeceras sin credencial y cuerpo JSON", () => {
    const parsed = parseEndpointFile(
      "markdown",
      [
        "# Pedidos",
        "```bash",
        "curl -X POST 'https://api.example.com/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6/lines?dry=1' \\",
        "  -H 'Authorization: Bearer secreto' -H 'X-Tenant: acme' -H 'Content-Type: application/json' \\",
        `  --data '{"sku":"A1"}'`,
        "```",
      ].join("\n"),
    );
    assert.equal(parsed.drafts.length, 1);
    const draft = parsed.drafts[0];
    assert.equal(draft.method, "POST");
    assert.equal(draft.path, "/orders/{orderId}/lines");
    assert.deepEqual(
      draft.query?.map((row) => [row.name, row.value]),
      [["dry", "1"]],
    );
    assert.deepEqual(draft.headers, [{ name: "X-Tenant", value: "acme", enabled: true }]);
    assert.equal(draft.requiresAuth, true);
    assert.equal(draft.body?.mode, "json");
    assert.deepEqual(JSON.parse(draft.body!.text), { sku: "A1" });
    assert.equal(JSON.stringify(draft).includes("secreto"), false);
  });

  test("un cURL sin URL dice por qué", () => {
    assert.equal(typeof draftFromCurl("curl -H 'X: 1'"), "string");
  });

  test("markdown con tabla y lista: saca método y ruta, normaliza :id, y no duplica el curl", () => {
    const parsed = parseEndpointFile(
      "markdown",
      [
        "# API",
        "| Método | Ruta |",
        "| --- | --- |",
        "| GET | /users |",
        "| POST | /users/:id/roles |",
        "",
        "- `DELETE /users/{id}`",
        "",
        "```bash",
        "curl 'https://api.example.com/users'", // mismo GET /users que la tabla
        "```",
      ].join("\n"),
    );
    const keys = parsed.drafts.map((draft) => `${draft.method} ${draft.path}`).sort();
    assert.deepEqual(keys, ["DELETE /users/{id}", "GET /users", "POST /users/{id}/roles"]);
  });
});

describe("enviar", () => {
  test("la petición llega como JSON en texto y se lee sin fiarse", () => {
    assert.ok("problems" in readSendInput("no json"));
    assert.ok("problems" in readSendInput(JSON.stringify({ method: "BREW", path: "x" })));
    const read = readSendInput(JSON.stringify({ method: "get", path: "/x", body: { mode: "json", text: "{}" } }));
    assert.ok("input" in read);
    if ("input" in read) {
      assert.equal(read.input.method, "GET");
      assert.equal(read.input.auth.mode, "inherit");
      assert.equal(read.input.environmentId, null);
    }
  });

  test("URL: base sin barra final, parámetros codificados, query activa y URL absoluta que ignora la base", () => {
    assert.equal(
      buildUrl(
        "https://api.example.com/",
        "/users/{id}",
        [{ name: "id", value: "a b" }],
        [
          { name: "page", value: "2", enabled: true },
          { name: "off", value: "x", enabled: false },
        ],
      ),
      "https://api.example.com/users/a%20b?page=2",
    );
    assert.equal(
      buildUrl("https://ignored", "https://other.example/x?a=1", [], [{ name: "b", value: "2", enabled: true }]),
      "https://other.example/x?a=1&b=2",
    );
    assert.deepEqual(unfilledPlaceholders(buildUrl("https://a", "/users/{id}", [], [])), ["id"]);
  });

  test("cada tipo de cuerpo manda lo suyo y nada más", () => {
    const interpolate = (value: string) => value.replace("{{name}}", "Ana & Co");
    const none = serializeBody({ ...EMPTY_BODY, mode: "none", text: "ignorado" }, [], interpolate);
    assert.deepEqual(none, { ok: true, value: null });

    const urlencoded = serializeBody(
      {
        ...EMPTY_BODY,
        mode: "x-www-form-urlencoded",
        fields: [
          { name: "name", value: "{{name}}", kind: "text", enabled: true },
          { name: "off", value: "x", kind: "text", enabled: false },
        ],
      },
      [],
      interpolate,
    );
    assert.ok(urlencoded.ok);
    if (urlencoded.ok) assert.equal(urlencoded.value?.payload, "name=Ana+%26+Co");

    const json = serializeBody({ ...EMPTY_BODY, mode: "json", text: '{"n": "{{name}}"}' }, [], interpolate);
    assert.ok(json.ok && json.value?.contentType === "application/json");
  });

  test("form-data lleva texto y ficheros en bytes; falta un fichero y se dice cuál", () => {
    const body = {
      ...EMPTY_BODY,
      mode: "form-data" as const,
      fields: [
        { name: "caption", value: "hola", kind: "text" as const, enabled: true },
        { name: "doc", value: "", kind: "file" as const, enabled: true },
      ],
    };
    const missing = serializeBody(body, [], same);
    assert.equal(missing.ok, false);

    const sent = serializeBody(body, [file(filePartName("doc"), "a.txt", "contenido")], same);
    assert.ok(sent.ok && sent.value);
    if (sent.ok && sent.value) {
      const wire = Buffer.from(sent.value.payload as Uint8Array).toString("utf8");
      const boundary = /boundary=(.+)$/.exec(sent.value.contentType!)![1];
      assert.match(
        wire,
        new RegExp(`--${boundary}\\r\\nContent-Disposition: form-data; name="caption"\\r\\n\\r\\nhola\\r\\n`),
      );
      assert.match(wire, /name="doc"; filename="a.txt"\r\nContent-Type: text\/plain\r\n\r\ncontenido\r\n/);
      assert.ok(wire.endsWith(`--${boundary}--\r\n`));
    }
  });

  test("binary manda el fichero tal cual con su tipo", () => {
    const sent = serializeBody(
      { ...EMPTY_BODY, mode: "binary" },
      [file(BINARY_PART, "img.png", "PNG", "image/png")],
      same,
    );
    assert.ok(sent.ok && sent.value?.contentType === "image/png");
  });

  test("extensiones bloqueadas y cabeceras enmascaradas", () => {
    assert.match(blockedUpload([file("binary", "Setup.EXE", "x")]) ?? "", /\.exe/);
    assert.equal(blockedUpload([file("binary", "notes.txt", "x")]), null);
    assert.deepEqual(maskHeaders({ Authorization: "Bearer x", "X-Api-Key": "k", Accept: "*/*" }), {
      Authorization: "••••••••",
      "X-Api-Key": "••••••••",
      Accept: "*/*",
    });
  });
});

describe("misma ruta", () => {
  test("el nombre del parámetro no hace otra ruta", async () => {
    const { endpointKey } = await import("@/modules/endpoints/domain/model");
    assert.equal(endpointKey("get", "/users/{id}"), endpointKey("GET", "/users/:userId/"));
    assert.notEqual(endpointKey("GET", "/users/{id}"), endpointKey("GET", "/users/me"));
    assert.notEqual(endpointKey("GET", "/{{v}}/users"), endpointKey("GET", "/{}/users"));
  });
});
