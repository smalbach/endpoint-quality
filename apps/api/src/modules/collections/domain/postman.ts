/**
 * Un fichero de Postman, leído como la colección que es, y escrito de vuelta.
 *
 * Los dos sentidos viven juntos porque son inversos: lo que el lector saca de un `item` es lo que
 * el escritor vuelve a poner, y cuando se separan uno aprende un campo y el otro no, que es
 * exactamente cómo una exportación deja de poder reimportarse. La prueba que cuenta es la ida y
 * vuelta: importar el fichero de alguien, exportarlo, y que `newman` corra el resultado.
 *
 * **El árbol se conserva.** Es lo único que esto hace distinto de lo que había: antes una
 * colección entraba partida en flujos —un grafo por carpeta, las aristas deducidas del orden— y ni
 * volvía a salir ni se editaba como en Postman. Aquí una carpeta es una carpeta, una petición es
 * una petición, y el orden es el del fichero.
 *
 * **Lo que no se puede guardar se nombra.** Un secreto escrito a mano en el bloque `auth` no entra
 * en claro en una columna `jsonb` —la misma regla que endpoints y flujos—, sale como aviso y deja
 * el hueco marcado. Una petición sin URL no entra, y se dice cuál.
 */
import { randomUUID } from "node:crypto";

import { NO_AUTH, type RequestAuth } from "@eq/runner-core";
import { EMPTY_BODY, type EndpointBody, type EndpointMethod, ENDPOINT_METHODS } from "@/modules/endpoints/domain/model";
import { bodyFrom, graphqlBodyFrom } from "@/modules/endpoints/domain/import-endpoints";
import {
  eventScript,
  postmanBody,
  postmanFormRows,
  postmanGraphql,
  postmanUrl,
} from "@/modules/workflows/domain/import-requests";
import { isReadable, readPostmanAuth, redactAuth, writePostmanAuth } from "@/modules/workflows/domain/postman-auth";
import {
  POSTMAN_SCHEMA,
  type KeyValue,
  type PostmanCollectionFile,
  type PostmanEvent,
  type PostmanItem,
  type PostmanRequest,
} from "@/modules/projects/domain/postman-export";
import type { CollectionDocument, CollectionItem, CollectionRequest, CollectionVariable } from "./model";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Postman guarda una descripción como texto o como `{content, type}`. Las dos se leen. */
const description = (value: unknown): string => asString(value) || asString(asRecord(value)?.content);

/** Una petición que no entró, dicha en palabras: «4 se saltaron» no es algo sobre lo que actuar. */
export type SkippedItem = { name: string; method: string; url: string; reason: string };

export type ReadCollection = {
  name: string;
  description: string;
  document: CollectionDocument;
  skipped: SkippedItem[];
  notes: string[];
};

/**
 * Las filas de un `{key, value, disabled}` en su orden.
 *
 * En filas y no en un mapa, que es lo que necesita un editor: dos cabeceras con el mismo nombre —un
 * par de `Set-Cookie`, dos `X-Tag`— son dos filas en Postman y tienen que seguir siéndolo, y una
 * fila apagada conserva su sitio en la lista.
 */
const rows = (list: unknown): { name: string; value: string; enabled: boolean }[] =>
  asArray(list)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null && asString(row.key ?? row.name).trim() !== "")
    .map((row) => ({
      name: asString(row.key ?? row.name).trim(),
      value: asString(row.value),
      enabled: row.disabled !== true,
    }));

/**
 * La URL partida como la parte Postman: la dirección por un lado y los parámetros por otro.
 *
 * Es lo que hace que la pestaña «Params» tenga algo que enseñar y que una fila apagada se pueda
 * volver a encender. Se guarda sin la query, y el que envía la vuelve a montar con las filas
 * encendidas — así apagar una fila la quita de verdad en vez de dejarla escrita en la dirección.
 */
export function splitUrl(value: unknown): { url: string; query: { name: string; value: string; enabled: boolean }[] } {
  const raw = postmanUrl(value);
  const object = asRecord(value);
  const declared = object ? rows(object.query) : [];
  const [address, search] = splitOnce(raw, "?");
  // Las filas del objeto mandan cuando están: traen el `disabled` que la cadena no puede expresar.
  if (declared.length) return { url: address, query: declared };
  if (!search) return { url: address, query: [] };
  const query = search
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [name, item = ""] = splitOnce(pair, "=");
      return { name: decodePlus(name), value: decodePlus(item), enabled: true };
    })
    .filter((row) => row.name);
  return { url: address, query };
}

const splitOnce = (value: string, separator: string): [string, string] => {
  const at = value.indexOf(separator);
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + separator.length)];
};

/** `%20` y `+` vuelven a ser espacios; lo que no sea escapable se deja como está. */
const decodePlus = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
};

/**
 * El fichero, leído. `null` cuando no es JSON, que es lo único con lo que un lector no puede hacer
 * nada.
 */
