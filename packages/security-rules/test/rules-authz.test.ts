import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CrossRoleMeta, PermissionMeta } from "../src/types.ts";
import { context, endpoint, result, run } from "./fixtures.ts";

const detail = endpoint({ id: "d", method: "GET", path: "/orders/{id}" });

describe("regla bola_idor", () => {
  const bola = (id: string, status: number, bodyText = "") =>
    result({ endpointId: "d", testType: `bola-id:${id}`, path: `/orders/${id}`, status, bodyText });

  it("ids bajos alcanzables con cuerpos distintos: enumeración de objetos", () => {
    const [finding] = run(
      "bola_idor",
      [bola("1", 200, '{"id":1}'), bola("2", 200, '{"id":2}'), bola("999", 404), bola("99999", 404)],
      context({ endpoints: [detail] }),
    );
    assert.equal(finding.severity, "critical");
    assert.equal(finding.title, "Ids secuenciales devuelven datos distintos en /orders/{id}");
    assert.deepEqual(finding.evidence, { ids: ["1", "2"] });
    assert.deepEqual(finding.reproduce, ["GET /orders/1 → 200", "GET /orders/2 → 200"]);
  });

  it("el id arbitrario reportado es el que respondió, con su ruta", () => {
    const [finding] = run("bola_idor", [bola("999", 404), bola("99999", 200, "x")], context({ endpoints: [detail] }));
    assert.match(finding.detail, /id 99999/);
    assert.deepEqual(finding.evidence, { path: "/orders/99999", status: 200 });
  });

  it("el mismo cuerpo para todos los ids (p. ej. una página genérica) no se marca", () => {
    const findings = run(
      "bola_idor",
      [bola("1", 200, "igual"), bola("2", 200, "igual"), bola("999", 404), bola("99999", 404)],
      context({ endpoints: [detail] }),
    );
    assert.deepEqual(findings, []);
  });

  it("un solo id bajo alcanzable no basta", () => {
    assert.deepEqual(run("bola_idor", [bola("1", 200, "a"), bola("2", 403)], context({ endpoints: [detail] })), []);
  });

  it("un endpoint sin sondas BOLA no se juzga", () => {
    const other = endpoint({ id: "otro", method: "GET", path: "/users/{id}" });
    assert.deepEqual(run("bola_idor", [bola("999", 200)], context({ endpoints: [other] })), []);
  });
});

