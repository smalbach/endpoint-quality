/**
 * Una colección, como la guarda este producto.
 *
 * Una colección de Postman es un **árbol ordenado que se corre de arriba abajo**: carpetas,
 * peticiones, y los scripts que cada una lleva encima. Antes esto entraba partido en flujos —un
 * grafo por carpeta, las aristas inventadas a partir del orden— y lo que salía por el otro lado ya
 * no era la colección de nadie: ni se podía volver a exportar, ni se podía editar como en el
 * producto del que venía, ni se corría como allí. Aquí el árbol se guarda tal cual, y por eso
 * importar, editar y correr son la misma colección.
 *
 * **El documento entero va en una columna `jsonb`.** Una colección es un fichero: se lee entera
 * para enseñarla y para correrla, se escribe entera al mover una petición de carpeta, y nadie
 * consulta «todas las peticiones que empiezan por POST» entre colecciones. Filas por nodo
 * comprarían una consulta que nadie hace al precio de un orden y una jerarquía que habría que
 * reconstruir en cada lectura.
 *
 * **Una petición tiene los campos de un endpoint.** `EndpointBody`, `EndpointHeader`,
 * `RequestAuth`: los mismos, para que el editor de peticiones que ya existe sea el que las edite y
 * para que enviarla sea el mismo camino —con su guardia SSRF, sus credenciales y su cajón de
 * cookies— y no un segundo motor.
 */
import type { RequestAuth } from "@eq/runner-core";

import type {
  EndpointBody,
  EndpointHeader,
  EndpointMethod,
  EndpointPathParameter,
  EndpointQueryParameter,
} from "@/modules/endpoints/domain/model";

export const COLLECTION_ITEM_KINDS = ["folder", "request"] as const;
export type CollectionItemKind = (typeof COLLECTION_ITEM_KINDS)[number];

/** Una variable de la colección: lo que `pm.collectionVariables` lee y escribe durante la corrida. */
export type CollectionVariable = { key: string; value: string; enabled: boolean };

export type CollectionRequest = {
  method: EndpointMethod;
  /** Cruda, con sus `{{variables}}`: `{{baseUrl}}/v1/products`, `/v1/products` o una URL entera. */
  url: string;
  pathParameters: EndpointPathParameter[];
  query: EndpointQueryParameter[];
  headers: EndpointHeader[];
  body: EndpointBody;
  auth: RequestAuth;
};

/**
 * Un nodo del árbol: una carpeta con `items`, o una petición con `request`.
 *
 * Un solo tipo y no una unión, por lo mismo que `EndpointBody` es un objeto con todos los campos:
 * convertir una carpeta vacía en petición y volver no debería perder lo escrito. `kind` dice cuál
 * de las dos mitades cuenta, y el esquema exige que la otra esté vacía.
 */
export type CollectionItem = {
  id: string;
  kind: CollectionItemKind;
  name: string;
  description: string;
  preRequestScript: string;
  postResponseScript: string;
  /**
   * La de la carpeta, que es la que heredan las peticiones de dentro. Null en una petición: la
   * suya vive en `request.auth`, que es donde la edita el editor de peticiones.
   *
   * `{type:"inherit"}` es «la de arriba» y es distinto de `{type:"none"}`, que es «esta carpeta no
   * se autentica aunque la colección sí». Guardar las dos igual borraría una decisión.
   */
  auth: RequestAuth | null;
  request: CollectionRequest | null;
  items: CollectionItem[];
};

/** Lo que va en la columna: todo menos el nombre y las fechas, que son de la fila. */
export type CollectionDocument = {
  auth: RequestAuth;
  variables: CollectionVariable[];
  preRequestScript: string;
  postResponseScript: string;
  items: CollectionItem[];
};

export type CollectionRow = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  document: CollectionDocument;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
};

export const COLLECTION_RUN_STATUSES = ["running", "passed", "failed", "cancelled", "error"] as const;
export type CollectionRunStatus = (typeof COLLECTION_RUN_STATUSES)[number];

export type CollectionTestResult = { name: string; passed: boolean; message: string | null };

export type CollectionRunResult = {
  iteration: number;
  itemId: string;
  name: string;
  folder: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  sizeBytes: number;
  tests: CollectionTestResult[];
  error: string | null;
  logs: { level: "log" | "info" | "warn" | "error"; text: string }[];
};

export type CollectionRunTotals = {
  requests: number;
  failed: number;
  tests: number;
  testsPassed: number;
  testsFailed: number;
};

export const EMPTY_TOTALS: CollectionRunTotals = {
  requests: 0,
  failed: 0,
  tests: 0,
  testsPassed: 0,
  testsFailed: 0,
};

/**
 * Una corrida de la colección, con sus resultados dentro.
 *
 * El nombre de la colección se copia en la fila —no se lee de la colección al enseñarla— por lo
 * mismo que una corrida de carga copia su plan: una corrida es un hecho sobre un minuto, y
 * renombrar la colección después no reescribe lo que se corrió.
 */
