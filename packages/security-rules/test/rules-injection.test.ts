import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planProbes } from "../src/plan.ts";
import { RULE_KEYS, type ProbeResult, type RuleKey } from "../src/types.ts";
import { context, endpoint, result, run } from "./fixtures.ts";

const search = endpoint({ id: "s", method: "GET", path: "/search" });
const ctx = context({ endpoints: [search] });

describe("regla injection", () => {
  const baseline = (bodyBytes: number) => result({ endpointId: "s", testType: "auth:admin", bodyBytes });
  const inject = (testType: string, patch: Partial<ProbeResult> = {}) =>
    result({ endpointId: "s", testType, method: "POST", path: "/search", ...patch });

  it("un 500 con traza ante un payload es alto, sea del tipo que sea", () => {
    const findings = run(
      "injection",
      [
        inject("injection-sql:0", { status: 500, note: "' OR '1'='1", bodyText: "SQLSTATE[42000]: syntax error" }),
        inject("injection-nosql:0", { status: 502, note: '{"$gt":""}', bodyText: "MongoError: bad query" }),
      ],
      ctx,
    );
    assert.deepEqual(
      findings.map((finding) => [finding.severity, finding.evidence.payload]),
      [
        ["high", "' OR '1'='1"],
        ["high", '{"$gt":""}'],
      ],
    );
    assert.equal(findings[0].title, "Error del servidor ante inyección en /search");
  });

  it("un 500 genérico sin traza, o un 400 con traza, no se atribuye a inyección", () => {
    const findings = run(
      "injection",
      [
        inject("injection-sql:0", { status: 500, bodyText: '{"error":"Internal Server Error"}' }),
        inject("injection-sql:1", { status: 400, bodyText: "Traceback (most recent call last)" }),
      ],
      ctx,
    );
    assert.deepEqual(findings, []);
  });

  it("SQL que devuelve más de 1,5× lo normal es crítico", () => {
    const [finding] = run(
      "injection",
      [baseline(1000), inject("injection-sql:0", { status: 200, bodyBytes: 1501, note: "' OR '1'='1" })],
      ctx,
    );
    assert.equal(finding.severity, "critical");
    assert.deepEqual(finding.evidence, { payload: "' OR '1'='1", bytes: 1501, baseline: 1000 });
  });

  it("SQL con un tamaño parecido al normal, o sin línea base, no se marca", () => {
    assert.deepEqual(run("injection", [baseline(1000), inject("injection-sql:0", { bodyBytes: 1500 })], ctx), []);
    assert.deepEqual(run("injection", [inject("injection-sql:0", { bodyBytes: 99999 })], ctx), []);
    assert.deepEqual(run("injection", [baseline(0), inject("injection-sql:0", { bodyBytes: 99999 })], ctx), []);
  });

  it("el crecimiento de tamaño solo cuenta para SQL, no para NoSQL ni XSS", () => {
    const findings = run(
      "injection",
      [
        baseline(100),
        inject("injection-nosql:0", { bodyBytes: 9999 }),
        inject("injection-xss:0", { bodyBytes: 9999, note: "<script>alert(1)</script>" }),
      ],
      ctx,
    );
    assert.deepEqual(findings, []);
  });

  it("XSS reflejado sin escapar es alto; escapado no", () => {
    const payload = "<script>alert(1)</script>";
    const [reflected] = run(
      "injection",
      [inject("injection-xss:0", { note: payload, bodyText: `{"q":"${payload}"}` })],
      ctx,
    );
    assert.equal(reflected.severity, "high");
    assert.equal(reflected.title, "Payload XSS reflejado en /search");
    assert.deepEqual(
      run(
        "injection",
        [inject("injection-xss:0", { note: payload, bodyText: "&lt;script&gt;alert(1)&lt;/script&gt;" })],
        ctx,
      ),
      [],
    );
    assert.deepEqual(
      run("injection", [inject("injection-xss:0", { status: 400, note: payload, bodyText: payload })], ctx),
      [],
      "un rechazo que repite la entrada no se ejecuta en un navegador como página",
    );
  });

  it("juzga las sondas con el testType que el plan realmente produce (regresión: la regla nunca disparaba)", () => {
    const rules = Object.fromEntries(RULE_KEYS.map((key) => [key, key === "injection"])) as Record<RuleKey, boolean>;
    const planned = planProbes(
      [search],
      {
        roles: [{ name: "admin", hasCredential: true }],
        adminRole: "admin",
        rules,
        rateLimitIterations: 1,
        crossUserPermutations: false,
      },
      [],
    ).filter((probe) => probe.testType.startsWith("injection"));
    assert.equal(planned.length, 7);
    const answered = planned.map((probe) =>
      result({ ...probe, status: 500, bodyText: "Traceback (most recent call last): sqlstate" }),
    );
    const findings = run("injection", answered, ctx);
    assert.equal(findings.length, 7, "cada payload que provoca una traza es un hallazgo");
  });

  it("las sondas de otro endpoint no se mezclan", () => {
    const findings = run(
      "injection",
      [result({ endpointId: "otro", testType: "injection-sql:0", status: 500, bodyText: "sequelize error" })],
      ctx,
    );
    assert.deepEqual(findings, []);
  });
});

