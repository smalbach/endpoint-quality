/**
 * The test that authorises the decoupling.
 *
 * `test/golden/matrix.json` was produced by the coupled dashboard's own untouched code. This
 * test builds the same structure with the generalized engine, fed the Digital Catalog project
 * as *configuration*, and requires them to be identical — every operation, every case, every
 * description, every expected status, every resolved path, every latency budget, and the exact
 * order of every queue.
 *
 * A generalization that quietly drops the ocean case, reworded a description or reordered the
 * geographic block would pass a hand-written spot check and fail here. That is the point: the
 * claim being made is "the decoupling lost nothing", and this is the only way to check it
 * mechanically rather than by reading.
 *
 * It fails loudly when the contract changes, too — the golden's `totals` fingerprint the matrix
 * it describes, so a new operation in `bundled.yaml` demands a regenerated golden instead of
 * silently comparing the new engine against a stale one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { contractOperations } from "./legacy/contract-operations.ts";
import { digitalCatalogConfig as config } from "./fixtures/digital-catalog.ts";
import type { Operation } from "../src/types.ts";
import { resolveOperations, scenariosFor, runnableScenarios } from "../src/scenarios.ts";
import { orderOperations, buildQueue } from "../src/execution-plan.ts";
import { budgetFor } from "../src/budgets.ts";
import { requestPathFor } from "../src/request-path.ts";

const golden = JSON.parse(readFileSync(new URL("golden/matrix.json", import.meta.url), "utf8"));
const ORDERS = ["contract", "safe"] as const;

// The structural half of the contract. In production this comes from `spec-import` reading the
// live document; P0 only claims the *generator* is faithful, so it is fed the same operation
// table the coupled version compiled in, and nothing else about it is assumed.
const operations = contractOperations as Operation[];
const resolved = resolveOperations(operations, config);

function buildMatrix() {
  const built = resolved.map((operation) => ({
    id: operation.id,
    method: operation.method,
    path: operation.path,
    tag: operation.tag,
    statuses: operation.statuses,
    parameters: operation.parameters,
    implemented: operation.implemented,
    responseShape: operation.responseShape,
    body: operation.body ?? null,
    conflictBody: operation.conflictBody ?? null,
    scenarios: scenariosFor(operation, config).map((scenario) => {
      const requestPath = requestPathFor(operation, config, scenario.parameters);
      return {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        expectedStatus: scenario.expectedStatus,
        parameters: scenario.parameters ?? null,
        body: scenario.body ?? null,
        flow: scenario.flow,
        auth: scenario.auth ?? null,
        requestPath,
        budget: budgetFor(config, operation.method, operation.path, requestPath),
      };
    }),
    runnableWithoutAuth: runnableScenarios(operation, config, false).map((scenario) => scenario.id),
    runnableWithAuth: runnableScenarios(operation, config, true).map((scenario) => scenario.id),
  }));

  const orders = Object.fromEntries(ORDERS.map((mode) => [mode, orderOperations(resolved, mode, []).map((operation) => operation.id)]));

  const queues = Object.fromEntries(
    ORDERS.flatMap((mode) =>
      [false, true].map((authEnabled) => [
        `${mode}:${authEnabled ? "auth" : "no-auth"}`,
        buildQueue(resolved, config, { mode, authEnabled }).map((item) => `${item.operation.id}:${item.scenario.id}`),
      ]),
    ),
  );

  return {
    totals: {
      operations: built.length,
      implemented: built.filter((operation) => operation.implemented).length,
      declaredResponses: built.reduce((sum, operation) => sum + operation.statuses.length, 0),
      cases: built.reduce((sum, operation) => sum + operation.scenarios.length, 0),
      casesWithoutAuth: queues["safe:no-auth"].length,
      casesWithAuth: queues["safe:auth"].length,
    },
    operations: built,
    orders,
    queues,
  };
}

const matrix = buildMatrix();

test("los totales de la matriz coinciden con el golden", () => {
  assert.deepEqual(matrix.totals, golden.totals);
});

test("cada operación produce exactamente los mismos casos", () => {
  assert.equal(matrix.operations.length, golden.operations.length);
  for (const [index, expected] of golden.operations.entries()) {
    const actual = matrix.operations[index];
    // Compared per operation rather than in one deepEqual over the whole file: a single
    // mismatch in 46 operations and 311 cases must name the operation it is in, or the failure
    // is a wall of JSON nobody can act on.
    assert.deepEqual(actual, expected, `divergencia en ${expected.method} ${expected.path} (${expected.id})`);
  }
});

test("el orden de ejecución coincide en los dos modos", () => {
  assert.deepEqual(matrix.orders, golden.orders);
});

test("las cuatro colas coinciden caso por caso", () => {
  for (const key of Object.keys(golden.queues)) {
    assert.deepEqual(matrix.queues[key], golden.queues[key], `divergencia en la cola ${key}`);
  }
  assert.deepEqual(Object.keys(matrix.queues).sort(), Object.keys(golden.queues).sort());
});

test("los deletes van al final en el modo seguro y ninguno se pierde", () => {
  const order = matrix.orders.safe;
  const methodOf = new Map(resolved.map((operation) => [operation.id, operation.method]));
  const lastNonDelete = order.map((id) => methodOf.get(id)).lastIndexOf("GET");
  const firstDelete = order.map((id) => methodOf.get(id)).indexOf("DELETE");
  assert.ok(firstDelete > lastNonDelete, "un DELETE se ejecuta antes de la última lectura");
  assert.equal(order.length, resolved.length);
});
