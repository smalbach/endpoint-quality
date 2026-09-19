/**
 * The variables of an environment, as data.
 *
 * A row carries `enabled` because a value you are not using this week is not a value you want to
 * retype next week — that is the whole point of the checkbox, and it is the one thing the old
 * editor could not express: the only way to stop applying a variable was to delete it.
 *
 * **The engine never learns that concept.** A disabled row is stored *beside* the map, never
 * inside it, so `variables` keeps meaning everywhere else exactly what it always meant — what a
 * run substitutes. Nothing downstream has to remember to filter.
 *
 * A row also carries **two values and a secret flag**, which is the rest of what Postman's editor
 * says. `initial` is what the project shares; `current` is what a run actually spends, and it is
 * the one a capture overwrites — so debugging with a throwaway token stops rewriting what the next
 * person pulls. `sensitive` means the API never sent the value at all: both fields arrive as
 * {@link MASKED_VALUE}, and sending the mask back means «leave it». That is what lets somebody
 * edit the base URL of an environment whose token they are not allowed to read.
 *
 * Two views over the same rows, and switching carries the edits across: a table for two values,
 * and the text view for twenty pasted from somewhere else. The round trip is the part worth
 * asserting, so it lives here and not in a component.
 */
import type { EnvironmentVariableView, MaskedValue } from "@eq/contracts";

export type VariableRow = {
  name: string;
  initial: string;
  current: string;
  sensitive: boolean;
  enabled: boolean;
};

/** The same rule the engine and the API apply, so the three cannot disagree about a name. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** What the API sends instead of a secret. Typed against the contract: if the server's copy ever
 * changes, this line stops compiling instead of quietly saving eight dots as somebody's token. */
export const MASKED_VALUE: MaskedValue = "••••••••";

export const emptyRow = (): VariableRow => ({ name: "", initial: "", current: "", sensitive: false, enabled: true });

/** A row nobody has typed in yet. The ghost at the bottom of the table is one. */
export const isBlank = (row: VariableRow): boolean => !row.name.trim() && !row.initial && !row.current;

/**
 * The two stored maps, as one list.
 *
 * Sorted by name because `jsonb` does not keep the order keys were written in — Postgres orders
 * them by length and then bytewise — so there is no original order to preserve, and anything but
 * sorting looks shuffled to whoever typed them.
 */
export function rowsFrom(
  variables: Record<string, EnvironmentVariableView>,
  disabled: Record<string, EnvironmentVariableView>,
): VariableRow[] {
  const rows = (map: Record<string, EnvironmentVariableView>, enabled: boolean) =>
    Object.entries(map).map(([name, variable]) => ({ name, ...variable, enabled }));
  return [...rows(variables, true), ...rows(disabled, false)].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Rows with a blank name are dropped: a half-typed row is not a variable yet. */
export function mapsFrom(rows: VariableRow[]): {
  variables: Record<string, EnvironmentVariableView>;
  disabledVariables: Record<string, EnvironmentVariableView>;
} {
  const named = rows.map((row) => ({ ...row, name: row.name.trim() })).filter((row) => row.name);
  const collect = (enabled: boolean) =>
    Object.fromEntries(
      named
        .filter((row) => row.enabled === enabled)
        .map((row) => [row.name, { initial: row.initial, current: row.current, sensitive: row.sensitive }]),
    );
  return { variables: collect(true), disabledVariables: collect(false) };
}

/**
 * What is wrong with a row, said next to the row.
 *
 * A duplicate is reported on the *second* occurrence and not the first: the first one is the one
 * that was already there, and blaming it moves the cursor to the wrong place.
 */
export function problemsWith(rows: VariableRow[]): { index: number; detail: string }[] {
  const problems: { index: number; detail: string }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const name = row.name.trim();
    if (!name) return;
    if (!VARIABLE_NAME.test(name)) {
      problems.push({ index, detail: "Empieza por letra o «_» y sigue con letras, cifras, «_», «-» o «.»" });
      return;
    }
    if (seen.has(name)) problems.push({ index, detail: "Ya hay una variable con ese nombre" });
    seen.add(name);
  });
  return problems;
}

