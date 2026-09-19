/**
 * Rincones del generador que el resto de la suite no pisa: las plantillas que traen body y
 * credencial propios, un proyecto que reconoce listas solo por el método y una operación que
 * declara más de un éxito.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { resolveOperations, scenariosFor } from "../src/scenarios.ts";
import type { Operation } from "../src/types.ts";

const operations: Operation[] = [
  { id: "fetchItems", method: "GET", path: "/items", summary: "", tag: "I", statuses: [200], parameters: [] },
  { id: "saveItem", method: "POST", path: "/items", summary: "", tag: "I", statuses: [200, 201, 422], parameters: [] },
];

describe("plantillas de casos", () => {
  test("una plantilla con body y credencial los conserva; una sin ellos no los inventa", () => {
    const config = defineProjectConfig({
      operationOverrides: {
        saveItem: {
          functional: [
            { id: "con-todo", name: "Con todo", description: "", expectedStatus: 201, body: { a: 1 }, auth: "none" },
            { id: "desnudo", name: "Desnudo", description: "", expectedStatus: 201 },
          ],
        },
      },
    });
    const operation = resolveOperations(operations, config).find((item) => item.id === "saveItem")!;
    const [full, bare] = scenariosFor(operation, config);
    assert.deepEqual(full.body, { a: 1 });
    assert.equal(full.auth, "none");
    assert.equal(full.flow, "request");
    assert.equal("body" in bare, false);
    assert.equal("auth" in bare, false);
  });
});

describe("reconocer una lista", () => {
  test("sin prefijo configurado, todo GET del método listado es una colección", () => {
    // `fetchItems` no empieza por `list`: con el prefijo por defecto sería un detalle.
    const byMethod = defineProjectConfig({ listOperations: { methods: ["GET"] } });
    const byPrefix = defineProjectConfig({});
    const ids = (config: typeof byMethod) =>
      scenariosFor(resolveOperations(operations, config)[0], config).map((scenario) => scenario.id);
    assert.equal(ids(byMethod)[0], "default");
    assert.notEqual(ids(byPrefix)[0], "default");
  });
});

describe("la matriz de acceso", () => {
  test("con varios éxitos declarados, el caso permitido espera el menor", () => {
    const config = defineProjectConfig({
      access: { roles: ["admin"], deniedStatuses: [403], rules: [{ operationId: "saveItem", allow: ["admin"], deny: [] }], crossRole: [] },
    });
    const operation = resolveOperations(
      [{ ...operations[1], statuses: [422, 201, 200] }],
      config,
    )[0];
    const allow = scenariosFor(operation, config).find((scenario) => scenario.id === "access-allow-admin")!;
    assert.equal(allow.expectedStatus, 200);
  });
});