describe("regla bfla", () => {
  const admin = endpoint({ id: "a", method: "DELETE", path: "/admin/users/{id}" });
  const permission = (roleName: string, access: "allow" | "deny"): PermissionMeta => ({
    roleName,
    endpointId: "a",
    access,
    dataScope: "all",
  });
  const auth = (role: string, status: number) =>
    result({ endpointId: "a", testType: `auth:${role}`, path: "/admin/users/1", status });

  it("un rol con permiso que es rechazado es alto: la regla está mal", () => {
    const [finding] = run(
      "bfla",
      [auth("soporte", 403)],
      context({ endpoints: [admin], permissions: [permission("soporte", "allow")] }),
    );
    assert.equal(finding.severity, "high");
    assert.equal(finding.title, "«soporte» fue rechazado en /admin/users/{id} pese a tener permiso");
    assert.deepEqual(finding.evidence, { role: "soporte", status: 403 });
  });

  it("lo declarado que se cumple no da hallazgos", () => {
    const findings = run(
      "bfla",
      [auth("soporte", 200), auth("vendedor", 403), auth("lector", 401)],
      context({
        endpoints: [admin],
        permissions: [permission("soporte", "allow"), permission("vendedor", "deny"), permission("lector", "deny")],
      }),
    );
    assert.deepEqual(findings, []);
  });

  it("un permiso con un error de servidor no se interpreta como rechazo", () => {
    const findings = run(
      "bfla",
      [auth("soporte", 500)],
      context({ endpoints: [admin], permissions: [permission("soporte", "allow")] }),
    );
    assert.deepEqual(findings, []);
  });

  it("un permiso declarado para un rol que no se probó se ignora", () => {
    assert.deepEqual(
      run("bfla", [auth("otro", 200)], context({ endpoints: [admin], permissions: [permission("vendedor", "deny")] })),
      [],
    );
  });

  it("sin permisos declarados, la heurística marca como alto al rol no admin que ejecutó la función", () => {
    const findings = run(
      "bfla",
      [
        result({ endpointId: "a", testType: "bfla:vendedor", status: 204, path: "/admin/users/1" }),
        result({ endpointId: "a", testType: "bfla:lector", status: 403, path: "/admin/users/1" }),
      ],
      context({ endpoints: [admin] }),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.severity, finding.evidence.role]),
      [["high", "vendedor"]],
    );
    assert.deepEqual(findings[0].reproduce, ["DELETE /admin/users/1 como vendedor → 204"]);
  });

  it("con permisos declarados, la heurística se calla", () => {
    const findings = run(
      "bfla",
      [result({ endpointId: "a", testType: "bfla:vendedor", status: 200 }), auth("vendedor", 403)],
      context({ endpoints: [admin], permissions: [permission("vendedor", "deny")] }),
    );
    assert.deepEqual(findings, []);
  });

  it("no juzga nada si el destino no aplica autorización", () => {
    const findings = run(
      "bfla",
      [auth("vendedor", 200), result({ endpointId: "a", testType: "bfla:vendedor", status: 200 })],
      context({ authEnforced: false, endpoints: [admin], permissions: [permission("vendedor", "deny")] }),
    );
    assert.deepEqual(findings, []);
  });
});

