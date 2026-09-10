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
 * Two views over the same rows, and switching carries the edits across: a table for two values,
 * and the text view for twenty pasted from somewhere else. The round trip is the part worth
 * asserting, so it lives here and not in a component.
 */
export type VariableRow = { name: string; value: string; enabled: boolean };

/** The same rule the engine and the API apply, so the three cannot disagree about a name. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export const emptyRow = (): VariableRow => ({ name: "", value: "", enabled: true });

/**
 * The two stored maps, as one list.
 *
 * Sorted by name because `jsonb` does not keep the order keys were written in — Postgres orders
 * them by length and then bytewise — so there is no original order to preserve, and anything but
 * sorting looks shuffled to whoever typed them.
 */
export function rowsFrom(variables: Record<string, string>, disabled: Record<string, string>): VariableRow[] {
  return [
    ...Object.entries(variables).map(([name, value]) => ({ name, value, enabled: true })),
    ...Object.entries(disabled).map(([name, value]) => ({ name, value, enabled: false })),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

/** Rows with a blank name are dropped: a half-typed row is not a variable yet. */
export function mapsFrom(rows: VariableRow[]): {
  variables: Record<string, string>;
  disabledVariables: Record<string, string>;
} {
  const named = rows.map((row) => ({ ...row, name: row.name.trim() })).filter((row) => row.name);
  const collect = (enabled: boolean) =>
    Object.fromEntries(named.filter((row) => row.enabled === enabled).map((row) => [row.name, row.value]));
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
 */
export function bulkFrom(rows: VariableRow[]): string {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => `${row.enabled ? "" : "//"}${row.name.trim()}:${row.value}`)
    .join("\n");
}

/**
 * Reads the text view back.
 *
 * A pasted JSON object is accepted as-is: `{"userId": "42"}` is what the rest of this product
 * shows and what an `.env` exporter or another tab is most likely to hand over, and refusing it
 * on a technicality when the intent is unambiguous is just a puzzle.
 */
export function parseBulk(text: string): { ok: true; rows: VariableRow[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, rows: [] };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fromJson(trimmed);

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
    rows.push({ name, value: body.slice(cut + 1).trim(), enabled });
  }
  return { ok: true, rows };
}

function fromJson(text: string): { ok: true; rows: VariableRow[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : "JSON inválido" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Las variables son un objeto de nombre a valor" };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const wrong = entries.find(([, value]) => typeof value !== "string");
  if (wrong) return { ok: false, error: `«${wrong[0]}» no es texto: una variable siempre lo es` };
  const badName = entries.find(([name]) => !VARIABLE_NAME.test(name));
  if (badName) return { ok: false, error: `«${badName[0]}» no es un nombre de variable válido` };
  return { ok: true, rows: entries.map(([name, value]) => ({ name, value: value as string, enabled: true })) };
}
