import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ProbeResult } from "../src/types.ts";
import { context, endpoint, result, run } from "./fixtures.ts";

describe("regla error_disclosure", () => {
  const error = (endpointId: string, status: number, bodyText: string) =>
    result({ endpointId, testType: "no-auth", method: "POST", path: "/orders", status, bodyText });

  it("clasifica cada fuga por su gravedad", () => {
    const cases: [string, string, string][] = [
      ["at Object.handler (/app/src/orders.js:12:5)", "high", "una traza de pila"],
      ["Cannot read /srv/app/lib/db/pool.py", "medium", "una ruta de fichero interna"],
      ["Error in node_modules", "medium", "una ruta de dependencias"],
      ["failed: SELECT * FROM users WHERE id = 1", "high", "una consulta SQL"],
      ["Powered by Express/4.18.2", "low", "la versión del framework"],
    ];
    for (const [body, severity, what] of cases) {
      const [finding] = run("error_disclosure", [error("a", 500, body)]);
      assert.equal(finding?.severity, severity, body);
      assert.equal(finding.title, `La respuesta de error revela ${what}`);
    }
  });

  it("una sola respuesta puede revelar varias cosas a la vez", () => {
    const findings = run("error_disclosure", [
      error("a", 500, "at run (/home/app/node_modules/pg/lib/client.js:10:3)"),
    ]);
    assert.deepEqual(
      findings.map((finding) => finding.title.replace("La respuesta de error revela ", "")),
      ["una traza de pila", "una ruta de fichero interna", "una ruta de dependencias"],
    );
  });

  it("repite la misma fuga una vez por endpoint, no una por sonda", () => {
    const trace = "at x (/a/b/c.js:1:1)";
    const findings = run("error_disclosure", [error("a", 500, trace), error("a", 400, trace), error("b", 500, trace)]);
    assert.deepEqual(
      findings.filter((finding) => finding.severity === "high").map((finding) => finding.endpointId),
      ["a", "b"],
    );
  });

  it("solo mira respuestas de error, y un error genérico pasa", () => {
    assert.deepEqual(run("error_disclosure", [error("a", 200, "SELECT id FROM users")]), []);
    assert.deepEqual(run("error_disclosure", [error("a", 500, '{"error":"Algo salió mal"}')]), []);
  });
});

describe("regla verbose_error", () => {
  const malformed = (status: number, bodyText: string, testType = "verbose-error") =>
    result({ endpointId: "c", testType, method: "POST", path: "/orders", status, bodyText });

  it("un 4xx/5xx con la excepción ante JSON roto es medio", () => {
    const [finding] = run("verbose_error", [malformed(400, "SyntaxError: Unexpected token m in JSON at position 2")]);
    assert.equal(finding.severity, "medium");
    assert.equal(finding.title, "Error detallado ante entrada malformada en /orders");
  });

  it("un 400 neutro, un 2xx o un detalle en otra sonda no se marcan", () => {
    assert.deepEqual(run("verbose_error", [malformed(400, '{"message":"JSON inválido"}')]), []);
    assert.deepEqual(run("verbose_error", [malformed(200, "exception swallowed")]), []);
    assert.deepEqual(run("verbose_error", [malformed(500, "Exception", "no-auth")]), []);
  });
});

describe("regla rate_limit", () => {
  const list = endpoint({ id: "l", method: "GET", path: "/orders" });
  const flood = (statuses: number[], responseHeaders: Record<string, string> = {}) =>
    statuses.map((status, index) =>
      result({ endpointId: "l", testType: `rate-limit:${index}`, status, responseHeaders }),
    );
  const ok = (count: number) => Array.from({ length: count }, () => 200);

  it("con menos de cinco peticiones no hay veredicto", () => {
    assert.deepEqual(run("rate_limit", flood(ok(4)), context({ endpoints: [list] })), []);
  });

  it("un solo 429 es que hay límite", () => {
    assert.deepEqual(run("rate_limit", flood([...ok(9), 429]), context({ endpoints: [list] })), []);
  });

  it("con cabeceras de límite pero sin 429 baja a medio", () => {
    const [finding] = run("rate_limit", flood(ok(5), { "X-RateLimit-Limit": "100" }), context({ endpoints: [list] }));
    assert.equal(finding.severity, "medium");
    assert.deepEqual(finding.evidence, { attempts: 5, throttled: false });
    const [retry] = run("rate_limit", flood(ok(5), { "Retry-After": "30" }), context({ endpoints: [list] }));
    assert.equal(retry.severity, "medium");
  });

  it("si alguna petición falló por otra cosa no se afirma que no haya límite", () => {
    assert.deepEqual(run("rate_limit", flood([...ok(5), 503]), context({ endpoints: [list] })), []);
  });
});

