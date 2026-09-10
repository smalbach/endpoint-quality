/**
 * The queue a run executes, and the order it executes it in.
 *
 * Both used to be implicit in `api-dashboard.tsx`: the queue was always "every operation" or
 * "every GET", and the order was whichever one `contract-operations.ts` happened to declare —
 * alphabetical by path, because that is how the generator walks `bundled.yaml`. Two things
 * were impossible with that:
 *
 * - **running a subset**: there was no step between one endpoint and all 45, so verifying a
 *   single tag after touching it meant running the whole matrix or clicking 9 endpoints one at
 *   a time;
 * - **choosing the order**: alphabetical puts `DELETE /v1/categories/{category_id}` before
 *   `GET /v1/categories/{category_id}`, so a delete runs before the read that would have shown
 *   the endpoint was already broken. A failure late in the matrix cannot then be told apart
 *   from a failure the matrix itself caused.
 *
 * This module is pure and takes no React: the same plan can be asserted in a test.
 */
import type { Endpoint, HttpMethod } from "./endpoints.ts";
import { runnableScenarios, type TestScenario } from "./scenarios.ts";

export type OrderMode = "contract" | "safe" | "custom";
export type QueueItem = { endpoint: Endpoint; scenario: TestScenario };
/** Which cases of each endpoint a run includes. A key that is absent means *all* of them; an
 * empty array means the endpoint was explicitly emptied and contributes nothing. */
export type CaseSelection = Record<string, string[]>;

export const ORDER_MODES: { id: OrderMode; label: string; hint: string }[] = [
  { id: "contract", label: "Contrato", hint: "El orden en que bundled.yaml declara las 45 operaciones." },
  {
    id: "safe",
    label: "Lecturas primero",
    hint: "GET, POST, PUT, PATCH y por último DELETE. Es el orden por defecto: un DELETE que borra de más no puede dejar en rojo a los casos que vienen después, porque ya no queda ninguno.",
  },
  { id: "custom", label: "Personalizado", hint: "El orden que fijes a mano. Se parte del orden visible al activarlo." },
];

/**
 * Reads first because they are the only cases that assert without changing anything: if
 * `GET /v1/stores` is already red, every write flow over stores is red for a reason that is not
 * its own.
 *
 * **Deletes last, and this is the half that actually matters.** A DELETE is the only operation
 * whose failure mode is destroying the fixtures the rest of the matrix reads. Two ways it
 * happens, neither hypothetical:
 *
 * - the authorization cases send `DELETE /v1/stores/{store_id}` over the seed id `1` expecting
 *   401 and 403. That is the point of the case — but if the API wrongly *authorizes* it, the
 *   case fails **and** store 1 is gone, and every case after it fails too. In alphabetical
 *   order that is 30 operations of red with one real cause buried in them;
 * - a delete with a wrong cascade takes related rows with it, so the endpoint that owns those
 *   rows reports a bug that belongs to a different endpoint.
 *
 * Running them last does not prevent either one. It stops them from being *contagious*: the
 * damage lands after everything that could have been poisoned by it has already been measured,
 * so a red DELETE at the end is a finding and not an avalanche.
 */
const methodRank: Record<HttpMethod, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };

export function orderEndpoints(list: Endpoint[], mode: OrderMode, customOrder: string[]): Endpoint[] {
  const contractIndex = new Map(list.map((endpoint, index) => [endpoint.id, index]));
  const contractRank = (endpoint: Endpoint) => contractIndex.get(endpoint.id) ?? list.length;
  if (mode === "contract") return [...list];
  if (mode === "safe")
    return [...list].sort((a, b) => methodRank[a.method] - methodRank[b.method] || contractRank(a) - contractRank(b));
  // An id the custom order never mentions is not dropped: it keeps the contract order, placed
  // after everything that was ordered by hand.
  const position = new Map(customOrder.map((id, index) => [id, index]));
  const customRank = (endpoint: Endpoint) => position.get(endpoint.id) ?? customOrder.length + contractRank(endpoint);
  return [...list].sort((a, b) => customRank(a) - customRank(b));
}

/** Swaps one endpoint with its neighbour. Out-of-range moves return the same array so the
 * caller can bind the arrows unconditionally. */
export function moveEndpoint(order: string[], id: string, direction: -1 | 1): string[] {
  const index = order.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function selectedCases(endpoint: Endpoint, selection: CaseSelection, authEnabled: boolean): TestScenario[] {
  const all = runnableScenarios(endpoint, authEnabled);
  const picked = selection[endpoint.id];
  return picked ? all.filter((scenario) => picked.includes(scenario.id)) : all;
}

/**
 * The flat list of cases a run walks, endpoint by endpoint in the chosen order.
 *
 * `endpointIds` is the subset to include; `undefined` means every endpoint the list carries,
 * which is what the two matrix buttons pass.
 */
export function buildQueue(
  list: Endpoint[],
  options: {
    mode: OrderMode;
    customOrder: string[];
    endpointIds?: string[];
    caseSelection: CaseSelection;
    authEnabled: boolean;
  },
): QueueItem[] {
  const included = options.endpointIds ? new Set(options.endpointIds) : undefined;
  return orderEndpoints(list, options.mode, options.customOrder)
    .filter((endpoint) => !included || included.has(endpoint.id))
    .flatMap((endpoint) =>
      selectedCases(endpoint, options.caseSelection, options.authEnabled).map((scenario) => ({ endpoint, scenario })),
    );
}
