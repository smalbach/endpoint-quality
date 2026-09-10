/**
 * Freezes the matrix the coupled dashboard produces, from its own untouched code.
 *
 * This is the oracle of the P0 parity test and the only reason `test/legacy/` exists. It runs
 * the legacy modules — not the new ones — and writes everything that a run is determined by:
 * every operation, every case, in every order mode, with and without the authorization cases,
 * plus the latency budget each case would be asserted against.
 *
 * If the generalized engine reproduces this file byte for byte, the decoupling lost nothing.
 * That is the whole claim, and it is the only one that can be checked mechanically.
 *
 *     node --experimental-strip-types test/golden/generate.ts
 */
import { writeFileSync } from "node:fs";
import { endpoints } from "../legacy/endpoints.ts";
import { scenariosFor, runnableScenarios } from "../legacy/scenarios.ts";
import { orderEndpoints, buildQueue } from "../legacy/execution-plan.ts";
import { budgetFor } from "../legacy/budgets.mjs";

const ORDERS = ["contract", "safe"] as const;

/** The resolved path a case would request, reproducing `resolvePath` in `api-dashboard.tsx`.
 * The budget of a GET depends on the query string (`?ean_sap=` carries its own target), so a
 * golden that only recorded the templated path would not pin the budgets down. */
const DEFAULT_PARAMETERS: Record<string, string> = { product_id: "1", store_id: "1", category_id: "1", price_id: "1", projection_id: "1", product_category_id: "1", store_assortment_id: "1" };
function resolvePath(endpoint: { path: string; parameters?: string[] }, values: Record<string, string>) {
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(values[key] || "1"));
  const query = new URLSearchParams();
  endpoint.parameters?.filter((name) => !endpoint.path.includes(`{${name}}`) && values[name]).forEach((name) => query.set(name, values[name]));
  return query.size ? `${path}?${query}` : path;
}

const operations = endpoints.map((endpoint) => ({
  id: endpoint.id,
  method: endpoint.method,
  path: endpoint.path,
  tag: endpoint.tag,
  statuses: endpoint.statuses,
  parameters: endpoint.parameters,
  implemented: endpoint.implemented,
  responseShape: endpoint.responseShape,
  body: endpoint.body ?? null,
  conflictBody: endpoint.conflictBody ?? null,
  scenarios: scenariosFor(endpoint).map((scenario) => {
    const requestPath = resolvePath(endpoint, { ...DEFAULT_PARAMETERS, ...(scenario.parameters ?? {}) });
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
      budget: budgetFor(endpoint.method, endpoint.path, requestPath),
    };
  }),
  runnableWithoutAuth: runnableScenarios(endpoint, false).map((scenario) => scenario.id),
  runnableWithAuth: runnableScenarios(endpoint, true).map((scenario) => scenario.id),
}));

const orders = Object.fromEntries(ORDERS.map((mode) => [mode, orderEndpoints(endpoints, mode, []).map((endpoint) => endpoint.id)]));

const queues = Object.fromEntries(
  ORDERS.flatMap((mode) =>
    [false, true].map((authEnabled) => [
      `${mode}:${authEnabled ? "auth" : "no-auth"}`,
      buildQueue(endpoints, { mode, customOrder: [], caseSelection: {}, authEnabled }).map((item) => `${item.endpoint.id}:${item.scenario.id}`),
    ]),
  ),
);

const golden = {
  // Not a version of this file: a fingerprint of what it describes. A contract that grows an
  // operation changes these numbers, and the parity test then fails loudly instead of
  // comparing the new engine against a stale matrix.
  totals: {
    operations: operations.length,
    implemented: operations.filter((operation) => operation.implemented).length,
    declaredResponses: operations.reduce((sum, operation) => sum + operation.statuses.length, 0),
    cases: operations.reduce((sum, operation) => sum + operation.scenarios.length, 0),
    casesWithoutAuth: queues["safe:no-auth"].length,
    casesWithAuth: queues["safe:auth"].length,
  },
  operations,
  orders,
  queues,
};

writeFileSync(new URL("matrix.json", import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);
console.log(JSON.stringify(golden.totals, null, 2));