export type CollectionRun = {
  id: string;
  /** Quién es el dueño: el runner manda cada petición por el mismo comando que el editor, y ese
   * comando resuelve el proyecto dentro de su organización. */
  organizationId: string;
  projectId: string;
  collectionId: string;
  collectionName: string;
  environmentId: string | null;
  environmentName: string | null;
  status: CollectionRunStatus;
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  folderId: string | null;
  folderName: string | null;
  totals: CollectionRunTotals;
  results: CollectionRunResult[];
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  /** Quién la lanzó: su token de sesión y su tarro de cookies son los que se presentan. */
  startedBy: string;
};

export const EMPTY_DOCUMENT: CollectionDocument = {
  auth: { type: "inherit", params: {} },
  variables: [],
  preRequestScript: "",
  postResponseScript: "",
  items: [],
};

/** Una petición vacía, la que sale al pulsar «Nueva petición». */
export const emptyRequest = (): CollectionRequest => ({
  method: "GET",
  url: "",
  pathParameters: [],
  query: [],
  headers: [],
  body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
  auth: { type: "inherit", params: {} },
});

/** Una carpeta vacía, la que sale al pulsar «Nueva carpeta». */
export const emptyFolder = (id: string, name: string): CollectionItem => ({
  id,
  kind: "folder",
  name,
  description: "",
  preRequestScript: "",
  postResponseScript: "",
  auth: null,
  request: null,
  items: [],
});

/** Lo que hay dentro, contado: carpetas y peticiones, a cualquier profundidad. */
export function countItems(items: CollectionItem[]): { folders: number; requests: number } {
  let folders = 0;
  let requests = 0;
  for (const item of items) {
    if (item.kind === "folder") {
      folders += 1;
      const inside = countItems(item.items);
      folders += inside.folders;
      requests += inside.requests;
    } else requests += 1;
  }
  return { folders, requests };
}

/** Un nodo y el camino de carpetas hasta él, en el orden en que se corren. */
export type FlatItem = { item: CollectionItem; trail: CollectionItem[] };

/**
 * El árbol, de arriba abajo, como lo recorre el runner.
 *
 * Profundidad primero y en orden: es lo que hace Postman, y el orden es la mitad de lo que una
 * colección dice —el `Setup · crear producto A` tiene que correr antes que el filtro que lo busca—.
 */
export function flatten(items: CollectionItem[], trail: CollectionItem[] = []): FlatItem[] {
  const flat: FlatItem[] = [];
  for (const item of items) {
    flat.push({ item, trail });
    if (item.kind === "folder") flat.push(...flatten(item.items, [...trail, item]));
  }
  return flat;
}

/** Las peticiones de un árbol, en orden, con las carpetas que las contienen. */
export const requestsOf = (items: CollectionItem[]): FlatItem[] =>
  flatten(items).filter((entry) => entry.item.kind === "request");

/** Un nodo por id, esté donde esté, con su camino. */
export function findItem(items: CollectionItem[], id: string): FlatItem | null {
  return flatten(items).find((entry) => entry.item.id === id) ?? null;
}

/**
 * El árbol con un nodo cambiado por lo que devuelva `change`, o quitado si devuelve null.
 *
 * Una función y no un `find` seguido de una mutación: el documento se guarda entero en cada
 * escritura, y mutar el que se acaba de leer de la base deja al repositorio guardando una mezcla
 * de lo viejo y lo nuevo según por dónde se mirara.
 */
export function replaceItem(
  items: CollectionItem[],
  id: string,
  change: (item: CollectionItem) => CollectionItem | null,
): CollectionItem[] {
  const next: CollectionItem[] = [];
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

/** El árbol con `added` metido dentro de `parentId`, o al final de la raíz si es null. */
export function insertItem(items: CollectionItem[], parentId: string | null, added: CollectionItem): CollectionItem[] {
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
export function contains(items: CollectionItem[], ancestorId: string, id: string): boolean {
  const found = findItem(items, id);
  return Boolean(found?.trail.some((folder) => folder.id === ancestorId));
}

/**
 * Cuál de las autenticaciones gana para una petición.
 *
 * La de la petición manda sobre la de la carpeta, la carpeta más interna sobre las de fuera, y
 * cualquiera de ellas sobre la de la colección — el orden de Postman. `inherit` en todas las de
 * arriba deja `inherit`, que aquí sigue significando «la del proyecto»: es la cadena que el botón
 * de enviar ya resuelve, y la que hace que una colección importada sin bloque `auth` funcione
 * contra un proyecto que sí tiene login.
 */
export function resolveItemAuth(
  own: RequestAuth,
  trail: CollectionItem[],
  collection: RequestAuth,
): RequestAuth {
  if (own.type !== "inherit") return own;
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const folder = trail[index].auth;
    if (folder && folder.type !== "inherit") return folder;
  }
  return collection;
}

/** El nombre de la carpeta que contiene a una petición, con `/` entre niveles. */
export const trailName = (trail: CollectionItem[]): string => trail.map((folder) => folder.name).join(" / ");
