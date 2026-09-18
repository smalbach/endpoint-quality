import { createHash } from "node:crypto";

/**
 * La comparación a tres bandas entre una bifurcación, su original y el punto donde se separaron.
 *
 * Pura a propósito: aquí no hay filas, ni ids de base de datos, ni proyectos. Hay tres fotos del
 * mismo conjunto de elementos, cada una indexada por la **clave de linaje** del elemento —la que
 * dice «este flujo de aquí es aquel de allí» aunque los dos tengan ids distintos—, y la respuesta
 * es qué cambió en cada lado desde la foto común. Todo lo que sabe de filas vive en
 * `fork-snapshot.ts`; esto es lo que se prueba caso por caso sin levantar nada.
 *
 * Se habla de **origen** y **destino**, no de original y bifurcación, porque la misma comparación
 * sirve en los dos sentidos: traer cambios es origen = original, destino = bifurcación; fusionar
 * es al revés. Lo que no cambia es la foto común.
 */

/**
 * En el orden en que se enseñan. Suites, roles y secciones llegaron después que los otros cuatro:
 * al bifurcar ya se copiaban, pero no se comparaban, y un rol arreglado en el original había que
 * repetirlo a mano en cada bifurcación —justo lo que bifurcar venía a quitar—.
 */
export const MERGE_KINDS = ["endpoint", "template", "workflow", "suite", "environment", "role", "section"] as const;
export type MergeKind = (typeof MERGE_KINDS)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Un elemento en una foto: cómo se llama para una persona, y lo que se compara. */
export type SnapshotEntry = { label: string; content: JsonValue };

/** Clave de linaje → elemento, por tipo. Lo que se guarda como punto de bifurcación. */
export type ForkSnapshot = Record<MergeKind, Record<string, SnapshotEntry>>;

export const emptySnapshot = (): ForkSnapshot => ({
  endpoint: {},
  template: {},
  workflow: {},
  suite: {},
  environment: {},
  role: {},
  section: {},
});

/**
 * Una foto con todos los tipos, aunque se guardara cuando había menos.
 *
 * Una bifurcación anterior a las suites, los roles y las secciones tiene una foto común sin ellos.
 * Leída tal cual, cada suite de los dos lados sería «añadida en los dos» —`same` si coinciden, un
 * conflicto si no—, que es lo honrado: no se sabe qué tenían en común, y la primera sincronización
 * deja la foto completa.
 */
export function withAllKinds(snapshot: Partial<ForkSnapshot>): ForkSnapshot {
  const complete = emptySnapshot();
  for (const kind of MERGE_KINDS) complete[kind] = snapshot[kind] ?? {};
  return complete;
}

export type Change = "none" | "added" | "modified" | "deleted";

/**
 * Qué pasa con un elemento, visto desde el destino.
 *
 * - `incoming`: solo cambió el origen. Se aplica.
 * - `kept`: solo cambió el destino. Se queda como está; es trabajo del destino que el origen no
 *   tiene, y saldrá en la comparación del sentido contrario.
 * - `same`: los dos cambiaron y quedaron iguales —el mismo arreglo hecho dos veces, o borrado en
 *   los dos—. No hay nada que decidir.
 * - `conflict`: los dos cambiaron y no coinciden. Alguien tiene que elegir.
 */
export type DiffStatus = "incoming" | "kept" | "same" | "conflict";

/** Una ruta dentro del contenido y su valor en cada foto; ausente es `undefined`. */
export type FieldChange = { path: string; base?: JsonValue; source?: JsonValue; target?: JsonValue };

export type DiffEntry = {
  kind: MergeKind;
  key: string;
  label: string;
  sourceChange: Change;
  targetChange: Change;
  status: DiffStatus;
  fields: FieldChange[];
};

export type Side = "source" | "target";
/** `kind:key` → qué lado gana. Solo se leen las de los conflictos. */
export type Resolutions = Record<string, Side>;

export const entryId = (entry: Pick<DiffEntry, "kind" | "key">): string => `${entry.kind}:${entry.key}`;

/**
 * JSON con las claves ordenadas: dos objetos iguales escritos en otro orden son el mismo objeto.
 *
 * Sin esto, un `jsonb` que Postgres devuelve con sus claves reordenadas sería «modificado» en cada
 * comparación, y una bifurcación que nadie ha tocado tendría siempre algo que fusionar.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const same = (a: SnapshotEntry | undefined, b: SnapshotEntry | undefined): boolean =>
  a === undefined || b === undefined ? a === b : canonicalJson(a.content) === canonicalJson(b.content);

function changeOf(base: SnapshotEntry | undefined, side: SnapshotEntry | undefined): Change {
  if (!base) return side ? "added" : "none";
  if (!side) return "deleted";
  return same(base, side) ? "none" : "modified";
}

/**
 * Cada elemento que cambió en algún lado, con su estado y sus campos.
 *
 * Los que no cambiaron en ninguno no salen: una lista de doscientos «sin cambios» esconde los tres
 * que importan.
 */
