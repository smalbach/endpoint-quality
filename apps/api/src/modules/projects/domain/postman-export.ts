/**
 * Un proyecto, escrito como lo escribiría Postman.
 *
 * El import ya entendía una colección; la salida no existía, así que este producto era una puerta
 * de un solo sentido: traías tu trabajo de Postman y no podías volver a llevarlo, ni abrirlo con
 * `newman`, ni dárselo a alguien que no use esto. Un formato que se lee y no se escribe es un
 * formato en el que no se puede confiar para meter nada dentro.
 *
 * Es **el inverso exacto** del lector, y por eso vive al lado y no en un módulo nuevo: lo que el
 * lector saca de un `event` de tipo `test` —las comprobaciones y las capturas— es lo que esto
 * vuelve a escribir como `pm.test` y `pm.collectionVariables.set`. La prueba que importa es la ida
 * y vuelta: exportar un proyecto, volver a importar el fichero, y encontrarse los mismos flujos.
 *
 * **Ningún secreto sale.** Las mismas reglas que el bundle propio, por los mismos motivos: un
 * fichero exportado se copia, se manda por correo y se commitea.
 *
 * - Una variable sensible sale con su nombre y el valor vacío, marcada `secret`, que es como Postman
 *   escribe una suya.
 * - Una cabecera de credencial sale **solo** si su valor es enteramente `{{variables}}`. Si trae un
 *   token escrito a mano, sale desactivada y con el valor quitado, no en claro.
 *
 * **Lo que no tiene equivalente no se tira en silencio.** Postman no tiene ramas, ni esperas, ni
 * bucles, ni sub-flujos: un nodo de esos no se puede escribir como un `item`, así que se cuenta en
 * `skipped` y quien exporta lo lee. La alternativa —un fichero que parece completo y ha perdido la
 * mitad del grafo— es peor que no poder exportar.
 */
import type { RequestBody, WorkflowDocument, WorkflowStep, ResponseCheck, WorkflowCapture } from "@eq/runner-core";
import { orderWorkflowSteps } from "@eq/runner-core";

import type { ProjectBundle } from "./project-bundle";
import { writePostmanAuth } from "@/modules/workflows/domain/postman-auth";

export const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** Las cabeceras cuyo valor no sale nunca a menos que sea puramente `{{variables}}`. */
const CREDENTIAL_HEADER = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|apikey)$/i;
/** Un valor que es solo variables, y por tanto no contiene el secreto sino su nombre. */
const ONLY_VARIABLES = /^(?:[A-Za-z][\w-]*\s+)?(?:\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}\s*)+$/;

type KeyValue = { key: string; value: string; disabled?: boolean };
type PostmanEvent = { listen: "prerequest" | "test"; script: { type: "text/javascript"; exec: string[] } };
type PostmanRequest = {
  method: string;
  header: KeyValue[];
  url: { raw: string; query?: KeyValue[] };
  body?: { mode: "raw"; raw: string; options: { raw: { language: string } } };
  /** El bloque `auth` de Postman. Ausente significa «hereda», igual que en sus ficheros. */
  auth?: Record<string, unknown>;
  description?: string;
};
/**
 * Una respuesta guardada, que es lo que Postman llama un ejemplo.
 *
 * `code` y `status` los dos, porque Postman escribe los dos y su interfaz enseña el segundo. El
 * `_postman_previewlanguage` es lo que decide cómo lo pinta al abrirlo: sin él, un JSON sale como
 * un muro de texto.
 */
export type PostmanResponse = {
  name: string;
  originalRequest: PostmanRequest;
  status: string;
  code: number;
  _postman_previewlanguage: string;
  header: KeyValue[];
  cookie: never[];
  body: string;
};

/** Una petición de la colección. Con nombre propio porque es lo que se le cuelga un `event`. */
export type PostmanRequestItem = {
  name: string;
  request: PostmanRequest;
  event?: PostmanEvent[];
  description?: string;
  /** Las respuestas guardadas. Ausente cuando no hay ninguna, como en los ficheros de Postman. */
  response?: PostmanResponse[];
};
export type PostmanItem = PostmanRequestItem | { name: string; description?: string; item: PostmanItem[] };

