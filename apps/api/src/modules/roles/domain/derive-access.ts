import type { Role, RolePermission } from "./model";

type AccessRule = { operationId: string; allow: string[]; deny: string[] };
type CrossRoleRule = {
  source: string;
  target: string;
  createOperationId: string;
  operationId: string;
  allowed: boolean;
};

export type AccessData = {
  roles: string[];
  deniedStatuses: number[];
  rules: AccessRule[];
  crossRole: CrossRoleRule[];
};

const DEFAULT_DENIED = [403, 404];

/** The `access` object of a stored section, whatever shape it arrived in. */
export function readAccess(data: unknown): Partial<AccessData> {
  const access = (data as { access?: unknown } | null | undefined)?.access;
  return access && typeof access === "object" ? (access as Partial<AccessData>) : {};
}

/**
 * The `access` section the contract matrix reads, rebuilt from the roles.
 *
 * - `roles` are the rows, in their order.
 * - `rules` come from the permissions of every endpoint linked to a contract operation: `allow` and
 *   `deny` by role name, and an undecided cell says nothing. A stored rule over an operation no
 *   endpoint is linked to is kept — nothing on the Roles screen could edit it, so nothing there
 *   should erase it — minus the roles that no longer exist.
 * - `crossRole` and `deniedStatuses` are not role data, they are matrix settings, and are kept,
 *   with a renamed role renamed and a deleted one dropped.
 */
export function deriveAccess(
  stored: Partial<AccessData>,
  roles: Role[],
  permissions: RolePermission[],
  endpoints: { id: string; operationId: string | null }[],
  renamed: Record<string, string> = {},
): AccessData {
  const names = roles.map((role) => role.name);
  const known = new Set(names);
  const rename = (name: string) => renamed[name] ?? name;
  const byId = new Map(roles.map((role) => [role.id, role]));
  const operationOf = new Map(
    endpoints
      .filter((endpoint): endpoint is { id: string; operationId: string } => Boolean(endpoint.operationId))
      .map((endpoint) => [endpoint.id, endpoint.operationId]),
  );
  const linked = new Set(operationOf.values());

  const derived = new Map<string, AccessRule>();
  for (const permission of permissions) {
    const operationId = operationOf.get(permission.endpointId);
    const role = byId.get(permission.roleId);
    if (!operationId || !role) continue;
    const rule = derived.get(operationId) ?? { operationId, allow: [], deny: [] };
    const list = permission.access === "allow" ? rule.allow : rule.deny;
    // Two endpoints linked to one operation — possible after a contract re-import — must not list
    // a role twice, nor in both lists; the first decision wins, which is the endpoint seen first.
    if (!rule.allow.includes(role.name) && !rule.deny.includes(role.name)) list.push(role.name);
    derived.set(operationId, rule);
  }
  const order = (list: string[]) => [...list].sort((left, right) => names.indexOf(left) - names.indexOf(right));

  const kept = (stored.rules ?? [])
    .filter((rule) => !linked.has(rule.operationId))
    .map((rule) => ({
      operationId: rule.operationId,
      allow: rule.allow.map(rename).filter((name) => known.has(name)),
      deny: rule.deny.map(rename).filter((name) => known.has(name)),
    }))
    .filter((rule) => rule.allow.length || rule.deny.length);

  return {
    roles: names,
    deniedStatuses: stored.deniedStatuses?.length ? stored.deniedStatuses : DEFAULT_DENIED,
    rules: [
      ...[...derived.values()].map((rule) => ({ ...rule, allow: order(rule.allow), deny: order(rule.deny) })),
      ...kept,
    ].sort((left, right) => left.operationId.localeCompare(right.operationId)),
    crossRole: (stored.crossRole ?? [])
      .map((rule) => ({ ...rule, source: rename(rule.source), target: rename(rule.target) }))
      .filter((rule) => known.has(rule.source) && known.has(rule.target) && rule.source !== rule.target),
  };
}