describe("regla security_headers", () => {
  const complete = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
  };
  const answer = (responseHeaders: Record<string, string>, patch: Partial<ProbeResult> = {}) =>
    result({ endpointId: "a", testType: "auth:admin", path: "/orders", responseHeaders, ...patch });

  it("con todas las cabeceras, en cualquier capitalización, no hay hallazgo", () => {
    const lower = Object.fromEntries(Object.entries(complete).map(([name, value]) => [name.toLowerCase(), value]));
    assert.deepEqual(run("security_headers", [answer(complete)]), []);
    assert.deepEqual(run("security_headers", [answer(lower)]), []);
  });

  it("si solo falta Referrer-Policy es bajo; si falta una de las medias es medio", () => {
    const { "Referrer-Policy": _referrer, ...withoutReferrer } = complete;
    const [low] = run("security_headers", [answer(withoutReferrer)]);
    assert.equal(low.severity, "low");
    assert.deepEqual(low.evidence, { missing: ["Referrer-Policy"] });

    const { "X-Frame-Options": _frame, ...withoutFrame } = complete;
    const [medium] = run("security_headers", [answer(withoutFrame)]);
    assert.equal(medium.severity, "medium");
    assert.equal(medium.detail, "No se enviaron: X-Frame-Options.");
  });

  it("Server con versión o X-Powered-By delatan la tecnología; Server sin versión no", () => {
    const [server] = run("security_headers", [answer({ ...complete, Server: "nginx/1.25.3" })]);
    assert.equal(server.severity, "low");
    assert.equal(server.detail, "Cabecera Server con versión.");
    const [powered] = run("security_headers", [answer({ ...complete, "X-Powered-By": "Express" })]);
    assert.equal(powered.detail, "Cabecera X-Powered-By con versión.");
    assert.deepEqual(run("security_headers", [answer({ ...complete, Server: "nginx" })]), []);
  });

  it("juzga una respuesta por endpoint, la autenticada antes que la anónima, y salta las que no llegaron", () => {
    const findings = run("security_headers", [
      result({ endpointId: "a", testType: "no-auth", responseHeaders: {} }),
      result({ endpointId: "a", testType: "auth:admin", status: 0, responseHeaders: {} }),
      result({ endpointId: "a", testType: "auth:vendedor", responseHeaders: complete }),
      result({ endpointId: "b", testType: "no-auth", status: 0 }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("sin sonda autenticada usa la anónima", () => {
    const [finding] = run("security_headers", [result({ endpointId: "a", testType: "no-auth", status: 401 })]);
    assert.equal(finding.endpointId, "a");
    assert.equal(finding.severity, "medium");
  });
});

describe("regla cors", () => {
  const cors = (responseHeaders: Record<string, string>) =>
    result({ endpointId: "a", testType: "cors", path: "/orders", responseHeaders });

  it("reflejar el Origin malicioso es alto", () => {
    const [finding] = run("cors", [cors({ "Access-Control-Allow-Origin": "https://evil.example.com" })]);
    assert.equal(finding.severity, "high");
    assert.equal(finding.title, "CORS refleja cualquier origen en /orders");
  });

  it("un comodín sin credenciales o un origen de la lista blanca pasan", () => {
    assert.deepEqual(run("cors", [cors({ "access-control-allow-origin": "*" })]), []);
    assert.deepEqual(
      run("cors", [
        cors({ "access-control-allow-origin": "https://app.example.com", "access-control-allow-credentials": "true" }),
      ]),
      [],
    );
    assert.deepEqual(run("cors", [cors({})]), []);
  });
});

describe("regla content_type", () => {
  it("un tipo equivocado aceptado es medio y nombra el tipo; un 415 pasa", () => {
    const findings = run("content_type", [
      result({ endpointId: "c", testType: "content-type:text/plain", method: "POST", path: "/orders", status: 201 }),
      result({ endpointId: "c", testType: "content-type:application/xml", status: 415 }),
      result({ endpointId: "c", testType: "content-type:none", status: 400 }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "medium");
    assert.deepEqual(findings[0].evidence, { contentType: "text/plain", status: 201 });
  });
});

describe("regla endpoint_consistency", () => {
  const v1 = endpoint({ id: "v1", method: "GET", path: "/api/v1/users" });
  const v2 = endpoint({ id: "v2", method: "GET", path: "/api/v2/users" });
  const noAuth = (endpointId: string, status: number) => result({ endpointId, testType: "no-auth", status });

  it("una versión abierta y otra cerrada del mismo recurso es alto", () => {
    const [finding] = run(
      "endpoint_consistency",
      [noAuth("v1", 200), noAuth("v2", 401)],
      context({ endpoints: [v1, v2] }),
    );
    assert.equal(finding.severity, "high");
    assert.equal(finding.endpointId, "v1");
    assert.equal(finding.title, "Versiones de GET /api/users exigen autenticación distinta");
    assert.deepEqual(finding.evidence, { paths: ["/api/v1/users", "/api/v2/users"] });
  });

  it("versiones coherentes, o una sin sonda, no se marcan", () => {
    assert.deepEqual(
      run("endpoint_consistency", [noAuth("v1", 401), noAuth("v2", 403)], context({ endpoints: [v1, v2] })),
      [],
    );
    assert.deepEqual(run("endpoint_consistency", [noAuth("v1", 200)], context({ endpoints: [v1, v2] })), []);
  });

  it("solo agrupa el mismo método, y un endpoint sin versión hermana no se compara", () => {
    const post = endpoint({ id: "p", method: "POST", path: "/api/v2/users" });
    const alone = endpoint({ id: "s", method: "GET", path: "/api/v1/status" });
    assert.deepEqual(
      run(
        "endpoint_consistency",
        [noAuth("v1", 200), noAuth("p", 401), noAuth("s", 200)],
        context({ endpoints: [v1, post, alone] }),
      ),
      [],
    );
  });
});

describe("regla response_size_anomaly", () => {
  const list = endpoint({ id: "l", method: "GET", path: "/orders" });
  const roles = [
    { name: "admin", sameRoleDataIsolation: false },
    { name: "vendedor", sameRoleDataIsolation: false },
  ];
  const auth = (role: string, bodyBytes: number, status = 200) =>
    result({ endpointId: "l", testType: `auth:${role}`, bodyBytes, status });

  it("sin roles no hay referencia privilegiada y no se juzga", () => {
    assert.deepEqual(
      run("response_size_anomaly", [auth("admin", 1000), auth("vendedor", 1000)], context({ endpoints: [list] })),
      [],
    );
  });

  it("un rol no privilegiado que recibe casi lo mismo que el primero es medio", () => {
    const [finding] = run(
      "response_size_anomaly",
      [auth("admin", 1000), auth("vendedor", 900)],
      context({ endpoints: [list], roles }),
    );
    assert.equal(finding.severity, "medium");
    assert.deepEqual(finding.evidence, { role: "auth:vendedor", bytes: 900, reference: 1000 });
  });

  it("recibir bastante más que el privilegiado también se marca", () => {
    const [finding] = run(
      "response_size_anomaly",
      [auth("admin", 1000), auth("vendedor", 1300)],
      context({ endpoints: [list], roles }),
    );
    assert.equal(finding.evidence.bytes, 1300);
  });

  it("una respuesta claramente recortada, un rol rechazado o sin referencia útil pasan", () => {
    const ctx = context({ endpoints: [list], roles });
    assert.deepEqual(run("response_size_anomaly", [auth("admin", 1000), auth("vendedor", 300)], ctx), []);
    assert.deepEqual(run("response_size_anomaly", [auth("admin", 1000), auth("vendedor", 1000, 403)], ctx), []);
    assert.deepEqual(run("response_size_anomaly", [auth("admin", 0), auth("vendedor", 1000)], ctx), []);
    assert.deepEqual(run("response_size_anomaly", [auth("admin", 1000, 500), auth("vendedor", 1000)], ctx), []);
  });
});
