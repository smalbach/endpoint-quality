/**
 * The endpoint list as folders, the way the analyzer draws it.
 *
 * One level per first path segment — `/users/{id}/posts` lives in `users` — except when the path
 * starts with a version: `/v1/users` goes in `users › v1`, so two versions of the same module sit
 * next to each other instead of in a `v1` and a `v2` folder that each hold everything. Deeper
 * segments stay flat inside the folder.
 */

export const VERSION_SEGMENT = /^v\d+$/i;
export const ROOT_LABEL = "(raíz)";

type Row = { id: string; method: string; path: string };

export type EndpointFolder<T extends Row> = {
  id: string;
  label: string;
  isVersion: boolean;
  folders: EndpointFolder<T>[];
  endpoints: T[];
};

export function pathSegments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** The folder trail of a path: one label, or the module and its version. */
export function folderTrail(path: string): string[] {
  const segments = pathSegments(path);
  if (!segments.length) return [ROOT_LABEL];
  if (segments.length >= 2 && VERSION_SEGMENT.test(segments[0])) return [segments[1], segments[0].toLowerCase()];
  return [segments[0]];
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function buildEndpointTree<T extends Row>(endpoints: T[]): EndpointFolder<T>[] {
  const roots: EndpointFolder<T>[] = [];
  const find = (list: EndpointFolder<T>[], label: string, id: string) => {
    let folder = list.find((entry) => entry.label === label);
    if (!folder) {
      folder = { id, label, isVersion: VERSION_SEGMENT.test(label), folders: [], endpoints: [] };
      list.push(folder);
    }
    return folder;
  };

  for (const endpoint of endpoints) {
    let list = roots;
    let folder: EndpointFolder<T> | null = null;
    const trail = folderTrail(endpoint.path);
    trail.forEach((label, depth) => {
      folder = find(list, label, trail.slice(0, depth + 1).join("/"));
      list = folder.folders;
    });
    (folder as EndpointFolder<T> | null)?.endpoints.push(endpoint);
  }

  const sort = (list: EndpointFolder<T>[]) => {
    list.sort((a, b) => a.label.localeCompare(b.label));
    for (const folder of list) {
      folder.endpoints.sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          (METHOD_ORDER.indexOf(a.method) + 1 || 99) - (METHOD_ORDER.indexOf(b.method) + 1 || 99),
      );
      sort(folder.folders);
    }
  };
  sort(roots);
  return roots;
}

/** Every endpoint id under a folder, sub-folders included. */
export function endpointIdsOf<T extends Row>(folder: EndpointFolder<T>): string[] {
  return [...folder.endpoints.map((endpoint) => endpoint.id), ...folder.folders.flatMap(endpointIdsOf)];
}

export type SelectionState = "none" | "partial" | "all";

export function selectionState(ids: string[], selected: ReadonlySet<string>): SelectionState {
  const chosen = ids.filter((id) => selected.has(id)).length;
  if (!ids.length || chosen === 0) return "none";
  return chosen === ids.length ? "all" : "partial";
}

/** The group checkbox: anything short of all selects all; all clears. */
export function toggleGroup(ids: string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (selectionState(ids, selected) === "all") ids.forEach((id) => next.delete(id));
  else ids.forEach((id) => next.add(id));
  return next;
}
