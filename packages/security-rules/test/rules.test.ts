import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateRules, RULES } from "../src/registry.ts";
import { DEFAULT_RULES, normalizeSelection } from "../src/presets.ts";
import { summarize } from "../src/score.ts";
import type { EndpointMeta, ProbeResult, RuleContext } from "../src/types.ts";

const endpoint = (patch: Partial<EndpointMeta> & Pick<EndpointMeta, "id" | "method" | "path">): EndpointMeta => ({
  requiresAuth: true,
  operationId: null,
  pathParameters: [],
  body: null,
  ...patch,
});

const result = (patch: Partial<ProbeResult> & Pick<ProbeResult, "endpointId" | "testType">): ProbeResult => ({
  id: `${patch.endpointId}::${patch.testType}`,
  method: "GET",
  path: "/x",
  credential: null,
  token: null,
  headers: {},
  body: null,
  contentType: null,
  note: "",
  status: 200,
  responseHeaders: {},
  bodyText: "",
  bodyBytes: 0,
  durationMs: 1,
  error: null,
  sentAuthorization: false,
  ...patch,
});

const context = (patch: Partial<RuleContext> = {}): RuleContext => ({
  authEnforced: true,
  endpoints: [],
  roles: [],
  permissions: [],
  crossRoleRules: [],
  ...patch,
});

describe("las reglas", () => {
  it("son 17 y todas tienen clave distinta", () => {
    assert.equal(RULES.length, 17);
    assert.equal(new Set(RULES.map((rule) => rule.key)).size, 17);
  });

  it("auth: un endpoint que requiere sesión y responde sin token es crítico", () => {
    const findings = evaluateRules(
      [result({ endpointId: "a", testType: "no-auth", path: "/me", status: 200 })],
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/me" })] }),
      DEFAULT_RULES,
    );
    const finding = findings.find((f) => f.ruleKey === "auth_jwt");
    assert.equal(finding?.severity, "critical");
  });

  it("no marca nada de auth cuando el destino no aplica autorización", () => {
    const findings = evaluateRules(
      [result({ endpointId: "a", testType: "no-auth", status: 200 })],
      context({ authEnforced: false, endpoints: [endpoint({ id: "a", method: "GET", path: "/me" })] }),
      DEFAULT_RULES,
    );
    assert.equal(findings.filter((f) => f.ruleKey === "auth_jwt").length, 0);
  });

  it("BOLA: un id alto alcanzable es crítico", () => {
    const findings = evaluateRules(
      [
        result({ endpointId: "a", testType: "bola-id:1", path: "/orders/1", status: 200, bodyText: "a" }),
        result({ endpointId: "a", testType: "bola-id:999", path: "/orders/999", status: 200, bodyText: "b" }),
      ],
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/orders/{id}", pathParameters: ["id"] })] }),
      DEFAULT_RULES,
    );
    assert.equal(findings.find((f) => f.ruleKey === "bola_idor")?.severity, "critical");
  });

  it("BFLA usa el permiso declarado: un rol denegado que pasa es crítico", () => {
    const findings = evaluateRules(
      [result({ endpointId: "a", testType: "auth:vendedor", path: "/admin", status: 200, credential: "vendedor" })],
      context({
        endpoints: [endpoint({ id: "a", method: "DELETE", path: "/admin/users/{id}" })],
        permissions: [{ roleName: "vendedor", endpointId: "a", access: "deny", dataScope: "all" }],
      }),
      DEFAULT_RULES,
    );
    assert.equal(findings.find((f) => f.ruleKey === "bfla")?.severity, "critical");
  });

  it("jwt-attack: un token forjado aceptado es crítico", () => {
    const findings = evaluateRules(
      [result({ endpointId: "a", testType: "jwt-attack:alg-none", token: "forged", status: 200 })],
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/me" })] }),
      DEFAULT_RULES,
    );
    assert.equal(findings.find((f) => f.ruleKey === "jwt_attack")?.severity, "critical");
  });

  it("mass assignment: role admin reflejado es crítico", () => {
    const findings = evaluateRules(
      [
        result({
          endpointId: "a",
          testType: "mass-assignment",
          method: "POST",
          status: 201,
          bodyText: '{"id":1,"role":"admin"}',
        }),
      ],
      context({ endpoints: [endpoint({ id: "a", method: "POST", path: "/users", body: { name: "x" } })] }),
      DEFAULT_RULES,
    );
    assert.equal(findings.find((f) => f.ruleKey === "mass_assignment")?.severity, "critical");
  });

  it("data exposure: una contraseña en la respuesta es crítica", () => {
    const findings = evaluateRules(
      [result({ endpointId: "a", testType: "auth:admin", status: 200, bodyText: '{"email":"a@b.c","password":"x"}' })],
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/users/{id}" })] }),
      DEFAULT_RULES,
    );
    assert.equal(findings.find((f) => f.ruleKey === "data_exposure")?.severity, "critical");
  });

  it("CORS abierto con credenciales es crítico", () => {
    const findings = evaluateRules(
      [
        result({
          endpointId: "a",
          testType: "cors",
          responseHeaders: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" },
        }),
      ],
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/x" })] }),
      normalizeSelection({ cors: true }),
    );
    assert.equal(findings.find((f) => f.ruleKey === "cors")?.severity, "critical");
  });

  it("rate limit: 20 respuestas 200 sin 429 se marca", () => {
    const flood = Array.from({ length: 20 }, (_, i) =>
      result({ endpointId: "a", testType: `rate-limit:${i}`, status: 200 }),
    );
    const findings = evaluateRules(
      flood,
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/x" })] }),
      normalizeSelection({ rate_limit: true }),
    );
    assert.equal(findings.find((f) => f.ruleKey === "rate_limit")?.severity, "high");
  });

  it("evaluar sin resultados no revienta y no inventa hallazgos", () => {
    const findings = evaluateRules([], context(), DEFAULT_RULES);
    assert.ok(Array.isArray(findings));
    assert.equal(findings.length, 0);
  });
});

describe("la puntuación", () => {
  it("baja por severidad y el riesgo es el peor hallazgo", () => {
    const findings = evaluateRules(
      [result({ endpointId: "a", testType: "no-auth", path: "/me", status: 200 })],
      context({ endpoints: [endpoint({ id: "a", method: "GET", path: "/me" })] }),
      DEFAULT_RULES,
    );
    const summary = summarize(
      findings,
      [result({ endpointId: "a", testType: "no-auth", status: 200 })],
      [{ id: "a", method: "GET", path: "/me", requiresAuth: true }],
    );
    assert.equal(summary.risk, "critical");
    assert.ok(summary.score <= 75);
    assert.equal(summary.unprotected.length, 1);
    assert.equal(summary.bySeverity.critical, 1);
  });

  it("sin hallazgos: 100 y riesgo bajo", () => {
    const summary = summarize(
      [],
      [result({ endpointId: "a", testType: "auth:admin", status: 200 })],
      [{ id: "a", method: "GET", path: "/x", requiresAuth: true }],
    );
    assert.equal(summary.score, 100);
    assert.equal(summary.risk, "low");
    assert.equal(summary.unprotected.length, 0);
  });
});