/**
 * The text view, which is what Postman calls bulk edit: one `nombre:valor` per line, and a
 * disabled one commented out. The comment marker is not decoration — it is how the view stays
 * able to say everything the table says, so switching between them loses nothing.
 *
 * The value it shows is `current`, the one a run spends. One line cannot carry two values, and of
 * the two this is the one somebody pasting twenty of them means.
 */
export function bulkFrom(rows: VariableRow[]): string {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => `${row.enabled ? "" : "//"}${row.name.trim()}:${row.current}`)
    .join("\n");
}

/**
 * Reads the text view back.
 *
 * `previous` is what keeps the round trip lossless in the direction the text cannot express: a
 * name that was already there keeps its `initial` and its `sensitive`, so switching to text and
 * back does not quietly unshare a value or turn a secret into a plain one. A name that is new
 * gets the same value in both, which is what one value means.
 *
 * A pasted JSON object is accepted as-is: `{"userId": "42"}` is what the rest of this product
 * shows and what an `.env` exporter or another tab is most likely to hand over, and refusing it
 * on a technicality when the intent is unambiguous is just a puzzle.
 */
export function parseBulk(
  text: string,
  previous: VariableRow[] = [],
): { ok: true; rows: VariableRow[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, rows: [] };
  const known = new Map(previous.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row]));
  const rowFor = (name: string, current: string, enabled: boolean): VariableRow => {
    const before = known.get(name);
    return {
      name,
      initial: before ? before.initial : current,
      current,
      sensitive: before ? before.sensitive : false,
      enabled,
    };
  };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fromJson(trimmed, rowFor);

  const rows: VariableRow[] = [];
  for (const [number, line] of trimmed.split("\n").entries()) {
    const content = line.trim();
    if (!content) continue;
    const enabled = !content.startsWith("//");
    const body = enabled ? content : content.slice(2).trim();
    // Split on the first separator only: a value is very often a URL, and a second colon in it
    // is part of the value.
    const cut = body.search(/[:=]/);
    if (cut < 1) return { ok: false, error: `Línea ${number + 1}: falta «nombre:valor»` };
    const name = body.slice(0, cut).trim();
    if (!VARIABLE_NAME.test(name)) return { ok: false, error: `Línea ${number + 1}: «${name}» no es un nombre válido` };
    rows.push(rowFor(name, body.slice(cut + 1).trim(), enabled));
  }
  return { ok: true, rows };
}

function fromJson(
  text: string,
  rowFor: (name: string, current: string, enabled: boolean) => VariableRow,
): { ok: true; rows: VariableRow[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    // `JSON.parse` only ever throws a `SyntaxError`, whose message says where the text broke.
    return { ok: false, error: (caught as SyntaxError).message };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Las variables son un objeto de nombre a valor" };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const wrong = entries.find(([, value]) => typeof value !== "string");
  if (wrong) return { ok: false, error: `«${wrong[0]}» no es texto: una variable siempre lo es` };
  const badName = entries.find(([name]) => !VARIABLE_NAME.test(name));
  if (badName) return { ok: false, error: `«${badName[0]}» no es un nombre de variable válido` };
  return { ok: true, rows: entries.map(([name, value]) => rowFor(name, value as string, true)) };
}

/**
 * The roles this project declared, read out of the `access` section.
 *
 * Narrowed by hand rather than asserted, because `ConfigSectionView.data` is `unknown` on purpose:
 * it is a `jsonb` column, and a section written by an older version with a different shape has to
 * come back empty rather than crash the screen that draws the credential form. An environment
 * nobody can add a credential to is worse than one that offers only the three reserved names.
 */
export function declaredRoles(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const access = (data as { access?: unknown }).access;
  if (!access || typeof access !== "object") return [];
  const roles = (access as { roles?: unknown }).roles;
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === "string" && role.length > 0)
    : [];
}

/**
 * The three the engine always understands, plus whatever the project called its own.
 *
 * The reserved ones first and always, because they are what the generated 401/403 matrix spends
 * and a project that has declared no roles still needs them. A declared role that happens to be
 * spelled like one of the three is not listed twice.
 */
export const RESERVED_ROLES = ["primary", "insufficient", "alternate"] as const;

export function credentialRoleOptions(declared: string[]): string[] {
  return [...new Set([...RESERVED_ROLES, ...declared])];
}
