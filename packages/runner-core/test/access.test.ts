/**
 * Quién puede llegar a qué, que es la pregunta que la matriz generada no sabe hacer.
 *
 * Todo lo demás en el generador sale del contrato: una operación que deja de declarar 403 deja de
 * tener el caso, y esa es la diferencia entre una matriz y una copia de una matriz. Pero un
 * contrato declara que `403` es una respuesta posible, nunca **a quién**. «El rol vendedor no debe
 * poder leer un pedido» es conocimiento del negocio, así que se escribe y se lee de un sitio.
 *
 * Lo que hay que asegurar es que el silencio no genera nada. Un rol que no aparece en ninguna de
 * las dos listas es uno sobre el que este proyecto todavía no ha decidido, y generarle un caso
 * sería la herramienta inventándose un requisito — el mismo error que dar por implementado todo lo
 * que el contrato declara.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { resolveOperations, scenariosFor } from "../src/scenarios.ts";
import type { Operation, TestScenario } from "../src/types.ts";

const operations: Operation[] = [
  {
    id: "getPedido",
    method: "GET",
    path: "/pedidos/{id}",
    summary: "Un pedido",
    tag: "Pedidos",
    statuses: [200, 403, 404],
    parameters: ["id"],
  },
  {
    id: "crearPedido",
    method: "POST",
    path: "/pedidos",
    summary: "Alta de pedido",
    tag: "Pedidos",
    statuses: [201, 403],
    parameters: [],
  },
];

const configOf = (access: Partial<ReturnType<typeof defineProjectConfig>["access"]> = {}) =>
  defineProjectConfig({
    access: {
      roles: ["vendedor", "comprador", "admin"],
      deniedStatuses: [403, 404],
      rules: [],
      crossRole: [],
      ...access,
    },
    bodyTemplates: { crearPedido: { body: { total: 10 } } },
  });

const casesFor = (operationId: string, config: ReturnType<typeof defineProjectConfig>): TestScenario[] => {
  const resolved = resolveOperations(operations, config);
  const operation = resolved.find((candidate) => candidate.id === operationId)!;
  return scenariosFor(operation, config).filter((scenario) => scenario.id.startsWith("access-"));
};

describe("un caso por celda de la matriz de permisos", () => {
  test("sin reglas no se genera ningún caso: el silencio no es «no debe pasar»", () => {
    assert.deepEqual(casesFor("getPedido", configOf()), []);
  });

  test("un rol que debe pasar espera el éxito que el contrato declara", () => {
    const [scenario] = casesFor(
      "crearPedido",
      configOf({ rules: [{ operationId: "crearPedido", allow: ["vendedor"], deny: [] }] }),
    );
    assert.equal(scenario.id, "access-allow-vendedor");
    assert.equal(scenario.auth, "role:vendedor");
    // 201, no 200: un 200 fijo haría fallar a todo rol permitido sobre un POST que contesta 201
    // correctamente, y el informe culparía al permiso.
    assert.equal(scenario.expectedStatus, 201);
  });

  test("un rol que no debe pasar acepta los dos códigos de rechazo", () => {
    const [scenario] = casesFor(
      "getPedido",
      configOf({ rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] }),
    );
    assert.equal(scenario.id, "access-deny-vendedor");
    assert.equal(scenario.expectedStatus, 403);
    // Una API bien hecha esconde la existencia y contesta 404; exigir 403 la pondría en rojo justo
    // por estar mejor construida. El hallazgo es «pudo leerlo», no «el código no fue 403».
    assert.deepEqual(scenario.alsoAccepted, [404]);
  });

  test("un proyecto que sabe que su API siempre contesta 403 puede estrecharlo", () => {
    const [scenario] = casesFor(
      "getPedido",
      configOf({ deniedStatuses: [403], rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] }),
    );
    assert.equal(scenario.expectedStatus, 403);
    assert.equal(scenario.alsoAccepted, undefined);
  });

  test("una regla de otra operación no genera nada aquí", () => {
    const config = configOf({ rules: [{ operationId: "crearPedido", allow: ["vendedor"], deny: [] }] });
    assert.deepEqual(casesFor("getPedido", config), []);
  });

  test("el cuerpo viaja con la escritura, o el rechazo no prueba nada sobre permisos", () => {
    // Una petición rechazada por tener el cuerpo mal no dice nada de quién la mandaba, que es
    // exactamente lo que este caso viene a averiguar.
    const [scenario] = casesFor(
      "crearPedido",
      configOf({ rules: [{ operationId: "crearPedido", allow: [], deny: ["comprador"] }] }),
    );
    assert.deepEqual(scenario.body, { total: 10 });
  });

  test("una celda por rol, en el orden en que se escribieron", () => {
    const cases = casesFor(
      "getPedido",
      configOf({ rules: [{ operationId: "getPedido", allow: ["admin", "comprador"], deny: ["vendedor"] }] }),
    );
    assert.deepEqual(
      cases.map((scenario) => scenario.id),
      ["access-allow-admin", "access-allow-comprador", "access-deny-vendedor"],
    );
  });

  test("el nombre y la descripción dicen de qué rol hablan", () => {
    const [scenario] = casesFor(
      "getPedido",
      configOf({ rules: [{ operationId: "getPedido", allow: [], deny: ["vendedor"] }] }),
    );
    assert.match(scenario.name, /vendedor/);
    assert.match(scenario.description, /GET \/pedidos\/\{id\}/);
  });
});
