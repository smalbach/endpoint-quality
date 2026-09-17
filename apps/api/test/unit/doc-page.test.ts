/**
 * Qué sale por la URL pública de una documentación, y sobre todo **qué no sale**.
 *
 * Este fichero es la mitad del valor de la ola. Un endpoint guardado lleva dentro el token de quien
 * lo probó, el cuerpo con el que se probó y dos scripts; la página los enseña a cualquiera que tenga
 * la URL. Así que casi cada prueba de aquí es la misma pregunta escrita de otra manera: *esto que
 * está en la fila, ¿aparece en la página?*
 *
 * La otra mitad es que la página sirva para algo: que una ruta sin descripción se pueda contar antes
 * de publicar, que las variables se queden escritas —esta página no tiene entorno— y que la URL que
 * se enseña se pueda pegar en una terminal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blankEndpoint, type Endpoint } from "@/modules/endpoints/domain/model";
import { blankExample, type EndpointExample } from "@/modules/endpoints/domain/examples";
import {
  UNTAGGED_GROUP,
  buildDocPage,
  docAuth,
  docBody,
  docHeaders,
  docUrl,
  projectAuthType,
  type DocPage,
} from "@/modules/docs/domain/doc-page";

const NOW = new Date("2026-03-01T10:00:00.000Z");

let sequence = 0;
const nextId = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`;

function endpoint(patch: Partial<Endpoint> = {}): Endpoint {
  return {
    ...blankEndpoint({
      id: nextId(),
      projectId: "project-1",
      origin: "manual",
      orderIndex: 0,
      now: NOW,
      actorId: "actor-1",
    }),
    ...patch,
  };
}

function example(
  endpointId: string,
  patch: { name?: string; status?: number; body?: string; orderIndex?: number } = {},
) {
  return blankExample({
    projectId: "project-1",
    endpointId,
    name: patch.name ?? "200 correcto",
    request: { method: "GET", url: "https://api.test/x", headers: [], body: { text: "", contentType: "" } },
    response: {
      status: patch.status ?? 200,
      headers: [{ name: "Content-Type", value: "application/json", enabled: true }],
      body: patch.body ?? '{"id":"42"}',
      contentType: "application/json",
      durationMs: 11,
    },
    origin: "manual",
    orderIndex: patch.orderIndex ?? 0,
    now: NOW,
    actorId: "actor-1",
  });
}

function page(
  endpoints: Endpoint[],
  options: {
    examples?: EndpointExample[];
    includeExamples?: boolean;
    baseUrl?: string;
    intro?: string;
    authType?: "none" | "bearer" | "basic" | "apikey";
    apiKeyName?: string;
  } = {},
): DocPage {
  const examples = options.examples ?? [];
  return buildDocPage({
    project: {
      name: "Pedidos",
      description: "La API de pedidos",
      authType: options.authType ?? "none",
      apiKeyName: options.apiKeyName ?? "",
    },
    site: {
      baseUrl: options.baseUrl ?? "https://api.example.com",
      intro: options.intro ?? "",
      includeExamples: options.includeExamples ?? false,
    },
    endpoints,
    examplesOf: (endpointId) => examples.filter((row) => row.endpointId === endpointId),
    generatedAt: NOW,
  });
}

/** El primer endpoint de la página, que es lo que casi todas las pruebas miran. */
const first = (result: DocPage) => result.groups[0]!.endpoints[0]!;