export function threeWayDiff(
  storedBase: ForkSnapshot,
  storedSource: ForkSnapshot,
  storedTarget: ForkSnapshot,
): DiffEntry[] {
  const base = withAllKinds(storedBase);
  const source = withAllKinds(storedSource);
  const target = withAllKinds(storedTarget);
  const entries: DiffEntry[] = [];
  for (const kind of MERGE_KINDS) {
    const keys = new Set([...Object.keys(base[kind]), ...Object.keys(source[kind]), ...Object.keys(target[kind])]);
    for (const key of [...keys].sort()) {
      const b = base[kind][key];
      const s = source[kind][key];
      const t = target[kind][key];
      const sourceChange = changeOf(b, s);
      const targetChange = changeOf(b, t);
      if (sourceChange === "none" && targetChange === "none") continue;
      const status: DiffStatus =
        targetChange === "none" ? "incoming" : sourceChange === "none" ? "kept" : same(s, t) ? "same" : "conflict";
      entries.push({
        kind,
        key,
        label: (s ?? t ?? b)!.label,
        sourceChange,
        targetChange,
        status,
        fields: fieldChanges(b?.content, s?.content, t?.content),
      });
    }
  }
  return entries;
}

const isObject = (value: unknown): value is Record<string, JsonValue> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Las rutas donde las tres versiones no coinciden, bajando por los objetos.
 *
 * Las listas no se abren: una lista de pasos o de cabeceras cambia de orden y de longitud, y un
 * diff por posición diría que cambiaron todas. Se enseña entera, antes y después, que es lo que
 * alguien puede leer.
 */
export function fieldChanges(
  base: JsonValue | undefined,
  source: JsonValue | undefined,
  target: JsonValue | undefined,
) {
  const changes: FieldChange[] = [];
  walk("", base, source, target, changes);
  return changes;
}

function walk(
  path: string,
  base: JsonValue | undefined,
  source: JsonValue | undefined,
  target: JsonValue | undefined,
  out: FieldChange[],
): void {
  const equal = (a: JsonValue | undefined, b: JsonValue | undefined) =>
    a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
  // Los dos lados iguales, y la foto común igual o sin este campo: nada que enseñar. Lo segundo es
  // lo que hace que dos elementos creados a la vez no listen como distinto cada campo que comparten.
  if (equal(source, target) && (base === undefined || equal(base, source))) return;
  const present = [base, source, target].filter((value) => value !== undefined);
  if (present.length && present.every(isObject)) {
    const keys = new Set(present.flatMap((value) => Object.keys(value as object)));
    for (const key of [...keys].sort()) {
      const pick = (value: JsonValue | undefined) => (isObject(value) ? value[key] : undefined);
      walk(path ? `${path}.${key}` : key, pick(base), pick(source), pick(target), out);
    }
    return;
  }
  out.push({
    path: path || "(todo)",
    ...(base !== undefined ? { base } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(target !== undefined ? { target } : {}),
  });
}

/** Qué lado gana en un elemento: el origen en lo que solo él cambió, el destino en lo que solo el
 * destino cambió, y lo que se eligió en un conflicto. */
export function winner(entry: DiffEntry, resolutions: Resolutions): Side {
  if (entry.status === "incoming") return "source";
  if (entry.status === "conflict") return resolutions[entryId(entry)] ?? "target";
  return "target";
}

/**
 * Lo que falta o sobra en las decisiones, antes de escribir nada.
 *
 * Un conflicto sin decidir no se resuelve a favor de nadie por defecto: quedarse con el destino sin
 * que nadie lo diga sería perder el trabajo del otro lado en silencio, y es justo la pérdida que una
 * comparación a tres bandas existe para evitar.
 */
export function resolutionProblems(
  entries: DiffEntry[],
  resolutions: Resolutions,
): { field: string; detail: string }[] {
  const conflicts = new Set(entries.filter((entry) => entry.status === "conflict").map(entryId));
  const problems: { field: string; detail: string }[] = [];
  for (const id of conflicts) {
    if (!resolutions[id]) problems.push({ field: `resolutions.${id}`, detail: "Elige qué lado se queda" });
  }
  for (const [id, side] of Object.entries(resolutions)) {
    if (!conflicts.has(id))
      problems.push({ field: `resolutions.${id}`, detail: "No es un conflicto de esta comparación" });
    else if (side !== "source" && side !== "target")
      problems.push({ field: `resolutions.${id}`, detail: "source o target" });
  }
  return problems;
}

/**
 * La huella de una comparación: las tres fotos juntas.
 *
 * Quien aplica manda la que vio. Si cualquiera de los dos proyectos cambió entre la vista y el
 * clic, la huella ya no coincide y se contesta 409 en vez de aplicar unas decisiones tomadas sobre
 * algo que ya no existe.
 */
export function diffToken(base: ForkSnapshot, source: ForkSnapshot, target: ForkSnapshot): string {
  return createHash("sha256").update(canonicalJson({ base, source, target })).digest("hex").slice(0, 32);
}
