/**
 * The queue a run executes, and the order it executes it in.
 *
 * Pure and free of the project overlay except through the operations it is handed: the same
 * plan is built in the browser to preview a run and on the server to execute it, and the two
 * must agree or the preview is a lie.
 */
import type { ResolvedOperation, TestScenario } from "./types.ts";
import type { ProjectConfig } from "./config.ts";
import { runnableScenarios } from "./scenarios.ts";

export type OrderMode = "contract" | "safe" | "custom";
export type QueueItem = { operation: ResolvedOperation; scenario: TestScenario };
/** Which cases of each operation a run includes. An absent key means *all* of them; an empty
 * array means the operation was explicitly emptied and contributes nothing. */
export type CaseSelection = Record<string, string[]>;

/**
 * Reads first because they are the only cases that assert without changing anything: if the
 * collection endpoint is already red, every write flow over that resource is red for a reason
 * that is not its own.
 *
 * **Deletes last, and this is the half that matters.** A DELETE is the only operation whose
 * failure mode is destroying the fixtures the rest of the matrix reads. Two ways it happens,
 * neither hypothetical:
 *
 * - the authorization cases send a DELETE over a seed id expecting 401 and 403. That is the
 *   point of the case — but if the API wrongly *authorizes* it, the case fails **and** the row
 *   is gone, and every case after it fails too;
 * - a delete with a wrong cascade takes related rows with it, so the endpoint that owns those
 *   rows reports a bug belonging to a different endpoint.
 *
 * Running them last does not prevent either one. It stops them from being *contagious*: the
 * damage lands after everything it could have poisoned has already been measured, so a red
 * DELETE at the end is a finding and not an avalanche.
 */
const methodRank: Record<string, number> = { GET: 0, HEAD: 0, OPTIONS: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };

export function orderOperations(
  list: ResolvedOperation[],
  mode: OrderMode,
  customOrder: string[],
): ResolvedOperation[] {
  const contractIndex = new Map(list.map((operation, index) => [operation.id, index]));
  const contractRank = (operation: ResolvedOperation) => contractIndex.get(operation.id) ?? list.length;
  if (mode === "contract") return [...list];
  if (mode === "safe")
    return [...list].sort((a, b) => methodRank[a.method] - methodRank[b.method] || contractRank(a) - contractRank(b));
  // An id the custom order never mentions is not dropped: it keeps the contract order, placed
  // after everything that was ordered by hand.
  const position = new Map(customOrder.map((id, index) => [id, index]));
  const customRank = (operation: ResolvedOperation) =>
    position.get(operation.id) ?? customOrder.length + contractRank(operation);
  return [...list].sort((a, b) => customRank(a) - customRank(b));
}

/** Swaps one operation with its neighbour. Out-of-range moves return the same array so the
 * caller can bind the arrows unconditionally. */
export function moveOperation(order: string[], id: string, direction: -1 | 1): string[] {
  const index = order.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function selectedCases(
  operation: ResolvedOperation,
  config: ProjectConfig,
  selection: CaseSelection,
  authEnabled: boolean,
): TestScenario[] {
  const all = runnableScenarios(operation, config, authEnabled);
  const picked = selection[operation.id];
  return picked ? all.filter((scenario) => picked.includes(scenario.id)) : all;
}

export type QueueOptions = {
  mode: OrderMode;
  customOrder?: string[];
  /** The subset to include. `undefined` means every operation the list carries. */
  operationIds?: string[];
  caseSelection?: CaseSelection;
  authEnabled: boolean;
};

export function buildQueue(list: ResolvedOperation[], config: ProjectConfig, options: QueueOptions): QueueItem[] {
  const included = options.operationIds ? new Set(options.operationIds) : undefined;
  return orderOperations(list, options.mode, options.customOrder ?? [])
    .filter((operation) => !included || included.has(operation.id))
    .flatMap((operation) =>
      selectedCases(operation, config, options.caseSelection ?? {}, options.authEnabled).map((scenario) => ({
        operation,
        scenario,
      })),
    );
}