describe("lo que no se publica", () => {
  it("los parámetros de la autenticación no salen, ni tapados", () => {
    const result = page([
      endpoint({
        path: "/v1/pedidos",
        auth: { type: "bearer", params: { token: "eyJhbGciOiJIUzI1NiJ9.secreto.firma" } },
      }),
    ]);
    const published = JSON.stringify(result);
    assert.ok(!published.includes("secreto"), "el token del endpoint ha salido en la página");
    // Lo que sí sale es que hay que mandar uno, que es lo que documenta.
    assert.equal(first(result).auth.type, "bearer");
    assert.match(first(result).auth.detail, /Authorization: Bearer/);
  });

  it("los scripts no salen: no documentan la API, documentan cómo se prueba aquí", () => {
    const result = page([
      endpoint({
        path: "/v1/pedidos",
        preRequestScript: 'pm.environment.set("token", "eyJhbGciOiJIUzI1NiJ9.abc.def")',
        postResponseScript: 'pm.test("ok", () => {})',
      }),
    ]);
    const published = JSON.stringify(result);
    assert.ok(!published.includes("pm.environment"), "un script ha salido en la página");
    assert.ok(!published.includes("pm.test"), "un script ha salido en la página");
  });

  it("el valor de una cabecera que es credencial se tapa, y el nombre se queda", () => {
    const headers = docHeaders([
      { name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", enabled: true },
      { name: "X-Api-Key", value: "clave-de-verdad", enabled: true },
      { name: "Accept", value: "application/json", enabled: true },
    ]);
    // El nombre es documentación —«esta ruta pide Authorization»— y el valor no lo es. Es la
    // política contraria a la de guardar un ejemplo, y a propósito.
    assert.deepEqual(
      headers.map((header) => [header.name, header.masked]),
      [
        ["Authorization", true],
        ["X-Api-Key", true],
        ["Accept", false],
      ],
    );
    assert.ok(!JSON.stringify(headers).includes("clave-de-verdad"));
    assert.equal(headers[2]!.value, "application/json");
  });

  it("un campo secreto del cuerpo se tapa y se dice cuál", () => {
    const body = docBody({
      mode: "json",
      text: '{"email":"ana@example.com","password":"hunter2"}',
      contentType: "application/json",
      fields: [],
    });
    assert.ok(body);
    assert.ok(!body.text.includes("hunter2"));
    // Se nombra el campo tapado: si no, los ocho puntos parecen el valor de verdad.
    assert.deepEqual(body.masked, ["password"]);
    // Y lo que no es secreto se queda, que es la mitad de lo que documenta un cuerpo.
    assert.ok(body.text.includes("ana@example.com"));
  });

  it("una fila apagada no se publica: no se manda, así que no es parte de nada", () => {
    const result = page([
      endpoint({
        path: "/v1/pedidos",
        headers: [
          { name: "Accept", value: "application/json", enabled: true },
          { name: "X-Debug", value: "1", enabled: false },
        ],
        query: [
          { name: "page", type: "number", required: false, description: "", value: "1", enabled: true },
          { name: "trace", type: "boolean", required: false, description: "", value: "true", enabled: false },
        ],
      }),
    ]);
    assert.deepEqual(
      first(result).headers.map((header) => header.name),
      ["Accept"],
    );
    assert.deepEqual(
      first(result).query.map((row) => row.name),
      ["page"],
    );
  });

  it("un endpoint archivado o inactivo no es documentación", () => {
    const result = page([
      endpoint({ path: "/v1/vivo", status: "active" }),
      endpoint({ path: "/v1/archivado", status: "archived" }),
      endpoint({ path: "/v1/apagado", status: "inactive" }),
    ]);
    assert.equal(result.counts.endpoints, 1);
    assert.equal(first(result).path, "/v1/vivo");
  });

  it("sin «includeExamples» no sale ningún cuerpo de ejemplo", () => {
    const one = endpoint({ path: "/v1/pedidos" });
    const result = page([one], { examples: [example(one.id, { body: '{"cliente":"Ana"}' })] });
    assert.equal(result.counts.examples, 0);
    assert.deepEqual(first(result).examples, []);
    assert.ok(!JSON.stringify(result).includes("Ana"));
  });

  it("con «includeExamples» sí, y en el orden que tienen", () => {
    const one = endpoint({ path: "/v1/pedidos" });
    const result = page([one], {
      includeExamples: true,
      examples: [
        example(one.id, { name: "404 no existe", status: 404, orderIndex: 1 }),
        example(one.id, { name: "200 con el pedido", status: 200, orderIndex: 0 }),
      ],
    });
    assert.deepEqual(
      first(result).examples.map((entry) => entry.name),
      ["200 con el pedido", "404 no existe"],
    );
    assert.equal(result.counts.examples, 2);
  });

  it("una cabecera de ejemplo que sea credencial se tapa igual, aunque ya venga redactada", () => {
    const one = endpoint({ path: "/v1/login" });
    const saved = example(one.id);
    saved.response.headers = [
      { name: "Set-Cookie", value: "session=abcdef; HttpOnly", enabled: true },
      { name: "Content-Type", value: "application/json", enabled: true },
    ];
    const result = page([one], { includeExamples: true, examples: [saved] });
    const headers = first(result).examples[0]!.headers;
    assert.deepEqual(
      headers.map((header) => [header.name, header.masked]),
      [
        ["Set-Cookie", true],
        ["Content-Type", false],
      ],
    );
    assert.ok(!JSON.stringify(headers).includes("abcdef"));
  });
});

describe("lo que sí se publica", () => {
  it("las variables se quedan escritas: esta página no tiene entorno con el que resolverlas", () => {
    const result = page([
      endpoint({
        path: "/v1/pedidos/{id}",
        pathParameters: [{ name: "id", type: "string", description: "El pedido", value: "{{pedidoId}}" }],
        query: [{ name: "org", type: "string", required: true, description: "", value: "{{orgId}}", enabled: true }],
      }),
    ]);
    assert.equal(first(result).pathParameters[0]!.example, "{{pedidoId}}");
    assert.equal(first(result).query[0]!.example, "{{orgId}}");
  });

  it("un parámetro de ruta siempre hace falta; uno de query dice si lo pide", () => {
    const result = page([
      endpoint({
        path: "/v1/pedidos/{id}",
        pathParameters: [{ name: "id", type: "string", description: "", value: "42" }],
        query: [
          { name: "page", type: "number", required: false, description: "", value: "", enabled: true },
          { name: "org", type: "string", required: true, description: "", value: "", enabled: true },
        ],
      }),
    ]);
    assert.equal(first(result).pathParameters[0]!.required, true);
    assert.deepEqual(
      first(result).query.map((row) => row.required),
      [false, true],
    );
  });

  it("la URL se pega: la base del sitio delante de la ruta, con una sola barra", () => {
    assert.equal(docUrl("https://api.example.com", "/v1/pedidos"), "https://api.example.com/v1/pedidos");
    assert.equal(docUrl("https://api.example.com", "v1/pedidos"), "https://api.example.com/v1/pedidos");
  });

  it("sin URL base se enseña la ruta sola, en vez de inventarse un host", () => {
    // Poner `http://localhost:3000` de relleno sería inventarse justo el dato que falta, y quien
    // copie el `curl` lo lanzaría contra su propia máquina sin enterarse.
    assert.equal(docUrl("", "/v1/pedidos"), "/v1/pedidos");
    const result = page([endpoint({ path: "/v1/pedidos" })], { baseUrl: "" });
    assert.equal(first(result).url, "/v1/pedidos");
    assert.equal(result.baseUrl, "");
  });

  it("se cuenta cuántas rutas tienen descripción, que es si esto documenta algo", () => {
    const result = page([
      endpoint({ path: "/v1/a", description: "Lista los pedidos" }),
      endpoint({ path: "/v1/b", description: "" }),
      endpoint({ path: "/v1/c", description: "   " }),
    ]);
    assert.deepEqual(result.counts, { endpoints: 3, documented: 1, examples: 0 });
  });

  it("los grupos son la primera etiqueta, y los sin etiqueta van al final", () => {
    const result = page([
      endpoint({ path: "/v1/sin", tags: [] }),
      endpoint({ path: "/v1/pedidos", tags: ["Pedidos", "v1"] }),
      endpoint({ path: "/v1/pedidos/{id}", tags: ["Pedidos"] }),
      endpoint({ path: "/v1/clientes", tags: ["Clientes"] }),
    ]);
    assert.deepEqual(
      result.groups.map((group) => [group.tag, group.endpoints.length]),
      [
        ["Pedidos", 2],
        ["Clientes", 1],
        [UNTAGGED_GROUP, 1],
      ],
    );
  });

  it("dentro del grupo manda el orden de la lista del proyecto, no el alfabético", () => {
    const result = page([
      endpoint({ path: "/v1/z", tags: ["Todo"], orderIndex: 0 }),
      endpoint({ path: "/v1/a", tags: ["Todo"], orderIndex: 1 }),
    ]);
    assert.deepEqual(
      result.groups[0]!.endpoints.map((entry) => entry.path),
      ["/v1/z", "/v1/a"],
    );
  });

  it("un cuerpo de formulario documenta sus campos, y del fichero solo que va un fichero", () => {
    const body = docBody({
      mode: "form-data",
      text: "",
      contentType: "",
      fields: [
        { name: "nombre", value: "Ana", kind: "text", enabled: true },
        { name: "foto", value: "/Users/ana/foto.png", kind: "file", enabled: true },
        { name: "viejo", value: "x", kind: "text", enabled: false },
      ],
    });
    assert.ok(body);
    assert.equal(body.contentType, "multipart/form-data");
    assert.deepEqual(body.fields, [
      { name: "nombre", value: "Ana", file: false },
      // La ruta del fichero es del disco de quien lo probó: no documenta nada y dice de más.
      { name: "foto", value: "", file: true },
    ]);
  });

  it("sin cuerpo no hay sección de cuerpo, en vez de una vacía", () => {
    assert.equal(docBody({ mode: "none", text: "", contentType: "text/plain", fields: [] }), null);
  });
});

describe("la autenticación heredada", () => {
  it("«inherit» documenta la del proyecto, que es lo que va a pasar de verdad", () => {
    const inherited = endpoint({ path: "/v1/pedidos", auth: { type: "inherit", params: {} } });
    assert.equal(docAuth(inherited, { authType: "bearer", apiKeyName: "" }).type, "bearer");
    assert.equal(docAuth(inherited, { authType: "apikey", apiKeyName: "X-Api-Key" }).label, "API key");
  });

  it("«inherit» sin autenticación en el proyecto es «no pide nada», y se dice así", () => {
    const inherited = endpoint({ path: "/v1/pedidos", auth: { type: "inherit", params: {} } });
    const auth = docAuth(inherited, { authType: "none", apiKeyName: "" });
    assert.equal(auth.type, "none");
    assert.match(auth.detail, /no pide credenciales/);
  });

  it("de una API key sale el nombre por el que entra, y nunca su valor", () => {
    // Sin el nombre, quien lea la página no sabe dónde poner su clave. Con el valor, la página
    // entrega la de quien montó el proyecto.
    const own = endpoint({
      path: "/v1/pedidos",
      auth: { type: "apikey", params: { key: "X-Api-Key", value: "CLAVE-DE-VERDAD", in: "header" } },
    });
    const auth = docAuth(own, { authType: "none", apiKeyName: "" });
    assert.equal(auth.keyName, "X-Api-Key");
    assert.equal(auth.in, "header");
    assert.ok(!JSON.stringify(auth).includes("CLAVE-DE-VERDAD"));

    // Heredada, el nombre sale del proyecto, que es de donde va a salir de verdad.
    const inherited = endpoint({ path: "/v1/pedidos", auth: { type: "inherit", params: {} } });
    assert.equal(docAuth(inherited, { authType: "apikey", apiKeyName: "X-Clave" }).keyName, "X-Clave");
  });

  it("los cuatro tipos del proyecto se traducen a los de un endpoint", () => {
    // Dos listas distintas por historia: el proyecto tiene cuatro tipos y un endpoint los trece de
    // Postman. `api_key` y `apikey` son lo mismo escrito de dos maneras.
    assert.equal(projectAuthType("api_key"), "apikey");
    assert.equal(projectAuthType("bearer"), "bearer");
    assert.equal(projectAuthType("basic"), "basic");
    assert.equal(projectAuthType("none"), "none");
    assert.equal(projectAuthType("lo-que-sea"), "none");
  });
});

describe("la cabecera de la página", () => {
  it("lleva el nombre y la descripción del proyecto, más lo que escribió quien publica", () => {
    const result = page([endpoint({ path: "/v1/a" })], { intro: "Pide una clave a plataforma." });
    assert.equal(result.title, "Pedidos");
    assert.equal(result.description, "La API de pedidos");
    assert.equal(result.intro, "Pide una clave a plataforma.");
    assert.equal(result.generatedAt, NOW.toISOString());
  });
});