export type PostmanCollectionFile = {
  info: { _postman_id: string; name: string; description?: string; schema: string };
  item: PostmanItem[];
  variable: KeyValue[];
};

export type PostmanEnvironmentFile = {
  id: string;
  name: string;
  values: { key: string; value: string; type: "default" | "secret"; enabled: boolean }[];
  _postman_variable_scope: "environment";
};

/** Lo que salió y lo que no pudo salir, para que quien exporta no tenga que adivinarlo. */
export type PostmanExport = {
  collection: PostmanCollectionFile;
  environments: PostmanEnvironmentFile[];
  /** Un nodo o un valor que Postman no puede expresar, dicho por su nombre. */
  skipped: { what: string; detail: string }[];
};

/** Ids para el fichero. Se pasan desde fuera para que esto siga siendo una función pura. */
export type PostmanExportIds = { collectionId: string; environmentIds: string[] };

/**
 * Qué peticiones lleva la colección, y **son dos ficheros distintos, no un ajuste**.
 *
 * `flows` son los escenarios: una carpeta por flujo, que es lo que el lector vuelve a convertir en
 * flujos. Da la vuelta sobre sí mismo — exportar, importar, exportar otra vez produce lo mismo.
 *
 * `endpoints` es el API entero, una petición por endpoint del contrato: lo que quiere quien pide
 * «pásame esto a Postman» sin haber escrito un flujo todavía. **No** da la vuelta igual, y no puede:
 * al volver a entrar, una colección es un flujo, porque eso es lo que una colección significa aquí.
 * Meter las dos cosas en el mismo fichero era exactamente ese fallo — cada ida y vuelta añadía un
 * flujo llamado «Endpoints» que nadie había escrito.
 */
export type PostmanExportContents = "flows" | "endpoints";

/** Qué lleva el fichero. Los entornos aparte porque son ficheros suyos en Postman. */
export type PostmanExportOptions = {
  contents?: PostmanExportContents;
  /**
   * Si se traducen los entornos.
   *
   * Apagado, sus avisos tampoco salen — y eso es el punto. Traducirlos siempre llenaba de «la
   * variable X es sensible: sale sin valor» un fichero de colección que no lleva ninguna variable,
   * que es un aviso sobre algo que no está pasando.
   */
  environments?: boolean;
};

export function toPostmanExport(
  bundle: ProjectBundle,
  ids: PostmanExportIds,
  options: PostmanExportOptions = {},
): PostmanExport {
  const contents = options.contents ?? "flows";
  const skipped: PostmanExport["skipped"] = [];
  const projectName = bundle.project?.name || "Proyecto";
  const baseUrl = bundle.settings?.baseUrl ?? "";

  const templates = new Map((bundle.flows?.requestTemplates ?? []).map((template) => [template.id, template]));
  const item: PostmanItem[] = [];
  let name = projectName;

  if (contents === "flows") {
    // Una carpeta por flujo, en el orden del grafo. Es lo que el lector convierte de vuelta en un
    // flujo, así que la ida y la vuelta hablan de la misma cosa.
    for (const workflow of bundle.flows?.workflows ?? []) {
      const folder = folderFor(workflow, templates, skipped);
      if (folder.item.length) item.push(folder);
      else skipped.push({ what: `flujo «${workflow.name}»`, detail: "no tiene ningún nodo que Postman pueda enviar" });
    }
  } else {
    name = `${projectName} · endpoints`;
    const endpoints = (bundle.endpoints ?? []).filter((endpoint) => endpoint.status !== "archived");
    for (const endpoint of endpoints) item.push(endpointItem(endpoint, baseUrl, skipped));
    if (!endpoints.length) skipped.push({ what: "endpoints", detail: "el proyecto no tiene ninguno activo" });
  }

  return {
    collection: {
      info: {
        _postman_id: ids.collectionId,
        name,
        ...(bundle.settings?.description ? { description: bundle.settings.description } : {}),
        schema: POSTMAN_SCHEMA,
      },
      item,
      // `baseUrl` como variable de la colección y no escrita en cada URL, que es lo que hace que
      // el mismo fichero sirva contra local y contra producción cambiando de entorno.
      variable: baseUrl ? [{ key: "baseUrl", value: baseUrl }] : [],
    },
    environments: options.environments
      ? (bundle.environments ?? []).map((environment, index) =>
          environmentFile(environment, ids.environmentIds[index] ?? `${ids.collectionId}-${index}`, skipped),
        )
      : [],
    skipped,
  };
}

