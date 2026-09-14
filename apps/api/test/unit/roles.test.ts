/**
 * Roles as data: the name rule, and the `access` section the contract matrix reads, derived from them.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { safeParseSection } from "@eq/runner-core";

import { deriveAccess } from "@/modules/roles/domain/derive-access";
import { roleProblems, type Role, type RolePermission } from "@/modules/roles/domain/model";

const role = (id: string, name: string, position: number): Role => ({
  id,
  projectId: "p",
  name,
  description: "",
  color: "#6366f1",
  sameRoleDataIsolation: false,
  position,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("el nombre de un rol", () => {
  test("sigue la regla de las credenciales y no usa las tres reservadas", () => {
    assert.deepEqual(roleProblems({ name: "vendedor" }, true), []);
    assert.equal(roleProblems({ name: "super admin" }, true)[0].field, "name");
    assert.match(roleProblems({ name: "primary" }, true)[0].detail, /reservado/);
    assert.equal(roleProblems({ name: "x".repeat(21) }, true).length, 1);
    assert.equal(roleProblems({}, false).length, 0, "un PATCH sin nombre no lo exige");
    assert.equal(roleProblems({ color: "red" }, false)[0].field, "color");
  });
});

describe("la sección access derivada", () => {
  const roles = [role("r1", "vendedor", 0), role("r2", "comprador", 1)];
  const endpoints = [
    { id: "e1", operationId: "getOrder" },
    { id: "e2", operationId: "deleteOrder" },
    { id: "e3", operationId: null },
  ];
  const permissions: RolePermission[] = [
    { roleId: "r2", endpointId: "e1", access: "allow", dataScope: "own" },
    { roleId: "r1", endpointId: "e1", access: "allow", dataScope: "all" },
    { roleId: "r2", endpointId: "e2", access: "deny", dataScope: "all" },
    // A manual endpoint has no operation: the matrix cannot generate its case, and nothing is derived.
    { roleId: "r1", endpointId: "e3", access: "deny", dataScope: "all" },
  ];

  test("roles en orden, reglas por operación, y lo que no es de los roles se conserva", () => {
    const access = deriveAccess(
      {
        roles: ["viejo"],
        deniedStatuses: [404],
        rules: [
          { operationId: "getOrder", allow: ["viejo"], deny: [] },
          { operationId: "sinEndpoint", allow: ["vendedor", "borrado"], deny: [] },
          { operationId: "soloBorrados", allow: ["borrado"], deny: [] },
        ],
        crossRole: [
          { source: "vendedor", target: "comprador", createOperationId: "c", operationId: "getOrder", allowed: false },
          { source: "borrado", target: "comprador", createOperationId: "c", operationId: "getOrder", allowed: false },
        ],
      },
      roles,
      permissions,
      endpoints,
    );
    assert.deepEqual(access, {
      roles: ["vendedor", "comprador"],
      deniedStatuses: [404],
      rules: [
        { operationId: "deleteOrder", allow: [], deny: ["comprador"] },
        { operationId: "getOrder", allow: ["vendedor", "comprador"], deny: [] },
        { operationId: "sinEndpoint", allow: ["vendedor"], deny: [] },
      ],
      crossRole: [
        { source: "vendedor", target: "comprador", createOperationId: "c", operationId: "getOrder", allowed: false },
      ],
    });
    assert.equal(safeParseSection("access", { access }).ok, true);
  });

  test("un rol renombrado se renombra en lo que se conserva", () => {
    const renamed = [role("r1", "seller", 0), role("r2", "comprador", 1)];
    const access = deriveAccess(
      {
        rules: [{ operationId: "sinEndpoint", allow: ["vendedor"], deny: [] }],
        crossRole: [
          { source: "vendedor", target: "comprador", createOperationId: "c", operationId: "x", allowed: true },
        ],
      },
      renamed,
      [],
      endpoints,
      { vendedor: "seller" },
    );
    assert.deepEqual(access.rules, [{ operationId: "sinEndpoint", allow: ["seller"], deny: [] }]);
    assert.equal(access.crossRole[0].source, "seller");
    assert.deepEqual(access.deniedStatuses, [403, 404]);
  });
});