export function readPostmanFile(text: string): ReadCollection | null {
  const file = asRecord(safeJson(text));
  if (!file) return null;

  const skipped: SkippedItem[] = [];
  const notes: string[] = [];
  const secrets: string[] = [];

  const auth = (value: unknown, label: string): RequestAuth | null => {
    const read = readPostmanAuth(value);
    if (!read) return null;
    if (!isReadable(read)) {
      notes.push(`${label}: usa una autenticación «${read.unsupported}» que este lector no conoce, queda heredada`);
      return null;
    }
    const clean = redactAuth(read);
    if (clean.dropped.length) secrets.push(`${label} (${clean.dropped.join(", ")})`);
    return clean.auth;
  };

  const walk = (entries: unknown[], trail: string[]): CollectionItem[] => {
    const items: CollectionItem[] = [];
    for (const entry of entries) {
      const node = asRecord(entry);
      if (!node) continue;
      const name = asString(node.name).trim();
      const label = [...trail, name].filter(Boolean).join(" / ") || "Sin nombre";
      if (Array.isArray(node.item)) {
        items.push({
          id: randomUUID(),
          kind: "folder",
          name: name || "Sin nombre",
          description: description(node.description),
          preRequestScript: eventScript(node.event, "prerequest"),
          postResponseScript: eventScript(node.event, "test"),
          auth: auth(node.auth, label),
          request: null,
          items: walk(node.item, name ? [...trail, name] : trail),
        });
        continue;
      }
      const request = asRecord(node.request);
      if (!request) continue;
      const method = (asString(request.method) || "GET").toUpperCase();
      const { url, query } = splitUrl(request.url);
      if (!url) {
        skipped.push({ name: label, method, url: "", reason: "la petición no lleva URL" });
        continue;
      }
      if (!(ENDPOINT_METHODS as readonly string[]).includes(method)) {
        skipped.push({ name: label, method, url, reason: `el método ${method} no se admite` });
        continue;
      }
      const header = rows(request.header);
      const headerMap: Record<string, string> = {};
      for (const row of header) if (row.enabled) headerMap[row.name] = row.value;
      const graphql = postmanGraphql(request.body);
      items.push({
        id: randomUUID(),
        kind: "request",
        name: name || "Sin nombre",
        description: description(request.description ?? node.description),
        preRequestScript: eventScript(node.event, "prerequest"),
        postResponseScript: eventScript(node.event, "test"),
        auth: null,
        request: {
          method: method as EndpointMethod,
          url,
          pathParameters: rows(asRecord(request.url)?.variable).map((row) => ({
            name: row.name,
            type: "string" as const,
            description: "",
            value: row.value,
          })),
          query: query.map((row) => ({
            name: row.name,
            type: "string" as const,
            required: false,
            description: "",
            value: row.value,
            enabled: row.enabled,
          })),
          headers: header,
          body: graphql
            ? graphqlBodyFrom(graphql)
            : bodyFrom(postmanBody(request.body, headerMap), postmanFormRows(request.body).formRows),
          // Ausente significa «hereda», y aquí eso es de la carpeta, de la colección y al final del
          // proyecto. `noauth` es otra cosa —«esta no, aunque las de arriba sí»— y se guarda.
          auth: auth(request.auth, label) ?? { type: "inherit", params: {} },
        },
        items: [],
      });
    }
    return items;
  };

  const items = walk(asArray(file.item), []);
  // La de la colección se lee **antes** de componer los avisos: si se leyera dentro del objeto de
  // abajo, su secreto se apuntaría después de escribir la línea que lo cuenta y el fichero entraría
  // con un hueco vacío que nadie ha explicado.
  const collectionAuth = auth(file.auth, "La colección") ?? { type: "inherit" as const, params: {} };
  if (secrets.length)
    notes.push(
      `Las credenciales escritas a mano no se guardan en claro: ${secrets.join("; ")}. Pon su valor en una variable del entorno y escríbela como {{nombre}}`,
    );

  const info = asRecord(file.info) ?? {};
  return {
    name: asString(info.name).trim() || "Colección importada",
    description: description(info.description),
    document: {
      auth: collectionAuth,
      variables: rows(file.variable).map((row) => ({ key: row.name, value: row.value, enabled: row.enabled })),
      preRequestScript: eventScript(file.event, "prerequest"),
      postResponseScript: eventScript(file.event, "test"),
      items,
    },
    skipped,
    notes,
  };
}

/**
 * La colección, escrita como Postman la escribe.
 *
 * Los secretos siguen la regla del resto de exportaciones de este producto: un valor que es solo
 * `{{variables}}` sale entero —es el nombre del sitio donde está el secreto, no el secreto—, y
 * cualquier otro sale vacío. Un fichero exportado se copia, se manda por correo y se commitea.
 */