/** Lo que baja «Export data» de Postman: todo junto, en un fichero. */
export function toPostmanDump(exported: PostmanExport): {
  collections: PostmanCollectionFile[];
  environments: PostmanEnvironmentFile[];
} {
  return { collections: [exported.collection], environments: exported.environments };
}

type BundleWorkflow = NonNullable<ProjectBundle["flows"]>["workflows"][number];
type BundleTemplate = NonNullable<ProjectBundle["flows"]>["requestTemplates"][number];
type BundleEndpoint = NonNullable<ProjectBundle["endpoints"]>[number];
type BundleEnvironment = NonNullable<ProjectBundle["environments"]>[number];

/**
 * Un flujo como carpeta.
 *
 * El orden es el del grafo y no el del documento, porque en Postman una carpeta **es** su orden: no
 * hay aristas que decir, así que lo único que queda del grafo es la secuencia. Un nodo `script`
 * vuelve al sitio del que salió — `from` puesto es el `test` de esa petición, `from` vacío es el
 * `prerequest` de la siguiente — que es exactamente lo que hizo el lector al revés.
 */
function folderFor(
  workflow: BundleWorkflow,
  templates: Map<string, BundleTemplate>,
  skipped: PostmanExport["skipped"],
): { name: string; description?: string; item: PostmanItem[] } {
  const definition = workflow.definition as unknown as WorkflowDocument;
  let steps: WorkflowStep[];
  try {
    steps = orderWorkflowSteps(definition, `el flujo «${workflow.name}»`);
  } catch {
    steps = definition.steps ?? [];
  }

  const items: PostmanItem[] = [];
  /** Qué `item` salió de cada nodo, para colgarle luego el `test` de un nodo script. */
  const itemOf = new Map<string, PostmanRequestItem>();
  /** Código que espera la siguiente petición: un `script` sin `from` es su `prerequest`. */
  let pendingPrerequest: string[] = [];

  const label = (step: WorkflowStep) => `flujo «${workflow.name}», nodo ${step.id}`;

  for (const step of steps) {
    const kind = step.kind ?? "request";
    if (kind === "request" || kind === "fetch") {
      const built =
        kind === "request" ? requestItem(step, templates, skipped, label(step)) : fetchItem(step, skipped, label(step));
      if (!built) continue;
      if (pendingPrerequest.length) {
        built.event = [...(built.event ?? []), event("prerequest", pendingPrerequest)];
        pendingPrerequest = [];
      }
      // Las comprobaciones y las capturas del propio nodo, que es de donde el lector las sacó.
      const lines = [...checkLines(step.checks ?? []), ...captureLines(step.captures ?? [])];
      if (lines.length) built.event = [...(built.event ?? []), event("test", lines)];
      itemOf.set(step.id, built);
      items.push(built);
      continue;
    }
    if (kind === "script" || kind === "validate") {
      const code = kind === "script" ? step.script?.code : step.validate?.script;
      const from = kind === "script" ? step.script?.from : step.validate?.from;
      const lines = [
        ...(code ? code.split("\n") : []),
        ...checkLines(step.checks ?? []),
        ...captureLines(step.captures ?? []),
      ];
      if (!lines.length) continue;
      const host = from ? itemOf.get(from) : undefined;
      if (host) attach(host, "test", lines);
      else pendingPrerequest = [...pendingPrerequest, ...lines];
      continue;
    }
    skipped.push({
      what: label(step),
      detail: `es un nodo «${kind}», y Postman no tiene nada equivalente: se queda fuera del fichero`,
    });
  }

  if (pendingPrerequest.length) {
    skipped.push({
      what: `flujo «${workflow.name}»`,
      detail: "termina en un script sin petición detrás, que en Postman no tiene dónde ir",
    });
  }

  return {
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    item: items,
  };
}