describe("regla mass_assignment", () => {
  const mass = (status: number, bodyText: string) =>
    result({ endpointId: "u", testType: "mass-assignment", method: "POST", path: "/users", status, bodyText });

  it("isAdmin reflejado es crítico igual que role admin", () => {
    const [finding] = run("mass_assignment", [mass(201, '{"id":1,"isAdmin":true}')]);
    assert.equal(finding.severity, "critical");
    assert.equal(finding.title, "Asignación masiva aceptada en /users");
  });

  it("aceptar los campos sin reflejarlos ni rechazarlos es alto", () => {
    const [finding] = run("mass_assignment", [mass(200, '{"id":1,"role":"user"}')]);
    assert.equal(finding.severity, "high");
    assert.equal(finding.title, "/users no rechaza campos extra");
  });

  it("un 2xx que no es JSON también se trata como aceptación silenciosa", () => {
    const [finding] = run("mass_assignment", [mass(204, "")]);
    assert.equal(finding.severity, "high");
  });

  it("un 2xx que avisa de campos no permitidos pasa", () => {
    for (const body of ['{"warning":"Unknown field: role"}', "field isAdmin not allowed", '{"errors":["invalid"]}'])
      assert.deepEqual(run("mass_assignment", [mass(200, body)]), [], body);
  });

  it("un rechazo 4xx pasa aunque repita los campos", () => {
    assert.deepEqual(run("mass_assignment", [mass(422, '{"role":"admin"}')]), []);
  });
});

describe("regla data_exposure", () => {
  const users = endpoint({ id: "u", method: "GET", path: "/users" });
  const exposureCtx = context({ endpoints: [users] });

  it("un token o clave de API en la respuesta es alto", () => {
    const [finding] = run(
      "data_exposure",
      [result({ endpointId: "u", testType: "auth:admin", bodyText: '{"name":"x","API_KEY":"k","refresh_token":"r"}' })],
      exposureCtx,
    );
    assert.equal(finding.severity, "high");
    assert.deepEqual(finding.evidence, { fields: ["api_key", "refresh_token"] });
  });

  it("un número de tarjeta suelto es crítico aunque no haya campo sensible", () => {
    const [finding] = run(
      "data_exposure",
      [result({ endpointId: "u", testType: "auth:admin", bodyText: '{"pago":"4111 1111 1111 1111"}' })],
      exposureCtx,
    );
    assert.equal(finding.severity, "critical");
    assert.equal(finding.detail, "La respuesta incluye un número de tarjeta.");
  });

  it("la palabra suelta, sin ser un campo JSON, no cuenta", () => {
    const findings = run(
      "data_exposure",
      [result({ endpointId: "u", testType: "auth:admin", bodyText: '{"hint":"reset your password here"}' })],
      exposureCtx,
    );
    assert.deepEqual(findings, []);
  });

  it("si la sonda autenticada falló, lee la sin autenticar", () => {
    const [finding] = run(
      "data_exposure",
      [
        result({ endpointId: "u", testType: "auth:admin", status: 403, bodyText: '{"secret_key":"s"}' }),
        result({ endpointId: "u", testType: "no-auth", status: 200, bodyText: '{"password":"p","cvv":"123"}' }),
      ],
      exposureCtx,
    );
    assert.equal(finding.severity, "critical");
    assert.deepEqual(finding.evidence, { fields: ["password", "cvv"] });
  });

  it("sin ninguna respuesta 2xx no hay nada que leer", () => {
    const findings = run(
      "data_exposure",
      [result({ endpointId: "u", testType: "no-auth", status: 401, bodyText: '{"password":"p"}' })],
      exposureCtx,
    );
    assert.deepEqual(findings, []);
  });
});
