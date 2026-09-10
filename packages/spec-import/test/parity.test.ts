/**
 * The acceptance criterion of P2: reading the contract at runtime must produce exactly what the
 * Python generator compiled in.
 *
 * `scripts/gen_dashboard_endpoints.py` walked `bundled.yaml` and wrote `contract-operations.ts`
 * into the dashboard's source tree. That file — 46 operations, frozen in P0 under
 * `runner-core/test/legacy/` — is the oracle here. If this importer reproduces it field for
 * field from the same document, the build step in the other repository is redundant and can be
 * retired in P7.
 *
 * The document is read from the Digital Catalog checkout beside this one. When it is not there
 * the suite **skips with the reason printed**, because a parity test that passes without
 * comparing anything is worse than no parity test.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { importSpec } from "../src/parse.ts";
import { diffOperations } from "../src/drift.ts";
import { contractOperations } from "../../runner-core/test/legacy/contract-operations.ts";

const SPEC_PATH = fileURLToPath(
  new URL("../../../../geronimo-martings/digital-catalog-back-end/docs/openapi/bundled.yaml", import.meta.url),
);
const AVAILABLE = existsSync(SPEC_PATH);
const REASON = `sin bundled.yaml en ${SPEC_PATH}: clona digital-catalog-back-end junto a este repositorio`;

describe("el importador reproduce el generador de Python", { skip: AVAILABLE ? false : REASON }, () => {
  const raw = AVAILABLE ? readFileSync(SPEC_PATH, "utf8") : "";
  const imported = AVAILABLE ? importSpec(raw) : null;

  test("lee el documento sin errores", () => {
    assert.equal(imported!.openapiVersion, "3.1.0");
    assert.equal(imported!.version, "1.8.0");
    const errors = imported!.problems.filter((problem) => problem.severity === "error");
    assert.deepEqual(errors, [], "el contrato del cliente no debería producir errores de importación");
  });

  test("encuentra el mismo número de operaciones", () => {
    assert.equal(imported!.operations.length, contractOperations.length);
    assert.equal(imported!.operations.length, 46);
  });

  test("cada operación coincide campo por campo con el fichero generado", () => {
    // Compared one at a time so a divergence names the operation rather than dumping 46 of them.
    for (const [index, expected] of contractOperations.entries()) {
      const actual = imported!.operations[index];
      assert.deepEqual(
        {
          id: actual.id,
          method: actual.method,
          path: actual.path,
          summary: actual.summary,
          tag: actual.tag,
          statuses: actual.statuses,
          parameters: actual.parameters,
        },
        expected,
        `divergencia en ${expected.method} ${expected.path} (${expected.id})`,
      );
    }
  });

  test("el orden es el mismo: ruta y después método", () => {
    // The order is what the UI offers as "contrato", and a stable one is what makes two imports
    // of the same document a real diff instead of a reshuffle.
    assert.deepEqual(
      imported!.operations.map((operation) => operation.id),
      contractOperations.map((operation) => operation.id),
    );
  });

  test("los parámetros compartidos de la ruta llegan a cada operación", () => {
    // The contract declares the path ids at the path-item level. Reading only the operation's
    // own list would lose `{store_id}` on every endpoint that has one — and every generated case
    // would then request a URL with a literal `{store_id}` in it.
    const detail = imported!.operations.find((operation) => operation.id === "getStore");
    assert.ok(detail!.parameters.includes("store_id"));
    const assortment = imported!.operations.find((operation) => operation.id === "listStoreAssortment");
    assert.ok(assortment!.parameters.includes("store_id"), "el id de la tienda es un parámetro compartido de la ruta");
  });

  test("todas las operaciones traen operationId del contrato, ninguno derivado", () => {
    const derived = imported!.operations.filter((operation) => operation.derivedId);
    assert.deepEqual(derived, []);
  });

  test("la seguridad declarada llega a cada operación", () => {
    // The 401/403 matrix is generated from what the contract declares. A health probe that is
    // public and a write that is not must be distinguishable here.
    const health = imported!.operations.find((operation) => operation.id === "healthCheck");
    const write = imported!.operations.find((operation) => operation.id === "createStore");
    assert.deepEqual(health!.security, [], "el health check no declara seguridad");
    assert.ok(write!.security.length > 0, "una escritura debe declarar algún esquema");
  });

  test("importar dos veces el mismo documento no reporta ningún cambio", () => {
    const second = importSpec(raw);
    const drift = diffOperations(imported!.operations, second.operations);
    assert.deepEqual(drift.changes, []);
  });
});