function attach(item: { event?: PostmanEvent[] }, listen: "prerequest" | "test", lines: string[]): void {
  const existing = (item.event ?? []).find((entry) => entry.listen === listen);
  if (existing) existing.script.exec = [...existing.script.exec, ...lines];
  else item.event = [...(item.event ?? []), event(listen, lines)];
}

const event = (listen: "prerequest" | "test", exec: string[]): PostmanEvent => ({
  listen,
  script: { type: "text/javascript", exec },
});

/** Un nodo de petición guardada. Su método y su ruta vienen del contrato, ya resueltos en el fichero. */
function requestItem(
  step: WorkflowStep,
  templates: Map<string, BundleTemplate>,
  skipped: PostmanExport["skipped"],
  label: string,
): PostmanRequestItem | null {
  const template = step.requestTemplateId ? templates.get(step.requestTemplateId) : undefined;
  if (!template) {
    skipped.push({ what: label, detail: "apunta a una petición que no está en el proyecto" });
    return null;
  }
  if (!template.method || !template.path) {
    skipped.push({
      what: label,
      detail: `la operación «${template.operationId}» no está en el contrato, así que no hay método ni ruta que escribir`,
    });
    return null;
  }
  // Los parámetros de ruta ya van dentro de la ruta; los de consulta salen como `query`, que es
  // donde Postman los deja editar.
  const path = Object.entries(template.parameters).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, value),
    template.path,
  );
  const query = Object.entries(template.parameters)
    .filter(([name]) => !template.path!.includes(`{${name}}`))
    .map(([key, value]) => ({ key, value }));
  const disabled = Object.entries(template.disabledParameters)
    .filter(([name]) => !template.path!.includes(`{${name}}`))
    .map(([key, value]) => ({ key, value, disabled: true }));

  return {
    name: template.name,
    request: {
      method: template.method.toUpperCase(),
      header: headerList(template.headers, template.disabledHeaders, skipped, label),
      url: urlOf(`{{baseUrl}}${path}`, [...query, ...disabled]),
      ...bodyOf(template.body as RequestBody | undefined),
      ...(template.description ? { description: template.description } : {}),
    },
  };
}

/** Un nodo `fetch`: la llamada ya está escrita en él, URL incluida. */
function fetchItem(step: WorkflowStep, skipped: PostmanExport["skipped"], label: string): PostmanRequestItem | null {
  const call = step.fetch;
  if (!call) return null;
  const [path, search] = call.url.split("?");
  const query = search
    ? search.split("&").map((pair) => {
        const at = pair.indexOf("=");
        return at < 0 ? { key: pair, value: "" } : { key: pair.slice(0, at), value: pair.slice(at + 1) };
      })
    : [];
  return {
    name: `${call.method} ${path}`,
    request: {
      method: call.method.toUpperCase(),
      header: headerList(call.headers ?? {}, call.disabledHeaders ?? {}, skipped, label),
      ...authOf(call.auth, label, skipped),
      url: urlOf(call.url, query),
      ...(call.body ? { body: raw(call.body, languageOf(call.headers ?? {})) } : {}),
    },
  };
}

/** Un endpoint del proyecto como petición. */
function endpointItem(endpoint: BundleEndpoint, baseUrl: string, skipped: PostmanExport["skipped"]): PostmanItem {
  const label = `endpoint ${endpoint.method} ${endpoint.path}`;
  const path = endpoint.pathParameters.reduce(
    (result, parameter) => (parameter.value ? result.replaceAll(`{${parameter.name}}`, parameter.value) : result),
    endpoint.path,
  );
  const headers: Record<string, string> = {};
  const disabledHeaders: Record<string, string> = {};
  for (const header of endpoint.headers) (header.enabled ? headers : disabledHeaders)[header.name] = header.value;

  return {
    name: `${endpoint.method} ${endpoint.path}`,
    request: {
      method: endpoint.method,
      header: headerList(headers, disabledHeaders, skipped, label),
      url: urlOf(
        `${baseUrl ? "{{baseUrl}}" : ""}${path}`,
        endpoint.query.map((parameter) => ({
          key: parameter.name,
          value: parameter.value,
          ...(parameter.enabled ? {} : { disabled: true }),
        })),
      ),
      ...endpointBody(endpoint),
      ...authOf(endpoint.auth, label, skipped),
      ...(endpoint.description ? { description: endpoint.description } : {}),
    },
    ...exampleResponses(endpoint.examples ?? []),
  };
}

