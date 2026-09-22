/**
 * El descriptor que el front lee antes de elegir backend.
 *
 * Lo que se afirma aquí no es «devuelve un objeto»: es que **este** backend se declara la
 * referencia y cubre todos los módulos, que es la premisa sobre la que se miden los otros dos.
 * Un módulo nuevo en `API_MODULES` sin cobertura declarada aquí rompe este test, que es
 * exactamente cuando hay que enterarse.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BackendController } from "@/shared/backend.controller";
import { API_MODULES, NODE_BACKEND } from "@/shared/backend-descriptor";

describe("el descriptor del backend", () => {
  test("se identifica como la implementación de referencia", () => {
    const descriptor = new BackendController().describe();

    assert.equal(descriptor, NODE_BACKEND);
    assert.equal(descriptor.id, "node");
    assert.equal(descriptor.reference, true);
    assert.match(descriptor.runtime, /nestjs/);
  });

  test("declara cobertura completa de todos los módulos, y de ninguno más", () => {
    const { modules } = new BackendController().describe();

    assert.deepEqual(Object.keys(modules).sort(), [...API_MODULES].sort());
    assert.deepEqual(
      Object.values(modules).filter((coverage) => coverage !== "full"),
      [],
    );
  });
});
