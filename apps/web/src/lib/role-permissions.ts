/**
 * A role's permissions as the screen edits them: one cell per endpoint, folders that set many at
 * once, and the patch that goes back — only what changed.
 *
 * The API stores decided cells only and treats a missing one as «sin decidir», so a cell here is
 * never a boolean: a folder of three endpoints where one is allowed and two were never decided is
 * «mixto», not «permitido».
 */
import type { DataScope, RoleAccess, RolePermissionView, RoleRuleView } from "@/lib/types";

export type Cell = { access: RoleAccess; dataScope: DataScope };
export type Cells = Record<string, Cell>;

export const UNDECIDED: Cell = { access: "undecided", dataScope: "all" };

export const ACCESS_LABEL: Record<RoleAccess, string> = {
  undecided: "Sin decidir",
  allow: "Permitido",
  deny: "Denegado",
};

export const SCOPE_LABEL: Record<DataScope, string> = {
  all: "Todos los datos",
  own: "Solo los suyos",
  none: "Ningún dato",
};

/** The analyzer's palette; the API gives a new role the next one. */
export const ROLE_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6"];

export function cellsFrom(permissions: RolePermissionView[]): Cells {
  return Object.fromEntries(
    permissions.map((permission) => [
      permission.endpointId,
      { access: permission.access, dataScope: permission.dataScope },
    ]),
  );
}

export const cellOf = (cells: Cells, id: string): Cell => cells[id] ?? UNDECIDED;

/** What a folder's select shows: the shared value, or `mixed`. `null` for an empty folder. */
export function groupAccess(ids: string[], cells: Cells): RoleAccess | "mixed" | null {
  if (!ids.length) return null;
  const first = cellOf(cells, ids[0]).access;
  return ids.every((id) => cellOf(cells, id).access === first) ? first : "mixed";
}

/** The same over the data scope, counting only the endpoints the role reaches. */
export function groupScope(ids: string[], cells: Cells): DataScope | "mixed" | null {
  const allowed = ids.filter((id) => cellOf(cells, id).access === "allow");
  if (!allowed.length) return null;
  const first = cellOf(cells, allowed[0]).dataScope;
  return allowed.every((id) => cellOf(cells, id).dataScope === first) ? first : "mixed";
}

/** Applies one change to every endpoint of a folder — or to one, which is a folder of one. */
export function setCells(cells: Cells, ids: string[], patch: Partial<Cell>): Cells {
  const next = { ...cells };
  for (const id of ids) {
    const cell = { ...cellOf(cells, id), ...patch };
    if (cell.access === "undecided") delete next[id];
    else next[id] = cell;
  }
  return next;
}

/** The cells that differ from what is stored, as the API's patch. An erased cell is `undecided`. */
export function changesBetween(saved: Cells, draft: Cells): (Cell & { endpointId: string })[] {
  const ids = [...new Set([...Object.keys(saved), ...Object.keys(draft)])].sort();
  return ids
    .filter((id) => {
      const before = cellOf(saved, id);
      const after = cellOf(draft, id);
      return before.access !== after.access || (after.access !== "undecided" && before.dataScope !== after.dataScope);
    })
    .map((id) => ({ endpointId: id, ...cellOf(draft, id) }));
}

export type RuleFlag = "canRead" | "canWrite" | "canDelete";

export function ruleOf(rules: RoleRuleView[], sourceRoleId: string, targetRoleId: string): RoleRuleView {
  return (
    rules.find((rule) => rule.sourceRoleId === sourceRoleId && rule.targetRoleId === targetRoleId) ?? {
      sourceRoleId,
      targetRoleId,
      canRead: false,
      canWrite: false,
      canDelete: false,
    }
  );
}

/** Flips one letter of one cell of the R/W/D matrix. A cell with nothing on is dropped. */
export function toggleRule(rules: RoleRuleView[], sourceRoleId: string, targetRoleId: string, flag: RuleFlag) {
  const current = ruleOf(rules, sourceRoleId, targetRoleId);
  const next = { ...current, [flag]: !current[flag] };
  const rest = rules.filter((rule) => !(rule.sourceRoleId === sourceRoleId && rule.targetRoleId === targetRoleId));
  return next.canRead || next.canWrite || next.canDelete ? [...rest, next] : rest;
}