/**
 * Los ejemplos guardados, escritos como el array `response` de un `item`.
 *
 * Es el inverso exacto del lector, y por eso da la vuelta: exportar un proyecto con ejemplos,
 * volver a importar el fichero, y encontrarse los mismos.
 *
 * `originalRequest` sale entero. Sin él, Postman enseña la respuesta colgando de la petición
 * *actual*, y un ejemplo de 422 —que se guardó con un cuerpo inválido a propósito— quedaría junto a
 * un cuerpo válido, contando lo contrario de lo que pasó.
 *
 * Nada que redactar aquí: lo que está guardado ya pasó por la redacción al entrar. Es la ventaja de
 * limpiar en la puerta y no en la salida — hay una sola puerta y no tres.
 */
function exampleResponses(examples: NonNullable<BundleEndpoint["examples"]>): { response?: PostmanResponse[] } {
  if (!examples.length) return {};
  return {
    response: examples.map((example) => ({
      name: example.name,
      originalRequest: {
        method: example.request.method,
        header: example.request.headers
          .filter((header) => header.enabled)
          .map((header) => ({ key: header.name, value: header.value })),
        url: { raw: example.request.url },
        ...(example.request.body.text
          ? {
              body: {
                mode: "raw" as const,
                raw: example.request.body.text,
                options: { raw: { language: previewLanguage(example.request.body.contentType) } },
              },
            }
          : {}),
      },
      status: STATUS_TEXT[example.response.status] ?? "",
      code: example.response.status,
      _postman_previewlanguage: previewLanguage(example.response.contentType),
      header: example.response.headers
        .filter((header) => header.enabled)
        .map((header) => ({ key: header.name, value: header.value })),
      cookie: [],
      body: example.response.body,
    })),
  };
}

/** Cómo Postman pinta un cuerpo. Lo deduce del `Content-Type`, que es lo único que hay. */
function previewLanguage(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("xml")) return "xml";
  if (type.includes("html")) return "html";
  if (type.includes("javascript")) return "javascript";
  return "text";
}

/**
 * El texto del estado, para los códigos que aparecen.
 *
 * Una tabla y no una biblioteca: son los que una API contesta, y un código que no esté sale con el
 * texto vacío, que Postman acepta. Inventar «Unknown» sería escribir en el fichero algo que el
 * servidor no dijo.
 */
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * El bloque `auth` de vuelta al fichero, sin el secreto.
 *
 * Un `Basic` sale con su usuario y con la contraseña vacía; quien abra el fichero ve qué falta y
 * dónde ponerlo, que es más de lo que le dice una petición sin bloque. Un valor que es solo
 * `{{variables}}` sale entero: no es el secreto, es el nombre de dónde está.
 *
 * `inherit` no escribe nada, que es exactamente lo que significa en un fichero de Postman: hereda
 * lo de la carpeta o lo de la colección.
 */
function authOf(
  auth: BundleEndpoint["auth"] | undefined,
  label: string,
  skipped: PostmanExport["skipped"],
): { auth?: Record<string, unknown> } {
  if (!auth) return {};
  const written = writePostmanAuth(auth);
  if (!written.block) return {};
  for (const param of written.redacted) {
    skipped.push({ what: label, detail: `la credencial «${param}» de su autenticación sale sin valor` });
  }
  return { auth: written.block };
}

function endpointBody(endpoint: BundleEndpoint): { body?: PostmanRequest["body"] } {
  const body = endpoint.body;
  if (!body || body.mode === "none" || !body.text.trim()) return {};
  return { body: raw(body.text, languageFor(body.contentType)) };
}

