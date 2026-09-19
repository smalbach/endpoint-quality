import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { context, endpoint, jwt, result, run } from "./fixtures.ts";

const me = endpoint({ id: "me", method: "GET", path: "/me" });

describe("regla auth_jwt", () => {
  it("un endpoint público que responde sin token no es un hallazgo", () => {
    const findings = run(
      "auth_jwt",
      [result({ endpointId: "pub", testType: "no-auth", status: 200 })],
      context({ endpoints: [endpoint({ id: "pub", method: "GET", path: "/health", requiresAuth: false })] }),
    );
    assert.deepEqual(findings, []);
  });

  it("un endpoint protegido que rechaza sin token pasa", () => {
    for (const status of [401, 403, 0])
      assert.deepEqual(
        run("auth_jwt", [result({ endpointId: "me", testType: "no-auth", status })], context({ endpoints: [me] })),
        [],
      );
  });

  it("el hallazgo sin autenticación cuenta cómo reproducirlo con la ruta enviada", () => {
    const [finding] = run(
      "auth_jwt",
      [result({ endpointId: "me", testType: "no-auth", path: "/me?x=1", status: 204 })],
      context({ endpoints: [me] }),
    );
    assert.equal(finding.endpointId, "me");
    assert.equal(finding.title, "GET /me responde sin autenticación");
    assert.deepEqual(finding.reproduce, ["GET /me?x=1 sin Authorization", "Respuesta 204"]);
    assert.deepEqual(finding.evidence, { status: 204 });
    assert.equal(finding.ruleId, "OWASP-API2-BROKEN-AUTH");
    assert.equal(finding.references.length, 2);
  });

  it("un token con alg:none y sin exp da un crítico y un alto", () => {
    const token = jwt({ alg: "None" }, { sub: "u" });
    const findings = run(
      "auth_jwt",
      [result({ endpointId: "me", testType: "auth:admin", headers: { Authorization: `Bearer ${token}` } })],
      context({ endpoints: [me] }),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.severity, finding.title]),
      [
        ["critical", "El token viaja con alg: none"],
        ["high", "El token no caduca"],
      ],
    );
    assert.deepEqual(findings[1].evidence, { claims: ["sub"] });
  });

  it("un token firmado y con exp no da hallazgos", () => {
    const token = jwt({ alg: "RS256" }, { sub: "u", exp: 9_999_999_999 });
    const findings = run(
      "auth_jwt",
      [result({ endpointId: "me", testType: "auth:admin", headers: { Authorization: `Bearer ${token}` } })],
      context({ endpoints: [me] }),
    );
    assert.deepEqual(findings, []);
  });

  it("salta los tokens opacos y lee la forma del primer JWT, una sola vez", () => {
    const noExp = jwt({ alg: "HS256" }, { sub: "u" });
    const findings = run("auth_jwt", [
      result({ endpointId: "a", testType: "auth:api", headers: { Authorization: "ApiKey opaco" } }),
      result({ endpointId: "b", testType: "auth:admin" }),
      result({ endpointId: "c", testType: "auth:admin", headers: { Authorization: `Bearer ${noExp}` } }),
      result({ endpointId: "d", testType: "auth:vendedor", headers: { Authorization: `Bearer ${noExp}` } }),
    ]);
    assert.deepEqual(
      findings.map((finding) => `${finding.endpointId} ${finding.title}`),
      ["c El token no caduca"],
    );
  });

  it("no lee la forma del token en sondas que no son auth:<rol>", () => {
    const token = jwt({ alg: "none" }, { sub: "u" });
    const findings = run("auth_jwt", [
      result({ endpointId: "a", testType: "jwt-attack:alg-none", headers: { Authorization: `Bearer ${token}` } }),
      result({ endpointId: "a", testType: "no-auth", headers: { Authorization: `Bearer ${token}` } }),
    ]);
    assert.deepEqual(findings, []);
  });
});

describe("regla jwt_attack", () => {
  const attack = (name: string, status = 200, token: string | null = "Bearer forjado") =>
    result({ endpointId: "me", testType: `jwt-attack:${name}`, method: "GET", path: "/me", status, token });

  it("alg-none y tampered aceptados son críticos; expired es alto", () => {
    const findings = run("jwt_attack", [attack("alg-none"), attack("tampered"), attack("expired")]);
    assert.deepEqual(
      findings.map((finding) => [finding.evidence.attack, finding.severity]),
      [
        ["alg-none", "critical"],
        ["tampered", "critical"],
        ["expired", "high"],
      ],
    );
    assert.equal(findings[2].title, "El servidor aceptó un token caducado");
    assert.deepEqual(findings[0].reproduce, ["GET /me con un token con alg: none → 200"]);
  });

  it("un token forjado rechazado no es hallazgo", () => {
    assert.deepEqual(run("jwt_attack", [attack("alg-none", 401), attack("expired", 403), attack("tampered", 500)]), []);
  });

  it("si el ejecutor no pudo forjar token, un 2xx no significa nada", () => {
    assert.deepEqual(run("jwt_attack", [attack("alg-none", 200, null)]), []);
  });

  it("un ataque sin etiqueta conocida se nombra tal cual y es alto", () => {
    const [finding] = run("jwt_attack", [attack("kid")]);
    assert.equal(finding.severity, "high");
    assert.equal(finding.title, "El servidor aceptó kid");
  });
});