export function writePostmanFile(
  collection: { id: string; name: string; description: string; document: CollectionDocument },
): { file: PostmanCollectionFile; redacted: string[] } {
  const redacted: string[] = [];
  const authBlock = (auth: RequestAuth, label: string): Record<string, unknown> | undefined => {
    const written = writePostmanAuth(auth);
    if (written.redacted.length) redacted.push(`${label} (${written.redacted.join(", ")})`);
    return written.block ?? undefined;
  };

  const item = (node: CollectionItem, trail: string[]): PostmanItem => {
    const label = [...trail, node.name].filter(Boolean).join(" / ");
    const events = eventsOf(node.preRequestScript, node.postResponseScript);
    if (node.kind === "folder") {
      return {
        name: node.name,
        ...(node.description ? { description: node.description } : {}),
        ...(events.length ? { event: events } : {}),
        ...(node.auth && node.auth.type !== "inherit" ? { auth: authBlock(node.auth, label) } : {}),
        item: node.items.map((child) => item(child, [...trail, node.name])),
      } as PostmanItem;
    }
    // Un nodo `request` siempre trae su petición: el esquema lo exige al guardar.
    const request = node.request!;
    return {
      name: node.name,
      ...(node.description ? { description: node.description } : {}),
      ...(events.length ? { event: events } : {}),
      request: {
        method: request.method,
        header: request.headers.map(keyValue),
        url: urlOf(request),
        ...bodyOf(request.body),
        ...(request.auth.type === "inherit" ? {} : { auth: authBlock(request.auth, label) }),
        ...(node.description ? { description: node.description } : {}),
      } as PostmanRequest,
    };
  };

  return {
    file: {
      info: {
        _postman_id: collection.id,
        name: collection.name,
        ...(collection.description ? { description: collection.description } : {}),
        schema: POSTMAN_SCHEMA,
      },
      item: collection.document.items.map((node) => item(node, [])),
      variable: collection.document.variables.map((variable) => keyValue({ ...variable, name: variable.key })),
      ...(collection.document.auth.type === "inherit"
        ? {}
        : { auth: authBlock(collection.document.auth, "La colección") }),
      ...(eventsOf(collection.document.preRequestScript, collection.document.postResponseScript).length
        ? { event: eventsOf(collection.document.preRequestScript, collection.document.postResponseScript) }
        : {}),
    } as PostmanCollectionFile,
    redacted,
  };
}

const keyValue = (row: { name: string; value: string; enabled: boolean }): KeyValue => ({
  key: row.name,
  value: row.value,
  ...(row.enabled ? {} : { disabled: true }),
});

const eventsOf = (pre: string, post: string): PostmanEvent[] => {
  const events: PostmanEvent[] = [];
  if (pre.trim())
    events.push({ listen: "prerequest", script: { type: "text/javascript", exec: pre.split("\n") } });
  if (post.trim()) events.push({ listen: "test", script: { type: "text/javascript", exec: post.split("\n") } });
  return events;
};

/** La URL como el objeto que Postman guarda: la cruda con su query montada, y las piezas aparte. */
export function urlOf(request: CollectionRequest): PostmanRequest["url"] {
  const query = request.query.map((row) => ({
    key: row.name,
    value: row.value,
    ...(row.enabled ? {} : { disabled: true }),
  }));
  const search = query
    .filter((row) => !row.disabled)
    .map((row) => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`)
    .join("&");
  return {
    raw: search ? `${request.url}?${search}` : request.url,
    ...(query.length ? { query } : {}),
    ...(request.pathParameters.length
      ? { variable: request.pathParameters.map((parameter) => ({ key: parameter.name, value: parameter.value })) }
      : {}),
  } as PostmanRequest["url"];
}

/** El cuerpo, en el modo con el que Postman lo escribe. `none` no escribe nada. */
function bodyOf(body: EndpointBody): { body?: PostmanRequest["body"] } {
  switch (body.mode) {
    case "none":
      return {};
    case "json":
      return {
        body: {
          mode: "raw",
          raw: body.text,
          options: { raw: { language: "json" } },
        } as PostmanRequest["body"],
      };
    case "raw":
    case "binary":
      return { body: { mode: "raw", raw: body.text } as PostmanRequest["body"] };
    case "graphql":
      return {
        body: {
          mode: "graphql",
          graphql: { query: body.text, variables: body.variables ?? "" },
        } as PostmanRequest["body"],
      };
    default: {
      const mode = body.mode === "form-data" ? "formdata" : "urlencoded";
      const fields = body.fields.map((field) => ({
        key: field.name,
        ...(field.kind === "file" ? { type: "file" as const } : { type: "text" as const, value: field.value }),
        ...(field.enabled ? {} : { disabled: true }),
      }));
      return { body: { mode, [mode]: fields } as PostmanRequest["body"] };
    }
  }
}

/** El cuerpo vacío que sale al crear una petición a mano, para no repetir el literal. */
export const emptyBody = (): EndpointBody => ({ ...EMPTY_BODY, fields: [] });

/** Lo mismo que `NO_AUTH`, nombrado aquí para que el lector no importe dos módulos por una constante. */
export const noAuth = (): RequestAuth => ({ ...NO_AUTH });

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
