/**
 * Qué contesta el mock: encontrar la ruta, elegir el ejemplo, y limpiar la respuesta.
 *
 * Lo que se comprueba aquí es sobre todo **cómo se elige cuando hay varias opciones**, que es donde
 * un mock se vuelve inútil sin avisar: si `/users/{id}` le gana a `/users/me`, si el primer ejemplo
 * guardado decide para siempre, si un `?page=2` contesta la página uno. Las tres pasan
 * silenciosamente y las tres se leen como «el mock está roto».
 *
 * Y las tres maneras de no contestar, que llevan códigos distintos a propósito: la ruta no existe
 * (404), existe con otro método (405), o existe y nadie ha guardado nunca lo que devuelve (501). Un
 * mock que contestara 404 a las tres es indistinguible de un mock averiado.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blankEndpoint, type Endpoint, type EndpointHeader } from "@/modules/endpoints/domain/model";
import { blankExample, type EndpointExample } from "@/modules/endpoints/domain/examples";
import {
  chooseExample,
  matchRoute,
  nearestRoutes,
  normalizeMockPath,
  queryOf,
  requestScore,
  responseHeaders,
  routeTemplate,
  serveMock,
  type MockRequest,
} from "@/modules/mocks/domain/serve-mock";

const NOW = new Date("2026-03-01T10:00:00.000Z");

let sequence = 0;
const nextId = () => `00000000-0000-4000-8000-${String((sequence += 1)).padStart(12, "0")}`;

function endpoint(method: string, path: string, orderIndex = 0): Endpoint {
  return {
    ...blankEndpoint({
      id: nextId(),
      projectId: "project-1",
      origin: "manual",
      orderIndex,
      now: NOW,
      actorId: "actor-1",
    }),
    method: method as Endpoint["method"],
    path,
  };
}

function example(
  endpointId: string,
  patch: {
    name?: string;
    status?: number;
    url?: string;
    body?: string;
    contentType?: string;
    requestBody?: string;
    headers?: EndpointHeader[];
    orderIndex?: number;
  },
): EndpointExample {
  return blankExample({
    projectId: "project-1",
    endpointId,
    name: patch.name ?? `ejemplo ${(sequence += 1)}`,
    request: {
      method: "GET",
      url: patch.url ?? "https://api.test/x",
      headers: [],
      body: { text: patch.requestBody ?? "", contentType: "application/json" },
    },
    response: {
      status: patch.status ?? 200,
      headers: patch.headers ?? [],
      body: patch.body ?? "{}",
      contentType: patch.contentType ?? "application/json",
      durationMs: 12,
    },
    origin: "manual",
    orderIndex: patch.orderIndex ?? 0,
    now: NOW,
    actorId: "actor-1",
  });
}

const request = (patch: Partial<MockRequest> = {}): MockRequest => ({
  method: "GET",
  path: "/",
  query: [],
  headers: {},
  ...patch,
});

const answer = (endpoints: Endpoint[], examples: EndpointExample[], patch: Partial<MockRequest> = {}) =>
  serveMock(endpoints, (endpointId) => examples.filter((row) => row.endpointId === endpointId), request(patch));

describe("normalizeMockPath", () => {
  it("una barra de sobra al final o en medio es la misma ruta", () => {
    assert.equal(normalizeMockPath("/users/"), "/users");
    assert.equal(normalizeMockPath("users"), "/users");
    assert.equal(normalizeMockPath("//users//42/"), "/users/42");
  });

  it("la raíz se queda en una barra y no en la cadena vacía", () => {
    assert.equal(normalizeMockPath(""), "/");
    assert.equal(normalizeMockPath("/"), "/");
  });
});

describe("routeTemplate", () => {
  it("un hueco vale por un segmento, no por varios", () => {
    const { re } = routeTemplate("/users/{id}");
    assert.ok(re.test("/users/42"));
    // Sin esto `/users/{id}` se comería `/users/42/pedidos`, que es otro endpoint con otra respuesta.
    assert.equal(re.test("/users/42/pedidos"), false);
    assert.equal(re.test("/users"), false);
  });

  it("el hueco puede ser parte de un segmento, como en los contratos de verdad", () => {
    const { re } = routeTemplate("/files/{id}.json");
    assert.ok(re.test("/files/42.json"));
    assert.equal(re.test("/files/42.xml"), false);
  });

  it("un punto de la ruta es un punto y no «cualquier carácter»", () => {
    const { re } = routeTemplate("/v1.0/status");
    assert.ok(re.test("/v1.0/status"));
    assert.equal(re.test("/v1X0/status"), false);
  });

  it("una {{variable}} de entorno encaja con cualquier segmento, porque aquí no se sabe su valor", () => {
    const { re, names } = routeTemplate("/{{tenant}}/users/{id}");
    assert.ok(re.test("/acme/users/42"));
    // Y no es un parámetro de ruta: nadie la escribió como hueco del endpoint.
    assert.deepEqual(names, ["id"]);
  });

  it("la forma dice qué segmentos son literales, que es lo que ordena por especificidad", () => {
    assert.equal(routeTemplate("/users/me").shape, "11");
    assert.equal(routeTemplate("/users/{id}").shape, "10");
    assert.equal(routeTemplate("/").shape, "");
  });
});

describe("matchRoute", () => {
  it("lo literal gana a lo que tiene hueco", () => {
    const literal = endpoint("GET", "/users/me", 9);
    const hueco = endpoint("GET", "/users/{id}", 0);
    // Y gana aunque el otro esté antes en el proyecto: la especificidad manda sobre el orden.
    const match = matchRoute([hueco, literal], request({ path: "/users/me" }));
    assert.equal(match.kind, "route");
    assert.equal(match.kind === "route" && match.endpoint.path, "/users/me");
  });

  it("decide de izquierda a derecha, como cualquier enrutador", () => {
    const left = endpoint("GET", "/a/{x}/c");
    const right = endpoint("GET", "/{a}/b/c");
    const match = matchRoute([right, left], request({ path: "/a/b/c" }));
    assert.equal(match.kind === "route" && match.endpoint.path, "/a/{x}/c");
  });

  it("la ruta que no está no encaja con la que tiene hueco en otro sitio", () => {
    assert.equal(matchRoute([endpoint("GET", "/users/{id}")], request({ path: "/pedidos/42" })).kind, "no-route");
  });

  it("la misma ruta con otro método da «wrong-method» y no «no-route»", () => {
    const match = matchRoute(
      [endpoint("GET", "/users"), endpoint("DELETE", "/users")],
      request({ method: "POST", path: "/users" }),
    );
    assert.equal(match.kind, "wrong-method");
    assert.deepEqual(match.kind === "wrong-method" && match.allow, ["DELETE", "GET", "HEAD"]);
  });

  it("un GET declarado implica que HEAD se puede pedir, y lo contesta el ejemplo del GET", () => {
    const match = matchRoute([endpoint("GET", "/users")], request({ method: "HEAD", path: "/users" }));
    assert.equal(match.kind, "route");
  });

  it("un HEAD propio declarado le gana al GET que lo atendería", () => {
    const propio = endpoint("HEAD", "/users", 5);
    const match = matchRoute([endpoint("GET", "/users", 0), propio], request({ method: "HEAD", path: "/users" }));
    assert.equal(match.kind === "route" && match.endpoint.id, propio.id);
  });

  it("el método se compara sin distinguir mayúsculas", () => {
    assert.equal(matchRoute([endpoint("GET", "/users")], request({ method: "get", path: "/users" })).kind, "route");
  });

  it("a igualdad completa manda el orden del proyecto, para que sea determinista", () => {
    const primero = endpoint("GET", "/users/{a}", 1);
    const segundo = endpoint("GET", "/users/{b}", 2);
    const match = matchRoute([segundo, primero], request({ path: "/users/9" }));
    assert.equal(match.kind === "route" && match.endpoint.id, primero.id);
  });
});

describe("nearestRoutes", () => {
  it("propone la que comparte camino", () => {
    const near = nearestRoutes([endpoint("GET", "/users/{id}"), endpoint("GET", "/pedidos")], "/users/42/avatar");
    assert.deepEqual(near, ["GET /users/{id}"]);
  });

  it("propone la que empieza igual, que es el error de verdad: la «s» que falta", () => {
    assert.deepEqual(nearestRoutes([endpoint("GET", "/users/{id}")], "/user/42"), ["GET /users/{id}"]);
  });

  it("tener el mismo número de segmentos no es parecerse, y entonces se calla", () => {
    // «Pediste /usuarios, ¿querías /pedidos?» es peor que un 404 a secas.
    assert.deepEqual(nearestRoutes([endpoint("GET", "/pedidos")], "/usuarios"), []);
  });

  it("y no propone nada cuando el proyecto no tiene nada que se parezca", () => {
    assert.deepEqual(nearestRoutes([endpoint("GET", "/facturas/{id}")], "/x"), []);
  });
});

describe("queryOf", () => {
  it("lee la cadena de consulta de una URL relativa, absoluta o con variables", () => {
    assert.deepEqual(
      [...queryOf("/x?page=2&sort=asc")],
      [
        ["page", ["2"]],
        ["sort", ["asc"]],
      ],
    );
    assert.deepEqual([...queryOf("{{baseUrl}}/x?page=2")], [["page", ["2"]]]);
    assert.deepEqual([...queryOf("/x")], []);
  });

  it("un parámetro repetido conserva sus dos valores", () => {
    assert.deepEqual([...queryOf("/x?tag=a&tag=b")], [["tag", ["a", "b"]]]);
  });
});

describe("requestScore", () => {
  it("lo que el ejemplo no menciona no cuenta en ningún sentido", () => {
    const row = example("e1", { url: "/x" });
    assert.equal(requestScore(row, request({ query: [["page", "2"]] })), 0);
  });

  it("lo que dice otra cosa resta, y por eso un ejemplo gordo no gana por ser gordo", () => {
    const uno = example("e1", { url: "/x?page=1" });
    assert.equal(requestScore(uno, request({ query: [["page", "2"]] })), -1);
    assert.equal(requestScore(uno, request({ query: [["page", "1"]] })), 1);
  });

  it("el cuerpo JSON también desempata, campo a campo", () => {
    const bueno = example("e1", { requestBody: '{"user":"ana","pass":"buena"}' });
    assert.equal(requestScore(bueno, request({ body: { user: "ana", pass: "buena" } })), 2);
    assert.equal(requestScore(bueno, request({ body: { user: "ana", pass: "mala" } })), 0);
  });

  it("un cuerpo que no es JSON no resta ni suma: no se puede comparar y no se finge", () => {
    const row = example("e1", { requestBody: "<xml/>" });
    assert.equal(requestScore(row, request({ body: { a: 1 } })), 0);
  });
});

describe("chooseExample", () => {
  it("sin ejemplos es un 501 y no un 404: la ruta existe, la respuesta no", () => {
    const choice = chooseExample([], request());
    assert.equal(choice.kind, "problem");
    assert.equal(choice.kind === "problem" && choice.status, 501);
    assert.equal(choice.kind === "problem" && choice.code, "mock-no-example");
  });

  it("el 2xx más bajo por defecto, y no el primero que se guardó", () => {
    // Lo normal es guardar primero lo que sorprende, que es el error. «El primero» —lo que hace
    // Postman— dejaría este mock contestando 500 a todo.
    const error = example("e1", { status: 500, orderIndex: 0 });
    const bueno = example("e1", { status: 201, orderIndex: 1 });
    const choice = chooseExample([error, bueno], request());
    assert.equal(choice.kind === "example" && choice.example.id, bueno.id);
  });

  it("sin ningún 2xx contesta el estado más bajo que haya", () => {
    const choice = chooseExample([example("e1", { status: 500 }), example("e1", { status: 404 })], request());
    assert.equal(choice.kind === "example" && choice.example.response.status, 404);
  });

  it("se puede pedir un ejemplo por su nombre", () => {
    const roto = example("e1", { name: "el 409", status: 409 });
    const choice = chooseExample(
      [example("e1", { status: 200 }), roto],
      request({ headers: { "x-eq-mock-example": "el 409" } }),
    );
    assert.equal(choice.kind === "example" && choice.example.id, roto.id);
    assert.equal(choice.kind === "example" && choice.reason, "by-name");
  });

  it("y por su id, que es lo que tiene a mano quien lo leyó de la lista", () => {
    const row = example("e1", { status: 409 });
    const choice = chooseExample([row], request({ headers: { "x-eq-mock-example": row.id } }));
    assert.equal(choice.kind === "example" && choice.example.id, row.id);
  });

  it("un nombre que no existe es un 400 y **no** otro ejemplo", () => {
    // Servir otro sería lo peor: la prueba que pidió el camino de error pasaría en verde contra el
    // de éxito, y nadie se enteraría nunca.
    const choice = chooseExample(
      [example("e1", { name: "ok" })],
      request({ headers: { "x-eq-mock-example": "el 409" } }),
    );
    assert.equal(choice.kind === "problem" && choice.code, "mock-example-unknown");
    assert.match(choice.kind === "problem" ? choice.detail : "", /«ok»/);
  });

  it("se puede pedir por estado, que es lo que permite probar el error sin tocar el mock", () => {
    const choice = chooseExample(
      [example("e1", { status: 200 }), example("e1", { status: 422 })],
      request({ headers: { "x-eq-mock-status": "422" } }),
    );
    assert.equal(choice.kind === "example" && choice.example.response.status, 422);
    assert.equal(choice.kind === "example" && choice.reason, "by-status");
  });

  it("las cabeceras de Postman valen igual, que es lo que permite traerse sus pruebas", () => {
    const choice = chooseExample(
      [example("e1", { status: 200 }), example("e1", { status: 404 })],
      request({ headers: { "x-mock-response-code": "404" } }),
    );
    assert.equal(choice.kind === "example" && choice.example.response.status, 404);
  });

  it("un estado sin ejemplo es un 400 que dice cuáles hay", () => {
    const choice = chooseExample(
      [example("e1", { status: 200 }), example("e1", { status: 404 })],
      request({ headers: { "x-eq-mock-status": "418" } }),
    );
    assert.equal(choice.kind === "problem" && choice.code, "mock-status-unknown");
    assert.match(choice.kind === "problem" ? choice.detail : "", /200, 404/);
  });

  it("la cadena de consulta elige entre dos ejemplos de la misma ruta", () => {
    const una = example("e1", { url: "/users?page=1", body: '{"page":1}' });
    const dos = example("e1", { url: "/users?page=2", body: '{"page":2}' });
    const choice = chooseExample([una, dos], request({ query: [["page", "2"]] }));
    assert.equal(choice.kind === "example" && choice.example.id, dos.id);
    assert.equal(choice.kind === "example" && choice.reason, "request-match");
  });

  it("empatados en lo que encaja, decide lo de siempre y no el azar", () => {
    const error = example("e1", { url: "/x?a=1", status: 500 });
    const bueno = example("e1", { url: "/x?a=1", status: 200 });
    const choice = chooseExample([error, bueno], request({ query: [["a", "1"]] }));
    assert.equal(choice.kind === "example" && choice.example.id, bueno.id);
  });
});

describe("responseHeaders", () => {
  it("un content-encoding heredado se va, porque el cuerpo se guardó ya descomprimido", () => {
    const row = example("e1", {
      headers: [
        { name: "Content-Encoding", value: "gzip", enabled: true },
        { name: "X-Total", value: "42", enabled: true },
      ],
    });
    const names = responseHeaders(row).map((header) => header.name);
    assert.equal(names.includes("Content-Encoding"), false);
    assert.ok(names.includes("X-Total"));
  });

  it("se van también las de la conexión de entonces y las fechas guardadas", () => {
    const row = example("e1", {
      headers: [
        { name: "Content-Length", value: "999", enabled: true },
        { name: "Transfer-Encoding", value: "chunked", enabled: true },
        { name: "Connection", value: "keep-alive", enabled: true },
        { name: "Date", value: "Mon, 01 Jan 2020 00:00:00 GMT", enabled: true },
        { name: "Strict-Transport-Security", value: "max-age=31536000", enabled: true },
        { name: "Access-Control-Allow-Origin", value: "https://otro.test", enabled: true },
      ],
    });
    assert.deepEqual(
      responseHeaders(row).map((header) => header.name),
      ["Content-Type"],
    );
  });

  it("un salto de línea en el valor se va: es una inyección de cabeceras, no una cabecera", () => {
    // La validación del ejemplo ya no deja entrar uno, pero el importador construye ejemplos sin
    // pasar por ella, y esta es la puerta que cubre ese camino.
    const row = example("e1", { headers: [{ name: "X-Malo", value: "a\r\nX-Inyectada: si", enabled: true }] });
    const malo = responseHeaders(row).find((header) => header.name === "X-Malo");
    assert.equal(malo?.value, "aX-Inyectada: si");
  });

  it("un nombre que no es un token de HTTP se descarta entero", () => {
    const row = example("e1", { headers: [{ name: "X Malo", value: "1", enabled: true }] });
    assert.equal(
      responseHeaders(row).some((header) => header.name === "X Malo"),
      false,
    );
  });

  it("una cabecera apagada no sale", () => {
    const row = example("e1", { headers: [{ name: "X-Off", value: "1", enabled: false }] });
    assert.equal(
      responseHeaders(row).some((header) => header.name === "X-Off"),
      false,
    );
  });

  it("sin Content-Type se pone el del ejemplo: sin él el navegador adivina, y adivina mal", () => {
    const row = example("e1", { contentType: "application/problem+json", headers: [] });
    assert.deepEqual(responseHeaders(row), [
      { name: "Content-Type", value: "application/problem+json", enabled: true },
    ]);
  });

  it("y el del ejemplo no pisa el que ya venía en las cabeceras", () => {
    const row = example("e1", {
      contentType: "text/plain",
      headers: [{ name: "content-type", value: "application/json; charset=utf-8", enabled: true }],
    });
    assert.deepEqual(
      responseHeaders(row).map((header) => header.value),
      ["application/json; charset=utf-8"],
    );
  });
});

describe("serveMock", () => {
  it("contesta el ejemplo con su estado, su cuerpo y su rastro", () => {
    const users = endpoint("GET", "/users/{id}");
    const row = example(users.id, { status: 200, body: '{"id":42}' });
    const outcome = answer([users], [row], { path: "/users/42" });
    assert.equal(outcome.kind, "hit");
    if (outcome.kind !== "hit") return;
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body, '{"id":42}');
    assert.equal(outcome.trace.endpointRoute, "GET /users/{id}");
    assert.equal(outcome.trace.reason, "lowest-2xx");
  });

  it("la ruta que no está es un 404 que dice a qué se parece", () => {
    const outcome = answer([endpoint("GET", "/users/{id}")], [], { path: "/users" });
    assert.equal(outcome.kind === "problem" && outcome.status, 404);
    assert.match(outcome.kind === "problem" ? outcome.detail : "", /GET \/users\/\{id\}/);
  });

  it("el método equivocado es un 405 con Allow, que es lo que resuelve el caso", () => {
    const outcome = answer([endpoint("GET", "/users")], [], { method: "POST", path: "/users" });
    assert.equal(outcome.kind === "problem" && outcome.status, 405);
    assert.deepEqual(outcome.kind === "problem" ? outcome.allow : [], ["GET", "HEAD"]);
  });

  it("la ruta sin ejemplos es un 501, y dice cómo se arregla", () => {
    const outcome = answer([endpoint("GET", "/users")], [], { path: "/users" });
    assert.equal(outcome.kind === "problem" && outcome.status, 501);
    assert.match(outcome.kind === "problem" ? outcome.detail : "", /guarda la respuesta/);
  });

  it("un HEAD trae las cabeceras del GET y ningún cuerpo", () => {
    const users = endpoint("GET", "/users");
    const row = example(users.id, { body: '{"total":3}', headers: [{ name: "X-Total", value: "3", enabled: true }] });
    const outcome = answer([users], [row], { method: "HEAD", path: "/users" });
    assert.equal(outcome.kind, "hit");
    if (outcome.kind !== "hit") return;
    assert.equal(outcome.body, "");
    assert.ok(outcome.headers.some((header) => header.name === "X-Total"));
  });

  it("los ejemplos de otro endpoint no se mezclan", () => {
    const users = endpoint("GET", "/users");
    const pedidos = endpoint("GET", "/pedidos");
    const outcome = answer([users, pedidos], [example(pedidos.id, { status: 200 })], { path: "/users" });
    assert.equal(outcome.kind === "problem" && outcome.code, "mock-no-example");
  });

  it("un proyecto sin ningún endpoint contesta 404 y dice cuántas rutas sirve", () => {
    const outcome = answer([], [], { path: "/users" });
    assert.match(outcome.kind === "problem" ? outcome.detail : "", /ninguna de las 0 rutas/);
  });
});
