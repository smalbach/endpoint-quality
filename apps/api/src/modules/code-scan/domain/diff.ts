/**
 * What a scan would change, before it changes anything.
 *
 * A scan that imported straight into the project would be a scan nobody trusts: the whole value is
 * seeing the gap first — the three routes the code has and the contract never mentioned, the one the
 * project still lists that the code deleted, the endpoint that quietly stopped requiring auth. So the
 * scan produces a diff, and importing is a second, deliberate step over exactly these rows.
 *
 * Pure: two lists in, a diff out. The existing side is whatever the project already has, reduced to
 * the fields a route is compared by.
 */
import type { ScannedEndpoint } from "./analyze-nest";

/** An endpoint the project already has, as the diff needs to see it. */
export type ExistingEndpoint = {
  id: string;
  method: string;
  path: string;
  requiresAuth: boolean;
};

export type EndpointChange = {
  method: string;
  path: string;
  /** The existing row's id, so an import can update it in place. */
  id: string;
  changes: string[];
};

export type ScanDiff = {
  added: ScannedEndpoint[];
  removed: ExistingEndpoint[];
  changed: EndpointChange[];
  unchanged: number;
};

const key = (endpoint: { method: string; path: string }) => `${endpoint.method.toUpperCase()} ${endpoint.path}`;

export function diffEndpoints(scanned: ScannedEndpoint[], existing: ExistingEndpoint[]): ScanDiff {
  const existingByKey = new Map(existing.map((endpoint) => [key(endpoint), endpoint]));
  const scannedByKey = new Map(scanned.map((endpoint) => [key(endpoint), endpoint]));

  const added: ScannedEndpoint[] = [];
  const changed: EndpointChange[] = [];
  let unchanged = 0;

  for (const endpoint of scanned) {
    const match = existingByKey.get(key(endpoint));
    if (!match) {
      added.push(endpoint);
      continue;
    }
    const changes: string[] = [];
    if (match.requiresAuth !== endpoint.requiresAuth)
      changes.push(
        endpoint.requiresAuth ? "el código ahora exige autenticación" : "el código ya no exige autenticación",
      );
    if (changes.length) changed.push({ method: endpoint.method, path: endpoint.path, id: match.id, changes });
    else unchanged += 1;
  }

  const removed = existing.filter((endpoint) => !scannedByKey.has(key(endpoint)));
  return { added, removed, changed, unchanged };
}

/** The roles the code names that the project's roles do not have — «el código comprueba `vendedor`,
 * que este proyecto no define». One half of the impact analysis; the flow half needs the flows and
 * lives in the application layer. */
export function unknownRoles(scanned: ScannedEndpoint[], knownRoleNames: string[]): string[] {
  const known = new Set(knownRoleNames.map((name) => name.toLowerCase()));
  const found = new Set<string>();
  for (const endpoint of scanned)
    for (const role of endpoint.roles) if (!known.has(role.toLowerCase())) found.add(role);
  return [...found].sort();
}
