/**
 * Las ramas del dominio de endpoints que las pruebas de siempre no pisaban: los nombres de los
 * parámetros, cada problema de validación por su campo, la lectura sin fiarse de «Enviar» y los
 * formatos de importación menos comunes.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyEndpointInput,
  authProblems,
  blankEndpoint,
  endpointProblems,
  MAX_AUTH_PARAM,
  MAX_AUTH_PARAMS,
  MAX_PATH,
  MAX_SCRIPT,
  normalizePath,
  type EndpointInput,
} from "@/modules/endpoints/domain/model";
import {
  blockedUpload,
  buildUrl,
  graphqlOverGet,
  maskHeaders,
  multipart,
  readSendInput,
  serializeBody,
  unfilledPlaceholders,
} from "@/modules/endpoints/domain/send-request";
import {
  detectFormat,
  draftFromCurl,
  draftFromOperation,
  examplesFromFile,
  parseEndpointFile,
  pendingFileNotes,
  type EndpointDraft,
} from "@/modules/endpoints/domain/import-endpoints";

const fields = (problems: { field: string }[]) => problems.map((problem) => problem.field);
const read = (value: unknown) => readSendInput(JSON.stringify(value));

describe("normalizePath: los nombres que pone", () => {
  test("dos placeholders con el mismo nombre se numeran", () => {
    assert.equal(normalizePath("/a/:id/b/{id}/c/<int:id>"), "/a/{id}/b/{id2}/c/{id3}");
  });

  test("un UUID tras otro placeholder, o al principio, se llama id", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    assert.equal(normalizePath(`/${uuid}`), "/{id}");
    assert.equal(normalizePath(`/users/{userId}/${uuid}`), "/users/{userId}/{id}");
  });

  test("el nombre sale en singular y en camelCase del segmento anterior", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    assert.equal(normalizePath(`/categories/${uuid}`), "/categories/{categoryId}");
    assert.equal(normalizePath(`/order-items/${uuid}`), "/order-items/{orderItemId}");
    assert.equal(normalizePath(`/staff/${uuid}`), "/staff/{staffId}");
    // Un separador al final no deja nada detrás que poner en mayúscula.
    assert.equal(normalizePath(`/data_/${uuid}`), "/data_/{dataId}");
  });

  test("vacío, solo query o solo fragmento es la raíz", () => {
    assert.equal(normalizePath("   "), "/");
    assert.equal(normalizePath("?a=1"), "/");
    assert.equal(normalizePath("#x"), "/");
  });
});

describe("authProblems", () => {
  test("un tipo que no existe corta ahí", () => {
    assert.deepEqual(fields(authProblems({ type: "magia" as never, params: { a: 1 as never } })), ["auth.type"]);
  });

  test("demasiados parámetros, uno que no es texto y uno demasiado largo", () => {
    const params: Record<string, string> = {};
    for (let index = 0; index <= MAX_AUTH_PARAMS; index += 1) params[`p${index}`] = "x";
    params.token = "y".repeat(MAX_AUTH_PARAM + 1);
    (params as Record<string, unknown>).numero = 5;
    const problems = authProblems({ type: "bearer", params });
    assert.deepEqual(fields(problems).sort(), ["auth.params", "auth.params.numero", "auth.params.token"].sort());
  });

  test("sin params no hay nada que mirar", () => {
    assert.deepEqual(authProblems({ type: "none", params: undefined as never }), []);
  });
});

describe("endpointProblems: cada campo por su nombre", () => {
  test("la ruta: vacía, larga, relativa y con espacios", () => {
    assert.deepEqual(endpointProblems({ path: "   " }), [{ field: "path", detail: "Falta la ruta" }]);
    assert.match(endpointProblems({ path: `/${"a".repeat(MAX_PATH)}` })[0].detail, /Como mucho 500/);
    assert.match(endpointProblems({ path: "users" })[0].detail, /Empieza por \//);
    assert.deepEqual(endpointProblems({ path: "/a b" }), [{ field: "path", detail: "Una ruta no lleva espacios" }]);
  });

  test("método, estado, parámetros, query y cabeceras", () => {
    const input = {
      method: "TRACE",
      status: "borrado",
      pathParameters: [{ name: " ", type: "fecha", description: "", value: "" }, null],
      query: [
        { name: "q", type: "string" },
        { name: " q ", type: "texto" },
        null,
        { type: "string" },
      ],
      headers: [{ name: "Mal Nombre", value: "a\r\nb" }, null, { value: "sin nombre" }],
    } as unknown as EndpointInput;
    assert.deepEqual(fields(endpointProblems(input)), [
      "method",
      "status",
      "pathParameters.0.name",
      "pathParameters.0.type",
      "pathParameters.1.name",
      "query.1.name",
      "query.1.type",
      "headers.0.name",
      "headers.0.value",
    ]);
  });

  test("el cuerpo: modo, tipo de campo, variables que no son texto o JSON roto", () => {
    const bad = endpointProblems({
      body: { mode: "xml", text: "", contentType: "", fields: [{ name: "f", value: "", kind: "blob", enabled: true }, null] },
    } as unknown as EndpointInput);
    assert.deepEqual(fields(bad), ["body.mode", "body.fields.0.kind"]);

    const notText = endpointProblems({
      body: { mode: "graphql", text: "{ a }", contentType: "", fields: [], variables: 5 },
    } as unknown as EndpointInput);
    assert.deepEqual(notText, [{ field: "body.variables", detail: "Las variables de GraphQL son texto JSON" }]);

    const broken = endpointProblems({
      body: { mode: "graphql", text: "{ a }", contentType: "", fields: [], variables: "{roto" },
    });
    assert.deepEqual(fields(broken), ["body.variables"]);

    // Un cuerpo nulo no revienta: dice el modo y nada más.
    assert.deepEqual(fields(endpointProblems({ body: null } as unknown as EndpointInput)), ["body.mode"]);
  });

  test("etiquetas y scripts", () => {
    const tags = endpointProblems({ tags: [...Array.from({ length: 31 }, (_, index) => `t${index}`), "x".repeat(41)] });
    assert.deepEqual(fields(tags), ["tags", "tags"]);
    const scripts = endpointProblems({ preRequestScript: "x".repeat(MAX_SCRIPT + 1), postResponseScript: "ok" });
    assert.deepEqual(fields(scripts), ["preRequestScript"]);
  });
});

describe("applyEndpointInput: los valores que faltan", () => {
  const current = blankEndpoint({
    id: "e1",
    projectId: "p1",
    origin: "manual",
    orderIndex: 0,
    now: new Date("2026-01-01T00:00:00Z"),
    actorId: "u1",
  });

  test("una fila sin descripción ni valor queda en blanco, y un campo sin enabled queda encendido", () => {
    const next = applyEndpointInput(current, {
      query: [{ name: " q ", type: "string" } as never],
      headers: [{ name: "X-A" } as never],
      body: {
        mode: "form-data",
        text: undefined as never,
        contentType: "  ",
        fields: [
          { name: "texto", kind: "text" } as never,
          { name: "fichero", value: "C:/ruta", kind: "file", enabled: false },
        ],
        variables: "   ",
      },
    });
    assert.deepEqual(next.query, [
      { name: "q", type: "string", required: false, description: "", value: "", enabled: true },
    ]);
    assert.deepEqual(next.headers, [{ name: "X-A", value: "", enabled: true }]);
    assert.deepEqual(next.body, {
      mode: "form-data",
      text: "",
      contentType: "text/plain",
      fields: [
        { name: "texto", value: "", kind: "text", enabled: true },
        { name: "fichero", value: "", kind: "file", enabled: false },
      ],
    });
  });

  test("sin nada que cambiar se queda como estaba", () => {
    assert.deepEqual(applyEndpointInput(current, {}), current);
  });
});

describe("readSendInput: lo que llega sin fiarse", () => {
  test("sin cuerpo, JSON roto o algo que no es un objeto", () => {
    assert.deepEqual(readSendInput(undefined), { problems: [{ field: "request", detail: "Tiene que ser JSON" }] });
    assert.deepEqual(readSendInput("[1]"), {
      problems: [{ field: "request", detail: "Tiene que ser un objeto JSON" }],
    });
  });

  test("cada problema señala su campo", () => {
    const result = read({
      method: "TRACE",
      path: "sin-barra",
      body: { mode: "xml" },
      auth: { type: "magia" },
      headers: [{ name: "X", value: "a\nb" }, { name: "Y", value: "c\nd", enabled: false }, "no-es-fila"],
      preRequestScript: "x".repeat(MAX_SCRIPT + 1),
      postResponseScript: "x".repeat(MAX_SCRIPT + 1),
    });
    assert.ok("problems" in result);
    assert.deepEqual(fields(result.problems), [
      "method",
      "path",
      "body.mode",
      "auth.type",
      "headers.0.value",
      "preRequestScript",
      "postResponseScript",
    ]);
  });

  test("el modo viejo desconocido y un parámetro demasiado largo", () => {
    const old = read({ method: "GET", path: "/", auth: { mode: "digest" } });
    assert.ok("problems" in old);
    assert.deepEqual(old.problems, [{ field: "auth.mode", detail: "inherit, none o bearer" }]);

    const long = read({ method: "GET", path: "/", auth: { type: "bearer", params: { token: "x".repeat(MAX_AUTH_PARAM + 1) } } });
    assert.ok("problems" in long);
    assert.deepEqual(fields(long.problems), ["auth.params.token"]);
  });

  test("lo que falta se rellena: sin auth hereda, con modo viejo se traduce, un valor que no es texto es vacío", () => {
    const plain = read({ method: "get", path: "{{base}}/a", auth: "no-es-objeto" });
    assert.ok("input" in plain);
    assert.equal(plain.input.method, "GET");
    assert.deepEqual(plain.input.auth, { type: "inherit", params: {} });
    assert.equal(plain.input.environmentId, null);
    assert.deepEqual(plain.input.body, { mode: "none", text: "", contentType: "text/plain", fields: [], variables: "" });

    const bearer = read({ method: "POST", path: "https://api.example.com/x", auth: { mode: "bearer", token: "t" } });
    assert.ok("input" in bearer);
    assert.deepEqual(bearer.input.auth, { type: "bearer", params: { token: "t" } });

    const typed = read({
      method: "PUT",
      path: "/x",
      environmentId: "env-1",
      auth: { type: "apikey", params: { key: "X-K", value: 5 } },
      pathParameters: [{ name: "id", value: 7 }],
      query: [{ name: " q ", value: "1", enabled: false }],
      body: { mode: "form-data", fields: [{ name: " f ", value: "v", kind: "file" }, { name: "g", enabled: false }] },
    });
    assert.ok("input" in typed);
    assert.equal(typed.input.environmentId, "env-1");
    assert.deepEqual(typed.input.auth, { type: "apikey", params: { key: "X-K", value: "" } });
    assert.deepEqual(typed.input.pathParameters, [{ name: "id", value: "" }]);
    assert.deepEqual(typed.input.query, [{ name: "q", value: "1", enabled: false }]);
    assert.deepEqual(typed.input.body.fields, [
      { name: "f", value: "v", kind: "file", enabled: true },
      { name: "g", value: "", kind: "text", enabled: false },
    ]);
  });
});

describe("la URL y el cuerpo que salen", () => {
  test("un parámetro sin valor se queda como placeholder y se nombra", () => {
    const url = buildUrl("http://h/", "/users/{id}/{other}", [{ name: "id", value: "a b" }], []);
    assert.equal(url, "http://h/users/a%20b/{other}");
    assert.deepEqual(unfilledPlaceholders(url), ["other"]);
    assert.deepEqual(unfilledPlaceholders("http://h/a/%7Bx%7D"), ["x"]);
  });

  test("la query se añade con & cuando la ruta ya tenía ?", () => {
    assert.equal(
      buildUrl("", "http://h/a?x=1", [], [
        { name: "y", value: "2", enabled: true },
        { name: "z", value: "3", enabled: false },
        { name: "", value: "4", enabled: true },
      ]),
      "http://h/a?x=1&y=2",
    );
  });

  test("GraphQL por GET: variables solo si las hay, operationName si lo hay, & tras una query", () => {
    const full = new URL(graphqlOverGet("http://h/g?a=1", JSON.stringify({ query: "{a}", variables: { b: 1 }, operationName: "Op" })));
    assert.equal(full.searchParams.get("a"), "1");
    assert.equal(full.searchParams.get("query"), "{a}");
    assert.equal(full.searchParams.get("variables"), '{"b":1}');
    assert.equal(full.searchParams.get("operationName"), "Op");

    const bare = new URL(graphqlOverGet("http://h/g", JSON.stringify({ query: "{a}" })));
    assert.equal(bare.searchParams.has("variables"), false);
    assert.equal(bare.searchParams.has("operationName"), false);
  });

  test("raw sin tipo va como text/plain; binary sin tipo como octet-stream", () => {
    const raw = serializeBody({ mode: "raw", text: "hola", contentType: "", fields: [] }, [], (value) => value);
    assert.deepEqual(raw, { ok: true, value: { contentType: "text/plain", payload: "hola", preview: "hola" } });

    const binary = serializeBody(
      { mode: "binary", text: "", contentType: "", fields: [] },
      [{ fieldname: "binary", originalname: "a.bin", mimetype: "", size: 2, buffer: Buffer.from([1, 2]) }],
      (value) => value,
    );
    assert.ok(binary.ok && binary.value);
    assert.equal(binary.value.contentType, "application/octet-stream");
    assert.equal(binary.value.preview, "<a.bin, 2 bytes>");
  });

  test("urlencoded deja fuera los campos fichero, apagados y sin nombre", () => {
    const encoded = serializeBody(
      {
        mode: "x-www-form-urlencoded",
        text: "",
        contentType: "",
        fields: [
          { name: "a", value: "{{v}}", kind: "text", enabled: true },
          { name: "b", value: "x", kind: "file", enabled: true },
          { name: "c", value: "x", kind: "text", enabled: false },
          { name: "", value: "x", kind: "text", enabled: true },
        ],
      },
      [],
      (value) => value.replace("{{v}}", "1&2"),
    );
    assert.ok(encoded.ok && encoded.value);
    assert.equal(encoded.value.payload, "a=1%262");
  });

  test("graphql sin operación es un 422 con su código", () => {
    const empty = serializeBody({ mode: "graphql", text: "  ", contentType: "", fields: [] }, [], (value) => value);
    assert.equal(empty.ok, false);
    assert.equal(!empty.ok && empty.code, "graphql-query-missing");
  });

  test("multipart: la frontera crece si un fichero la contiene; un fichero sin tipo es octet-stream; se escapan comillas", () => {
    const encoded = multipart([
      { name: 'di"ce', data: Buffer.from("----EndpointQualityFormBoundary"), filename: "a\\b\r\n.txt" },
    ]);
    assert.equal(encoded.boundary, "----EndpointQualityFormBoundary-");
    const text = Buffer.from(encoded.bytes).toString("utf8");
    assert.match(text, /name="di\\"ce"; filename="a\\\\b {2}\.txt"/);
    assert.match(text, /Content-Type: application\/octet-stream/);
  });

  test("ficheros permitidos y cabeceras que no son secretas", () => {
    assert.equal(blockedUpload([{ fieldname: "f", originalname: "foto.PNG", mimetype: "", size: 1, buffer: Buffer.alloc(1) }]), null);
    assert.deepEqual(maskHeaders({ Accept: "x", "X-Api-Key": "k", Cookie: "c" }), {
      Accept: "x",
      "X-Api-Key": "••••••••",
      Cookie: "••••••••",
    });
  });
});

describe("importar: los caminos menos pisados", () => {
  test("el formato por extensión y por contenido", () => {
    assert.equal(detectFormat("api.YML", "lo que sea"), "openapi");
    assert.equal(detectFormat("notas.markdown", "{}"), "markdown");
    assert.equal(detectFormat("notas.txt", ""), "markdown");
    assert.equal(detectFormat("sin-extension", "{ roto"), null);
    assert.equal(detectFormat("x.json", '{"swagger":"2.0"}'), "openapi");
    assert.equal(detectFormat("x.json", '{"resources":[]}'), "insomnia");
    assert.equal(detectFormat("x.json", '{"a":1}'), null);
    assert.equal(detectFormat("x", "openapi: 3.0.0"), "openapi");
    assert.equal(detectFormat("x", "nada que ver"), null);
  });

  test("un HAR: una entrada sin URL y un método que no se admite se saltan con su motivo", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          { request: { method: "GET" } },
          {
            request: { method: "TRACE", url: "https://api.example.com/eco", headers: [] },
            response: { status: 200, content: { mimeType: "application/json", text: "{}" } },
          },
        ],
      },
    });
    const parsed = parseEndpointFile("har", har);
    assert.equal(parsed.drafts.length, 0);
    assert.deepEqual(
      parsed.skipped.map((skip) => [skip.method, skip.path, skip.reason]),
      [
        ["GET", "", "la entrada no lleva URL"],
        ["TRACE", "/eco", "El método TRACE no se admite"],
      ],
    );
  });

  test("un YAML que no se puede leer es un salto con su motivo, no una excepción", () => {
    const broken = parseEndpointFile("openapi", "esto: [no es un contrato");
    assert.equal(broken.drafts.length, 0);
    assert.equal(broken.skipped.length, 1);
    assert.match(broken.skipped[0].reason, /Flow sequence|sequence/i);
    const scalar = parseEndpointFile("openapi", "solo texto");
    assert.deepEqual(scalar.skipped.map((skip) => skip.reason), ["El documento no contiene un objeto en la raíz"]);
  });

  test("OpenAPI sin versión: cada error es un salto y no hay borradores", () => {
    const parsed = parseEndpointFile("openapi", "info:\n  title: x\n");
    assert.equal(parsed.format, "openapi");
    assert.equal(parsed.drafts.length, 0);
    assert.ok(parsed.skipped.length > 0);
    assert.ok(parsed.skipped.every((skip) => skip.method === "" && skip.reason.length > 0));
  });

  test("cuerpos de un cURL: texto sin JSON es raw, JSON en texto es json, un formulario urlencoded son filas", () => {
    const raw = draftFromCurl("curl -X POST https://h/a -H 'Content-Type: text/csv' --data-raw 'a,b'");
    assert.ok(typeof raw !== "string");
    assert.equal(raw.body?.mode, "raw");
    assert.equal(raw.body?.contentType, "text/csv");

    const json = draftFromCurl(`curl -X POST https://h/a -H 'Content-Type: application/vnd.api+json' --data-raw '{"a":1}'`);
    assert.ok(typeof json !== "string");
    assert.equal(json.body?.mode, "json");

    const form = draftFromCurl("curl -X POST https://h/a --data-urlencode 'a=1' --data-urlencode 'b=2'");
    assert.ok(typeof form !== "string");
    assert.equal(form.body?.mode, "x-www-form-urlencoded");
    assert.deepEqual(form.body?.fields.map((field) => [field.name, field.value, field.kind]), [
      ["a", "1", "text"],
      ["b", "2", "text"],
    ]);
  });

  test("una operación GraphQL de Postman sin variables no guarda la clave", () => {
    const collection = JSON.stringify({
      info: { name: "g", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        {
          name: "consulta",
          request: {
            method: "POST",
            url: "https://h/graphql",
            body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: "" } },
          },
        },
      ],
    });
    const parsed = parseEndpointFile("postman", collection);
    assert.equal(parsed.drafts.length, 1);
    assert.equal(parsed.drafts[0].body?.mode, "graphql");
    assert.equal("variables" in (parsed.drafts[0].body ?? {}), false);
  });

  test("un borrador sin formulario no tiene ficheros pendientes; una operación sin etiqueta ni esquema tampoco inventa nada", () => {
    assert.deepEqual(pendingFileNotes({ method: "GET", path: "/", operationId: null }), []);
    const draft = draftFromOperation(
      { id: "op", method: "get" as never, path: "/a/{id}", summary: "s", tag: "", parameters: ["id", "q"], security: [], requestSchema: undefined as never },
      true,
    );
    assert.deepEqual(draft.tags, []);
    assert.equal(draft.operationId, "op");
    assert.equal(draft.body?.mode, "none");
    assert.deepEqual(draft.query?.map((row) => row.name), ["q"]);
    assert.equal(draft.requiresAuth, false);
  });

  test("ejemplos de un fichero: uno inválido se salta y uno sin nombre toma el del estado", () => {
    const draft: EndpointDraft = { method: "GET", path: "/users", operationId: null };
    const result = examplesFromFile({
      projectId: "p",
      endpointId: "e",
      draft,
      now: new Date("2026-01-01T00:00:00Z"),
      actorId: "u",
      from: [
        { name: "malo", status: 42, headers: {}, body: "", contentType: "application/json", request: null },
        { name: "  ", status: 404, headers: {}, body: "{}", contentType: "application/json", request: null },
        { name: "  ", status: 404, headers: {}, body: "{}", contentType: "application/json", request: null },
      ],
    });
    assert.equal(result.examples.length, 2);
    const [first, second] = result.examples;
    assert.notEqual(first.name, second.name);
    assert.match(first.name, /404/);
    assert.equal(first.request.method, "GET");
    assert.equal(first.request.url, "/users");
    assert.equal(first.orderIndex, 1);
  });
});