describe("regla cross_user_access", () => {
  const rule = (patch: Partial<CrossRoleMeta> = {}): CrossRoleMeta => ({
    source: "vendedor",
    target: "cliente",
    canRead: true,
    canWrite: true,
    canDelete: true,
    ...patch,
  });
  const reach = (endpointId: string, role: string, id: string, status = 200, bodyBytes = 0) =>
    result({ endpointId, testType: `bola-real-id:${role}:${id}`, path: `/orders/${id}`, status, bodyBytes });

  it("leer un objeto ajeno cuando la regla lo prohíbe es crítico", () => {
    const [finding] = run(
      "cross_user_access",
      [reach("d", "cliente", "11")],
      context({ endpoints: [detail], crossRoleRules: [rule({ canRead: false })] }),
    );
    assert.equal(finding.severity, "critical");
    assert.equal(finding.title, "«cliente» accedió a un objeto de «vendedor» en /orders/{id}");
    assert.match(finding.detail, /no permite leer/);
    assert.deepEqual(finding.evidence, { source: "vendedor", target: "cliente", method: "GET" });
  });

  it("el verbo se compara con el permiso que le toca", () => {
    const put = endpoint({ id: "p", method: "PUT", path: "/orders/{id}" });
    const del = endpoint({ id: "x", method: "DELETE", path: "/orders/{id}" });
    const findings = run(
      "cross_user_access",
      [reach("p", "cliente", "11"), reach("x", "cliente", "11"), reach("d", "cliente", "11")],
      context({
        endpoints: [detail, put, del],
        crossRoleRules: [rule({ canWrite: false, canDelete: false })],
      }),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.endpointId, /no permite (\w+)/.exec(finding.detail)?.[1]]),
      [
        ["p", "escribir"],
        ["x", "borrar"],
      ],
      "el GET está permitido por canRead",
    );
  });

  it("un método que no es de lectura, escritura ni borrado no viola la regla", () => {
    const head = endpoint({ id: "h", method: "HEAD", path: "/orders/{id}" });
    const findings = run(
      "cross_user_access",
      [reach("h", "cliente", "11")],
      context({ endpoints: [head], crossRoleRules: [rule({ canRead: false, canWrite: false, canDelete: false })] }),
    );
    assert.deepEqual(findings, []);
  });

  it("si el rol destino fue rechazado, o nunca se probó, no hay hallazgo", () => {
    const forbid = context({ endpoints: [detail], crossRoleRules: [rule({ canRead: false })] });
    assert.deepEqual(run("cross_user_access", [reach("d", "cliente", "11", 403)], forbid), []);
    assert.deepEqual(run("cross_user_access", [reach("d", "vendedor", "11")], forbid), []);
  });

  it("aislamiento: dos objetos distintos con respuestas casi iguales para un rol aislado es alto", () => {
    const [finding] = run(
      "cross_user_access",
      [reach("d", "cliente", "11", 200, 500), reach("d", "cliente", "12", 200, 510)],
      context({ endpoints: [detail], roles: [{ name: "cliente", sameRoleDataIsolation: true }] }),
    );
    assert.equal(finding.severity, "high");
    assert.deepEqual(finding.evidence, { role: "cliente", sizes: [500, 510] });
  });

  it("aislamiento: tamaños distintos, cuerpos pequeños o rol sin aislamiento no se marcan", () => {
    const isolated = context({ endpoints: [detail], roles: [{ name: "cliente", sameRoleDataIsolation: true }] });
    assert.deepEqual(
      run(
        "cross_user_access",
        [reach("d", "cliente", "11", 200, 500), reach("d", "cliente", "12", 200, 300)],
        isolated,
      ),
      [],
    );
    assert.deepEqual(
      run("cross_user_access", [reach("d", "cliente", "11", 200, 90), reach("d", "cliente", "12", 200, 90)], isolated),
      [],
      "respuestas de ≤100 bytes (un error, un {}) no dicen nada",
    );
    assert.deepEqual(
      run(
        "cross_user_access",
        [reach("d", "cliente", "11", 200, 500), reach("d", "cliente", "12", 200, 500)],
        context({ endpoints: [detail], roles: [{ name: "cliente", sameRoleDataIsolation: false }] }),
      ),
      [],
    );
  });

  it("no juzga nada si el destino no aplica autorización o no hubo sondas con ids reales", () => {
    assert.deepEqual(
      run(
        "cross_user_access",
        [reach("d", "cliente", "11")],
        context({ authEnforced: false, endpoints: [detail], crossRoleRules: [rule({ canRead: false })] }),
      ),
      [],
    );
    assert.deepEqual(
      run("cross_user_access", [], context({ endpoints: [detail], crossRoleRules: [rule({ canRead: false })] })),
      [],
    );
  });
});

describe("regla method_tampering", () => {
  const tamper = (method: string, status: number, note = "") =>
    result({ endpointId: "l", testType: `method-tamper:${method}`, method, path: "/orders", status, note });

  it("DELETE aceptado es alto; PUT y PATCH aceptados son medios", () => {
    const findings = run("method_tampering", [tamper("DELETE", 200), tamper("PUT", 204), tamper("PATCH", 200)]);
    assert.deepEqual(
      findings.map((finding) => [finding.evidence.method, finding.severity]),
      [
        ["DELETE", "high"],
        ["PUT", "medium"],
        ["PATCH", "medium"],
      ],
    );
  });

  it("405, 404 o 401 ante el verbo cambiado pasan", () => {
    assert.deepEqual(run("method_tampering", [tamper("DELETE", 405), tamper("PUT", 404), tamper("PATCH", 401)]), []);
  });

  it("el detalle usa la nota del plan cuando la hay", () => {
    const [withNote] = run("method_tampering", [tamper("DELETE", 200, "GET → DELETE")]);
    assert.equal(withNote.detail, "GET → DELETE respondió 200: el endpoint no restringe el verbo.");
    const [bare] = run("method_tampering", [tamper("PUT", 200)]);
    assert.equal(bare.detail, "PUT respondió 200: el endpoint no restringe el verbo.");
  });
});
