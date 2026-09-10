/**
 * What a role may do to another member, decided in one place.
 *
 * The API decides for real — every one of these rules is enforced by a handler, and a screen that
 * disagreed would only be lying to the person reading it. This exists so the buttons that cannot
 * work are not offered: a disabled control with a reason beats a 403 arriving after a click.
 *
 * Exported as pure functions so they can be asserted without rendering anything.
 */
import type { Role } from "./types";

/** The ladder. Comparing roles as strings is how «admin» ends up outranking «owner». */
export const ROLES: Role[] = ["viewer", "editor", "admin", "owner"];

export const rank = (role: Role): number => ROLES.indexOf(role);
export const atLeast = (role: Role | undefined, needed: Role): boolean => role !== undefined && rank(role) >= rank(needed);

/**
 * Whether `actor` may change `target`'s role, and why not when they may not.
 *
 * The rule that matters is the last one: an organization with no owner is an organization nobody
 * can administer, and the way that happens is the only owner demoting themselves — which looks
 * like an ordinary edit right up until it is done.
 */
export function canChangeRole(actor: Role | undefined, target: { role: Role; isSelf: boolean }, owners: number): string | null {
  if (!atLeast(actor, "admin")) return "Hace falta ser admin";
  if (target.role === "owner" && actor !== "owner") return "Solo un owner cambia a otro owner";
  if (target.isSelf && target.role === "owner" && owners <= 1) return "Eres el único owner: la organización se quedaría sin quien la administre";
  return null;
}

/** Leaving is not expelling, and the API tells them apart by who the target is. A viewer may
 * always leave; removing somebody else needs admin. */
export function canRemove(actor: Role | undefined, target: { role: Role; isSelf: boolean }, owners: number): string | null {
  if (target.isSelf) {
    if (target.role === "owner" && owners <= 1) return "Eres el único owner: nombra a otro antes de salir";
    return null;
  }
  if (!atLeast(actor, "admin")) return "Hace falta ser admin";
  if (target.role === "owner" && actor !== "owner") return "Solo un owner puede sacar a otro owner";
  return null;
}