/**
 * Las cabeceras, con las credenciales fuera salvo que sean variables.
 *
 * La misma regla que el import aplica al entrar, y por el mismo motivo: `Authorization: Bearer
 * ey…` dentro de un fichero que se manda por correo es ese token en el correo de todo el mundo.
 * `Authorization: Bearer {{access_token}}` no dice nada, así que sale tal cual.
 */
function headerList(
  headers: Record<string, string>,
  disabled: Record<string, string>,
  skipped: PostmanExport["skipped"],
  label: string,
): KeyValue[] {
  const list: KeyValue[] = [];
  const add = (key: string, value: string, off: boolean) => {
    if (CREDENTIAL_HEADER.test(key) && !ONLY_VARIABLES.test(value)) {
      skipped.push({ what: label, detail: `la cabecera «${key}» lleva un valor escrito a mano y sale vacía` });
      list.push({ key, value: "", disabled: true });
      return;
    }
    list.push({ key, value, ...(off ? { disabled: true } : {}) });
  };
  for (const [key, value] of Object.entries(headers)) add(key, value, false);
  for (const [key, value] of Object.entries(disabled)) add(key, value, true);
  return list;
}

const urlOf = (raw: string, query: KeyValue[]): PostmanRequest["url"] => ({
  // `raw` primero porque es lo que el lector —el de aquí y el de Postman— trata como la verdad:
  // un `{{baseUrl}}` sobrevive entero en la cadena y se desparrama si se parte en `host`.
  raw,
  ...(query.length ? { query } : {}),
});

const raw = (text: string, language: string): PostmanRequest["body"] => ({
  mode: "raw",
  raw: text,
  options: { raw: { language } },
});

