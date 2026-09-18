import type { ForkDiffEntryView, ForkDiffView } from "@/lib/types";

/**
 * Lo que la pantalla de traer y fusionar necesita decir, separado de cómo lo dibuja.
 */

export type ForkDirection = ForkDiffView["direction"];
export type ForkSide = "source" | "target";

export const KIND_LABELS: Record<ForkDiffEntryView["kind"], string> = {
  endpoint: "Endpoints",
  template: "Pruebas",
  workflow: "Flujos",
  environment: "Entornos",
};

export const STATUS_LABELS: Record<ForkDiffEntryView["status"], string> = {
  incoming: "Llega",
  kept: "Se queda",
  same: "Igual en los dos",
  conflict: "Conflicto",
};

const CHANGE_WORDS: Record<ForkDiffEntryView["sourceChange"], string> = {
  none: "sin cambios",
  added: "creado",
  modified: "modificado",
  deleted: "borrado",
};

export const entryId = (entry: Pick<ForkDiffEntryView, "kind" | "key">) => `${entry.kind}:${entry.key}`;

/** «modificado en Original · borrado en Bifurcación»: lo que pasó en cada lado que cambió. */
export function changeSummary(entry: ForkDiffEntryView, source: string, target: string): string {
  return [
    entry.sourceChange !== "none" && `${CHANGE_WORDS[entry.sourceChange]} en ${source}`,
    entry.targetChange !== "none" && `${CHANGE_WORDS[entry.targetChange]} en ${target}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** El título y el verbo de cada sentido, dichos desde el proyecto en el que se está. */
export function directionCopy(direction: ForkDirection) {
  return direction === "pull"
    ? { title: "Traer cambios del original", action: "Traer cambios", done: "Cambios traídos" }
    : { title: "Fusionar en el original", action: "Fusionar", done: "Fusionado en el original" };
}

/** Los conflictos que todavía no tienen lado. Mientras haya uno, no se aplica nada. */
export function pendingConflicts(entries: ForkDiffEntryView[], resolutions: Record<string, ForkSide>): string[] {
  return entries.filter((entry) => entry.status === "conflict" && !resolutions[entryId(entry)]).map(entryId);
}

/** Si aplicar escribiría algo: lo que llega y los conflictos resueltos a favor del origen. */
export function writesSomething(entries: ForkDiffEntryView[], resolutions: Record<string, ForkSide>): boolean {
  return entries.some(
    (entry) => entry.status === "incoming" || (entry.status === "conflict" && resolutions[entryId(entry)] === "source"),
  );
}

/** Un valor de un campo, en una línea que se pueda leer; ausente es un guion. */
export function showValue(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === "" ? "(vacío)" : text;
}
