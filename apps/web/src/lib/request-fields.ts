/**
 * The parameter and header rows of a saved request, as data.
 *
 * The same two-maps-and-a-flag round trip `env-variables.ts` does for an environment, and for the
 * same reason: a row carries `enabled` because a parameter you are not sending this week is not
 * one you want to retype next week, and the only way to say so used to be deleting it. What is
 * switched off is stored **beside** what is sent, never as a flag inside it, so `parameters` and
 * `headers` go on meaning everywhere exactly what they mean on the wire — and nothing downstream,
 * the engine included, has to remember to filter.
 *
 * It is a module and not a component because this is the part worth asserting. Rows that survive
 * a save, a name typed into the blank row at the bottom, a duplicate reported on the second
 * occurrence rather than the first: none of those are display concerns, and all three were wrong
 * at some point in the environment editor before they were tested here.
 */

export type FieldRow = { name: string; value: string; enabled: boolean };

/**
 * What a header may be called, and what it may say.
 *
 * RFC 9110's token for the name; anything without a line break for the value. The second is not
 * pedantry: a newline inside a header value is request splitting, and the value comes from a text
 * field that a `{{variable}}` is also substituted into. The API refuses the same two things, so
 * this is the message arriving before the round trip rather than instead of it.
 */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
export const HEADER_VALUE = /^[^\r\n]*$/;

export const emptyFieldRow = (): FieldRow => ({ name: "", value: "", enabled: true });

/** A row nobody has typed in yet. The ghost at the bottom of the table is one. */
export const isBlankField = (row: FieldRow): boolean => !row.name.trim() && !row.value;

/**
 * The two stored maps, as one list.
 *
 * Sorted by name for the same reason the variables are: `jsonb` does not keep the order keys were
 * written in — Postgres orders them by length and then bytewise — so there is no original order to
 * preserve, and anything but sorting looks shuffled to whoever typed them.
 */
export function fieldRowsFrom(enabled: Record<string, string>, disabled: Record<string, string>): FieldRow[] {
  const rows = (map: Record<string, string>, on: boolean) =>
    Object.entries(map).map(([name, value]) => ({ name, value, enabled: on }));
  return [...rows(enabled, true), ...rows(disabled, false)].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Back to the two maps.
 *
 * Rows with a blank name are dropped: a half-typed row is not a parameter yet, and sending `?=` is
 * not what somebody who has typed nothing meant. A name that appears twice keeps its **last**
 * value, which is the one that is being typed.
 */
export function fieldMapsFrom(rows: FieldRow[]): { enabled: Record<string, string>; disabled: Record<string, string> } {
  const named = rows.map((row) => ({ ...row, name: row.name.trim() })).filter((row) => row.name);
  const collect = (on: boolean) =>
    Object.fromEntries(named.filter((row) => row.enabled === on).map((row) => [row.name, row.value]));
  return { enabled: collect(true), disabled: collect(false) };
}

/**
 * What is wrong with a row, said next to the row.
 *
 * A duplicate is reported on the *second* occurrence and not the first: the first one is the one
 * that was already there, and blaming it moves the cursor to the wrong place. The pair is counted
 * across both switches, because a name that is on in one row and off in another is a request whose
 * behaviour depends on which map a reader looks at first — and the API refuses it.
 */
export function fieldProblems(rows: FieldRow[], kind: "parameter" | "header"): { index: number; detail: string }[] {
  const problems: { index: number; detail: string }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const name = row.name.trim();
    if (!name) return;
    if (kind === "header" && !HEADER_NAME.test(name)) {
      problems.push({
        index,
        detail: "Letras, cifras y « ! # $ % & ' * + . ^ _ ` | ~ - »: así son los nombres de cabecera",
      });
    } else if (kind === "header" && !HEADER_VALUE.test(row.value)) {
      problems.push({ index, detail: "Una cabecera no puede llevar un salto de línea" });
    } else if (seen.has(name)) {
      problems.push({
        index,
        detail: kind === "header" ? "Ya hay una cabecera con ese nombre" : "Ya hay un parámetro con ese nombre",
      });
    }
    seen.add(name);
  });
  return problems;
}