function bodyOf(body: RequestBody | undefined): { body?: PostmanRequest["body"] } {
  if (!body || body.type === "none") return {};
  if (body.type === "json") return { body: raw(JSON.stringify(body.json, null, 2), "json") };
  if (body.type === "raw") return { body: raw(body.text, languageFor(body.contentType)) };
  // Un cuerpo de formulario sale como texto codificado: Postman tiene `urlencoded` y `formdata`,
  // pero el lector de aquí devuelve los campos ya como mapas y reconstruir el modo exacto sería
  // adivinar cuál de los dos era.
  const pairs = Object.entries(body.fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return { body: raw(pairs, "text") };
}

const languageOf = (headers: Record<string, string>): string =>
  languageFor(Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "");

function languageFor(contentType: string): string {
  if (/json/i.test(contentType)) return "json";
  if (/xml/i.test(contentType)) return "xml";
  if (/html/i.test(contentType)) return "html";
  return "text";
}

/**
 * Una comprobación como `pm.test`, que es de donde el lector la sacó.
 *
 * `status` usa `pm.response.to.have.status`, que es la forma que escribe un humano y la que el
 * lector reconoce primero. El resto sale como `pm.expect`, con el mismo `chai` que trae Postman.
 */
export function checkLines(checks: ResponseCheck[]): string[] {
  return checks.flatMap((check) => {
    const title = JSON.stringify(check.label || describe(check));
    const body = assertionOf(check);
    return body ? [`pm.test(${title}, function () {`, `  ${body};`, "});"] : [];
  });
}

function assertionOf(check: ResponseCheck): string | null {
  const value = () => JSON.stringify(check.value ?? null);
  if (check.source === "status") {
    if (check.operator === "equals") return `pm.response.to.have.status(${Number(check.value) || 0})`;
    return `pm.expect(pm.response.code)${chai(check)}`;
  }
  const actual =
    check.source === "durationMs"
      ? "pm.response.responseTime"
      : check.source === "header"
        ? `pm.response.headers.get(${JSON.stringify(check.path ?? "")})`
        : `pm.response.json()${accessor(check.path ?? "")}`;
  const tail = chai(check);
  return tail ? `pm.expect(${actual})${tail}` : `pm.expect(${actual}).to.eql(${value()})`;
}

/** El encadenado de `chai` que dice cada operador. */
function chai(check: ResponseCheck): string {
  const value = JSON.stringify(check.value ?? null);
  switch (check.operator) {
    case "equals":
      return `.to.eql(${value})`;
    case "not_equals":
      return `.to.not.eql(${value})`;
    case "contains":
      return `.to.include(${value})`;
    case "not_contains":
      return `.to.not.include(${value})`;
    case "greater_than":
      return `.to.be.above(${Number(check.value) || 0})`;
    case "less_than":
      return `.to.be.below(${Number(check.value) || 0})`;
    case "exists":
      return ".to.exist";
    case "not_exists":
      return ".to.not.exist";
    case "matches":
      return `.to.match(new RegExp(${JSON.stringify(String(check.value ?? ""))}))`;
    case "is_array":
      return '.to.be.an("array")';
    case "is_not_empty":
      return ".to.not.be.empty";
    case "has_length":
      return `.to.have.lengthOf(${Number(check.value) || 0})`;
  }
}

/** Un nombre para una comprobación que no lo trae, porque `pm.test` exige uno. */
function describe(check: ResponseCheck): string {
  const subject =
    check.source === "status"
      ? "el estado"
      : check.source === "durationMs"
        ? "la duración"
        : check.source === "header"
          ? `la cabecera ${check.path ?? ""}`
          : (check.path ?? "el cuerpo");
  return `${subject} ${check.operator.replaceAll("_", " ")}${check.value === undefined ? "" : ` ${String(check.value)}`}`.trim();
}

/**
 * Una captura como `pm.collectionVariables.set`.
 *
 * `collectionVariables` y no `environment`, y es la misma decisión que el import: `pm.environment.set`
 * escribe en el entorno guardado y sobrevive a la corrida, que no es lo que hace una captura aquí.
 */
export function captureLines(captures: WorkflowCapture[]): string[] {
  return captures.flatMap((capture) => {
    const name = JSON.stringify(capture.variable);
    if (capture.from === "body") {
      return [`pm.collectionVariables.set(${name}, pm.response.json()${accessor(capture.path)});`];
    }
    if (capture.from === "header") {
      return [`pm.collectionVariables.set(${name}, pm.response.headers.get(${JSON.stringify(capture.path)}));`];
    }
    if (capture.from === "cookie") {
      return [`pm.collectionVariables.set(${name}, pm.cookies.get(${JSON.stringify(capture.path)}));`];
    }
    return [
      `pm.collectionVariables.set(${name}, (pm.response.text().match(new RegExp(${JSON.stringify(capture.path)})) || [])[1]);`,
    ];
  });
}

/** Un camino con puntos como acceso de JavaScript, con corchetes donde el nombre no es un identificador. */
function accessor(path: string): string {
  if (!path) return "";
  return path
    .split(".")
    .filter(Boolean)
    .map((part) => (/^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`))
    .join("");
}

/** Un entorno, con los secretos vacíos y marcados como tales. */
function environmentFile(
  environment: BundleEnvironment,
  id: string,
  skipped: PostmanExport["skipped"],
): PostmanEnvironmentFile {
  const values: PostmanEnvironmentFile["values"] = [];
  const add = (key: string, variable: { initial: string; sensitive: boolean }, enabled: boolean) => {
    if (variable.sensitive) {
      skipped.push({
        what: `entorno «${environment.name}»`,
        detail: `la variable «${key}» es sensible: sale con el nombre y sin valor`,
      });
      values.push({ key, value: "", type: "secret", enabled });
      return;
    }
    values.push({ key, value: variable.initial, type: "default", enabled });
  };
  for (const [key, variable] of Object.entries(environment.variables)) add(key, variable, true);
  for (const [key, variable] of Object.entries(environment.disabledVariables)) add(key, variable, false);
  // `baseUrl` va también como variable, que es lo que las URL de la colección nombran.
  if (environment.baseUrl && !values.some((value) => value.key === "baseUrl")) {
    values.unshift({ key: "baseUrl", value: environment.baseUrl, type: "default", enabled: true });
  }
  return { id, name: environment.name, values, _postman_variable_scope: "environment" };
}
