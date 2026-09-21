/**
 * El árbol de una colección, como datos.
 *
 * Todo lo que se puede decidir sin un DOM vive aquí: mover una petición a otra carpeta, duplicar
 * una rama con ids nuevos, saber si lo que hay en pantalla difiere de lo guardado. Es la parte
 * que merece tests —un árbol mal cosido se nota tres pantallas después— y la que el componente no
 * tiene por qué saber hacer.
 *
 * Los ids los pone quien llama (`newId`), no una constante global: un componente puede pedir el
 * de `crypto.randomUUID`, y un test uno contado, y ninguno de los dos tiene que parchear al otro.
 */
import type { CollectionItemView, CollectionRequestView, EndpointMethod } from "@/lib/types";

export const METHODS: EndpointMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** El color del método, como lo pinta Postman: el verbo es lo que se lee de un vistazo. */
export const METHOD_CLASS: Record<string, string> = {
  GET: "text-emerald-600",
  POST: "text-amber-600",
  PUT: "text-sky-600",
  PATCH: "text-violet-600",
  DELETE: "text-rose-600",
  HEAD: "text-slate-500",
  OPTIONS: "text-slate-500",
};

/** Los ids de los nodos son del navegador: nada de esto ha llegado al servidor todavía. */
export const newId = (): string => crypto.randomUUID();

export const emptyRequest = (): CollectionRequestView => ({
  method: "GET",
  url: "",
  pathParameters: [],
  query: [],
  headers: [],
  body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
  auth: { type: "inherit", params: {} },
});

export const newRequest = (name: string, id = newId()): CollectionItemView => ({
  id,
  kind: "request",
  name,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: null,
  request: emptyRequest(),
  items: [],
});

export const newFolder = (name: string, id = newId()): CollectionItemView => ({
  id,
  kind: "folder",
  name,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: { type: "inherit", params: {} },
  request: null,
  items: [],
});

/** Un nodo con el camino de carpetas hasta él, en el orden del árbol. */
export type FlatItem = { item: CollectionItemView; trail: CollectionItemView[] };

export function flatten(items: CollectionItemView[], trail: CollectionItemView[] = []): FlatItem[] {
  const flat: FlatItem[] = [];
  for (const item of items) {
    flat.push({ item, trail });
    if (item.kind === "folder") flat.push(...flatten(item.items, [...trail, item]));
  }
  return flat;
}

export const findItem = (items: CollectionItemView[], id: string): FlatItem | null =>
  flatten(items).find((entry) => entry.item.id === id) ?? null;

export const countRequests = (items: CollectionItemView[]): number =>
  flatten(items).filter((entry) => entry.item.kind === "request").length;

/** El árbol con un nodo cambiado por lo que devuelva `change`, o quitado si devuelve null. */
export function replaceItem(
  items: CollectionItemView[],
  id: string,
  change: (item: CollectionItemView) => CollectionItemView | null,
): CollectionItemView[] {
  const next: CollectionItemView[] = [];
  for (const item of items) {
    if (item.id === id) {
      const replaced = change(item);
      if (replaced) next.push(replaced);
      continue;
    }
    next.push(item.kind === "folder" ? { ...item, items: replaceItem(item.items, id, change) } : item);
  }
  return next;
}

/** El árbol con `added` dentro de `parentId`, o al final de la raíz cuando es null. */
export function insertItem(
  items: CollectionItemView[],
  parentId: string | null,
  added: CollectionItemView,
): CollectionItemView[] {
  if (!parentId) return [...items, added];
  return items.map((item) =>
    item.id === parentId && item.kind === "folder"
      ? { ...item, items: [...item.items, added] }
      : item.kind === "folder"
        ? { ...item, items: insertItem(item.items, parentId, added) }
        : item,
  );
}

/** Si `ancestorId` contiene a `id`: mover una carpeta dentro de sí misma pierde el árbol. */
export function contains(items: CollectionItemView[], ancestorId: string, id: string): boolean {
  const found = findItem(items, id);
  return Boolean(found?.trail.some((folder) => folder.id === ancestorId));
}

/**
 * Mover un nodo a otra carpeta.
 *
 * Devuelve el árbol sin tocar cuando el destino está **dentro** del nodo que se mueve: es la única
 * operación de esta pantalla que puede perder una rama entera, y perderla en silencio sería peor
 * que no moverla.
 */
export function moveItem(
  items: CollectionItemView[],
  id: string,
  parentId: string | null,
): CollectionItemView[] {
  if (parentId === id) return items;
  if (parentId && contains(items, id, parentId)) return items;
  const found = findItem(items, id);
  if (!found) return items;
  return insertItem(
    replaceItem(items, id, () => null),
    parentId,
    found.item,
  );
}

/** Subir o bajar un nodo entre sus hermanos, que es como se ordena una colección. */
export function moveWithin(items: CollectionItemView[], id: string, direction: -1 | 1): CollectionItemView[] {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
  return items.map((item) => (item.kind === "folder" ? { ...item, items: moveWithin(item.items, id, direction) } : item));
}

/** Una copia con ids nuevos de arriba abajo: dos nodos con el mismo id son un árbol roto. */
export function duplicateItem(item: CollectionItemView, name = `${item.name} (copia)`): CollectionItemView {
  const copy = (node: CollectionItemView): CollectionItemView => ({
    ...node,
    id: newId(),
    request: node.request ? { ...node.request } : null,
    items: node.items.map(copy),
  });
  return { ...copy(item), name };
}

/** El nombre de las carpetas que contienen a un nodo, con `/` entre niveles. */
export const trailName = (trail: CollectionItemView[]): string => trail.map((folder) => folder.name).join(" / ");

/** Las carpetas del árbol, para el selector de «mover a». */
export const foldersOf = (items: CollectionItemView[]): FlatItem[] =>
  flatten(items).filter((entry) => entry.item.kind === "folder");

export const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Corriendo",
  passed: "Verde",
  failed: "Rojo",
  cancelled: "Cancelada",
  error: "Error",
};

export const RUN_STATUS_CLASS: Record<string, string> = {
  running: "bg-sky-100 text-sky-700",
  passed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  cancelled: "bg-slate-200 text-slate-600",
  error: "bg-rose-100 text-rose-700",
};

/** El estado HTTP con el color que le toca, que es lo que se mira primero en un informe. */
export const statusClass = (status: number | null): string => {
  if (status === null) return "text-rose-600";
  if (status >= 500) return "text-rose-600";
  if (status >= 400) return "text-amber-600";
  return "text-emerald-600";
};
