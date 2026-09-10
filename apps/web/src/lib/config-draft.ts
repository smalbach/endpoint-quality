/**
 * The small amount of logic behind the visual configuration editors.
 *
 * Kept out of the components because it is the part worth asserting: order is *data* in this
 * configuration — budget rules and envelope rules are matched first-hit — so moving a row up is
 * not a display concern, it changes which rule wins.
 */

/** The methods a rule can name. Same list as the engine's, and the order it reads in. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A copy with `index` moved by `delta`, or the same list when that would fall off an end. */
export function move<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export const replaceAt = <T,>(items: T[], index: number, value: T): T[] => items.map((item, position) => (position === index ? value : item));
export const removeAt = <T,>(items: T[], index: number): T[] => items.filter((_item, position) => position !== index);

/**
 * A unique id for a new rule, derived from what the operator typed.
 *
 * Ids are referenced by nothing else, but they are what the engine names in an assertion's
 * `source` — so «budget-3» is a worse thing to read in a failed case than «listado-de-tiendas».
 */
export function slugId(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "regla";
  if (!taken.includes(base)) return base;
  let suffix = 2;
  while (taken.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Drops the keys whose value is empty, so an untouched optional field is absent rather than
 * present and blank.
 *
 * It matters: `{ pathSuffix: "" }` is not the same rule as one without `pathSuffix`. The first
 * matches every path ending in nothing — which is every path — and the schema accepts it, so the
 * mistake would only show up as a budget applied to the whole matrix.
 */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === "" || entry === null) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    out[key] = entry;
  }
  return out as Partial<T>;
}

/** Whether a draft still says what was loaded. Used to keep «Guardar» off when there is nothing
 * to save, which is also what stops an accidental write of an unchanged section from moving its
 * `updatedAt` and its `configured` flag. */
export const unchanged = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
