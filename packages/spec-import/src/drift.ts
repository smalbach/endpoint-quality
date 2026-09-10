/**
 * What changed between two versions of a contract.
 *
 * This is the feature the coupled dashboard could not have: its operation table was compiled in,
 * so "the contract moved" was indistinguishable from "the contract is fine". With snapshots, the
 * diff is a query.
 *
 * The classification matters more than the diff itself, because the two directions have opposite
 * consequences:
 *
 * - an operation or a status that **disappears** invalidates cases that exist. Configuration
 *   keyed by it is now dead, and a run would assert something the contract no longer promises;
 * - one that **appears** is uncovered surface. Nothing breaks, and nothing is testing it either.
 *
 * Reporting them as one number — "12 changes" — hides which of the two just happened.
 */
import type { ImportedOperation } from "./parse.ts";

export type OperationChange =
  | { kind: "added"; id: string; method: string; path: string }
  | { kind: "removed"; id: string; method: string; path: string }
  | { kind: "moved"; id: string; from: string; to: string }
  | { kind: "statuses"; id: string; added: number[]; removed: number[] }
  | { kind: "parameters"; id: string; added: string[]; removed: string[] }
  | { kind: "security"; id: string; from: string[]; to: string[] };

export type SpecDrift = {
  changes: OperationChange[];
  /** Changes that invalidate existing cases or configuration: something the contract used to
   * promise and no longer does. */
  breaking: OperationChange[];
  /** New surface nothing is covering yet. */
  uncovered: OperationChange[];
};

export function diffOperations(before: ImportedOperation[], after: ImportedOperation[]): SpecDrift {
  const byId = (list: ImportedOperation[]) => new Map(list.map((operation) => [operation.id, operation]));
  const previous = byId(before);
  const current = byId(after);
  const changes: OperationChange[] = [];

  for (const [id, operation] of previous) {
    if (!current.has(id)) changes.push({ kind: "removed", id, method: operation.method, path: operation.path });
  }
  for (const [id, operation] of current) {
    if (!previous.has(id)) changes.push({ kind: "added", id, method: operation.method, path: operation.path });
  }

  for (const [id, operation] of current) {
    const old = previous.get(id);
    if (!old) continue;
    // Matched by id and not by path, so a route that moves is reported as one operation that
    // moved rather than as an unrelated removal plus an unrelated addition.
    if (old.path !== operation.path || old.method !== operation.method) {
      changes.push({ kind: "moved", id, from: `${old.method} ${old.path}`, to: `${operation.method} ${operation.path}` });
    }
    const statusesAdded = operation.statuses.filter((status) => !old.statuses.includes(status));
    const statusesRemoved = old.statuses.filter((status) => !operation.statuses.includes(status));
    if (statusesAdded.length || statusesRemoved.length) changes.push({ kind: "statuses", id, added: statusesAdded, removed: statusesRemoved });

    const parametersAdded = operation.parameters.filter((name) => !old.parameters.includes(name));
    const parametersRemoved = old.parameters.filter((name) => !operation.parameters.includes(name));
    if (parametersAdded.length || parametersRemoved.length) changes.push({ kind: "parameters", id, added: parametersAdded, removed: parametersRemoved });

    if (JSON.stringify([...old.security].sort()) !== JSON.stringify([...operation.security].sort())) {
      // A security scheme appearing or vanishing changes which 401/403 cases are meaningful, and
      // it is the change most likely to be made without anybody thinking of the test matrix.
      changes.push({ kind: "security", id, from: old.security, to: operation.security });
    }
  }

  return {
    changes,
    breaking: changes.filter(isBreaking),
    uncovered: changes.filter((change) => change.kind === "added" || (change.kind === "statuses" && change.added.length > 0) || (change.kind === "parameters" && change.added.length > 0)),
  };
}

function isBreaking(change: OperationChange): boolean {
  if (change.kind === "removed" || change.kind === "moved") return true;
  if (change.kind === "statuses") return change.removed.length > 0;
  if (change.kind === "parameters") return change.removed.length > 0;
  if (change.kind === "security") return true;
  return false;
}

/** One line per change, for a log or a CI comment. */
export function describeChange(change: OperationChange): string {
  switch (change.kind) {
    case "added": return `+ ${change.method} ${change.path} (${change.id})`;
    case "removed": return `- ${change.method} ${change.path} (${change.id})`;
    case "moved": return `~ ${change.id}: ${change.from} → ${change.to}`;
    case "statuses": return `~ ${change.id}: estados ${format(change.added, change.removed)}`;
    case "parameters": return `~ ${change.id}: parámetros ${format(change.added, change.removed)}`;
    case "security": return `~ ${change.id}: seguridad [${change.from.join(", ")}] → [${change.to.join(", ")}]`;
  }
}

function format(added: (string | number)[], removed: (string | number)[]): string {
  return [added.length ? `+${added.join(", +")}` : "", removed.length ? `-${removed.join(", -")}` : ""].filter(Boolean).join(" ");
}
