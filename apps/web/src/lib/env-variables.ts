/**
 * The environment variables editor, as data.
 *
 * Rows and JSON are two views of one map, and switching between them has to carry the edits
 * across — losing them teaches people to pick one view and never touch the other, which is the
 * opposite of offering two. That round trip is the part worth asserting, so it lives here.
 */
export type VariableRow = [name: string, value: string];

export const rowsFrom = (variables: Record<string, string>): VariableRow[] => Object.entries(variables);

/** Rows with a blank name are dropped: a half-typed row is not a variable yet. */
export function recordFrom(rows: VariableRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter(([name]) => name.trim()).map(([name, value]) => [name.trim(), value]));
}

export const jsonFrom = (rows: VariableRow[]): string => JSON.stringify(recordFrom(rows), null, 2);

/**
 * Parses the JSON view, refusing what the API would refuse anyway — but here, next to the textarea
 * that produced it, instead of as a 422 about a field path.
 */
export function parseVariables(text: string): { ok: true; rows: VariableRow[] } | { ok: false; error: string } {
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
  return { ok: true, rows: entries as VariableRow[] };
}

/** The same rule the engine and the API apply, so the three cannot disagree about a name. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
