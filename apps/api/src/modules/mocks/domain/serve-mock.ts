/**
 * Qué contesta el mock a una petición: encontrar la ruta, elegir el ejemplo, y limpiar la respuesta.
 *
 * Todo esto es una función pura de (endpoints, ejemplos, petición) a una respuesta o a un problema.
 * Se puede probar entera sin levantar nada, y es donde vive todo lo que puede estar mal.
 *
 * ## Dos maneras de fallar, y las dos se dicen
 *
 * Un mock que contesta 404 sin explicación es indistinguible de un mock roto, y quien lo usa se
 * queda mirando la consola del navegador sin saber si escribió mal la ruta, si falta el ejemplo, o
 * si el mock está apagado. Así que cada «no» trae su motivo y el código de estado que le toca:
 *
 * - **La ruta no existe** — 404, con la ruta que sí se parece, cuando hay alguna. «Pediste
 *   `/user/42`, el mock sirve `/users/{id}`» es lo único que hace falta saber el 90% de las veces.
 * - **La ruta existe con otro método** — 405 con la cabecera `Allow`, que es lo que dice HTTP y lo
 *   que además resuelve el caso: se olvidó el `method: "POST"` en el `fetch`.
 * - **La ruta existe y no tiene ejemplos** — 501. El endpoint está declarado y nadie ha guardado
 *   nunca lo que contesta, así que el mock no tiene con qué contestar. Es un 501 literal: la
 *   funcionalidad no está implementada aquí, y se arregla guardando un ejemplo.
 *
 * ## Elegir entre varios ejemplos
 *
 * Por orden, y el primero que decide gana:
 *
 * 1. **Lo que pide quien llama**, por nombre o por estado. Es lo que permite probar el camino de
 *    error sin tocar el mock: el mismo `fetch` con `x-eq-mock-status: 409` y ya.
 * 2. **El que encaja con la petición** — la cadena de consulta y, si es JSON, el cuerpo. Es lo que
 *    distingue `?page=1` de `?page=2` y un login bueno de uno malo. Un parámetro del que el ejemplo
 *    no dice nada no cuenta ni a favor ni en contra; uno que dice otra cosa cuenta **en contra**,
 *    porque es evidencia de que ese no es el ejemplo.
 * 3. **El 2xx más bajo.** Y no «el primero», que es lo que hace Postman: si el primer ejemplo que
 *    alguien guardó fue un 500 —y lo normal es guardar primero lo que sorprende— entonces el mock
 *    contesta 500 a todo y no sirve para montar nada.
 */
import { isDeepStrictEqual } from "node:util";

import type { Endpoint, EndpointHeader } from "@/modules/endpoints/domain/model";
import type { EndpointExample } from "@/modules/endpoints/domain/examples";

/** Las cabeceras con las que se pide un ejemplo concreto. Las de Postman valen igual: una colección
 * suya trae pruebas que ya las mandan, y rechazarlas obligaría a reescribirlas para nada. */
export const EXAMPLE_HEADERS = ["x-eq-mock-example", "x-mock-response-name", "x-mock-response-id"] as const;
export const STATUS_HEADERS = ["x-eq-mock-status", "x-mock-response-code"] as const;

/**
 * Las cabeceras de la respuesta guardada que **no** se reenvían.
 *
 * No es higiene, es corrección. El cuerpo se guardó ya descomprimido, así que un
 * `content-encoding: gzip` heredado hace que todos los clientes fallen al descomprimir texto plano.
 * `content-length` lo recalcula el servidor y uno viejo desincroniza la respuesta. Las de salto
 * (`connection`, `transfer-encoding`) son de la conexión de entonces y no de esta. `date` guardada
 * sería una fecha falsa. `strict-transport-security` es la política del dominio ajeno sobre sí mismo
 * y repetirla desde aquí impone algo que nadie pidió. Y `access-control-allow-*` la pone el mock:
 * heredar la del original la contradiría justo cuando el navegador la lee.
 */
const DROPPED_RESPONSE_HEADER =
  /^(content-length|content-encoding|transfer-encoding|connection|keep-alive|upgrade|te|trailer|proxy-authenticate|proxy-authorization|set-cookie|date|strict-transport-security|access-control-allow-[a-z-]+|access-control-expose-headers)$/i;

export type MockRequest = {
  method: string;
  /** Ya sin el prefijo del mock, empezando por `/`. */
  path: string;
  query: [string, string][];
  /** En minúsculas, que es como se comparan las cabeceras HTTP. */
  headers: Record<string, string>;
  /** El JSON que trajo, cuando trajo JSON. Cualquier otro cuerpo no se mira. */
  body?: unknown;
};

export type MockHit = {
  kind: "hit";
  status: number;
  headers: EndpointHeader[];
  body: string;
  trace: {
    endpointId: string;
    endpointRoute: string;
    exampleId: string;
    exampleName: string;
    /**
     * Por qué este ejemplo y no otro. Sale en una cabecera, así que es un **código y no una frase**:
     * el valor de una cabecera HTTP no lleva UTF-8 —«el 2xx más bajo» sale con la tilde partida— y
     * además un código se puede buscar en un registro y comparar en una prueba.
     */
    reason: MockReason;
  };
};

export type MockProblem = {
  kind: "problem";
  status: number;
  code: string;
  title: string;
  detail: string;
  /** Para el 405, que sin `Allow` no es un 405. */
  allow?: string[];
};

export type MockOutcome = MockHit | MockProblem;

/** Los cuatro motivos por los que un ejemplo sale elegido, en el orden en que se deciden. */
export const MOCK_REASONS = ["by-name", "by-status", "request-match", "lowest-2xx"] as const;
export type MockReason = (typeof MOCK_REASONS)[number];

/* ------------------------------------------------------------------ *
 * La ruta
 * ------------------------------------------------------------------ */

/** `//a/b/` y `/a/b` son la misma ruta. La raíz se queda en `/`. */
export function normalizeMockPath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : "/";
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `{{variable}}` primero, para que no se lea como un `{` suelto con llaves dentro. */
const PLACEHOLDER = /\{\{[^{}]+\}\}|\{[^{}]+\}/g;

export type RouteTemplate = {
  re: RegExp;
  names: string[];
  /** Un dígito por segmento: `1` literal, `0` con hueco. Compara la especificidad de dos rutas. */
  shape: string;
};

/**
 * La ruta del endpoint como expresión regular.
 *
 * Un hueco vale por un segmento y no por varios: `/users/{id}` no contesta a `/users/42/pedidos`,
 * que es otro endpoint. Y el hueco puede ser parte de un segmento —`/files/{id}.json`— porque así
 * lo escriben los contratos de verdad.
 */
export function routeTemplate(path: string): RouteTemplate {
  const normalized = normalizeMockPath(path);
  const names: string[] = [];
  let source = "";
  let last = 0;
  for (const match of normalized.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    source += escapeRegExp(normalized.slice(last, at));
    if (match[0].startsWith("{{")) {
      // Una variable de entorno dentro de la ruta: aquí no se sabe su valor, así que encaja con
      // cualquier segmento. Exigirla literal haría que ese endpoint no contestara nunca.
      source += "[^/]+";
    } else {
      names.push(match[0].slice(1, -1));
      source += "([^/]+)";
    }
    last = at + match[0].length;
  }
  source += escapeRegExp(normalized.slice(last));
  const shape = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.includes("{") ? "0" : "1"))
    .join("");
  return { re: new RegExp(`^${source}$`), names, shape };
}

export const mockRoute = (endpoint: Pick<Endpoint, "method" | "path">): string =>
  `${endpoint.method.toUpperCase()} ${normalizeMockPath(endpoint.path)}`;

/** Cuántos segmentos comparten dos rutas por la izquierda. Solo para sugerir la que se parece. */
function sharedPrefix(left: string, right: string): number {
  const a = left.split("/").filter(Boolean);
  const b = right.split("/").filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/** Cuántos caracteres comparten dos rutas por la izquierda. Coge el `/users` de `/user`. */
function sharedStart(left: string, right: string): number {
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return shared;
}

/**
 * Cuánto hay que compartir para que decirlo ayude. La barra inicial no cuenta.
 *
 * Tener el mismo número de segmentos **no** es parecerse: con eso solo, `/usuarios` sugeriría
 * `/pedidos`, y «pediste `/usuarios`, ¿querías `/pedidos`?» es peor que callarse. Lo que sí es
 * parecerse es compartir un segmento entero, o empezar igual — que es el error de verdad, la `s` que
 * falta en `/user/42`.
 */
const NEAR_ENOUGH = 4;

/**
 * La ruta que se parece a la que se pidió, para decirlo en el 404.
 *
 * «Pediste `/user/42`, el mock sirve `GET /users/{id}`» es lo único que hace falta saber la mayoría
 * de las veces, y es casi todo lo que un 404 a secas no dice.
 */
export function nearestRoutes(endpoints: Endpoint[], path: string, limit = 3): string[] {
  const wanted = normalizeMockPath(path);
  const segments = wanted.split("/").filter(Boolean).length;
  return endpoints
    .map((endpoint) => {
      const route = normalizeMockPath(endpoint.path);
      const shared = sharedPrefix(wanted, route);
      const start = sharedStart(wanted, route);
      const sameLength = route.split("/").filter(Boolean).length === segments ? 1 : 0;
      return {
        endpoint,
        route,
        near: shared > 0 || start >= NEAR_ENOUGH,
        // Compartir segmentos enteros pesa más que empezar parecido, y el mismo número de segmentos
        // solo desempata: por sí solo no es un parecido.
        score: shared * 100 + start * 2 + sameLength,
      };
    })
    .filter((row) => row.near)
    .sort((left, right) => right.score - left.score || left.route.localeCompare(right.route))
    .slice(0, limit)
    .map((row) => mockRoute(row.endpoint));
}

export type RouteMatch =
  { kind: "route"; endpoint: Endpoint } | { kind: "no-route" } | { kind: "wrong-method"; allow: string[] };

export function matchRoute(endpoints: Endpoint[], request: MockRequest): RouteMatch {
  const path = normalizeMockPath(request.path);
  const onPath = endpoints
    .map((endpoint) => ({ endpoint, template: routeTemplate(endpoint.path) }))
    .filter((row) => row.template.re.test(path));
  if (!onPath.length) return { kind: "no-route" };

  const wanted = request.method.toUpperCase();
  // `HEAD` lo contesta el ejemplo del `GET`, sin cuerpo. Es lo que exige HTTP: quien pregunta por
  // las cabeceras de un recurso no está pidiendo otro recurso, y un 405 ahí sería un fallo nuestro.
  const accepts = wanted === "HEAD" ? ["HEAD", "GET"] : [wanted];
  const onMethod = onPath.filter((row) => accepts.includes(row.endpoint.method.toUpperCase()));
  if (!onMethod.length) {
    const allow = [...new Set(onPath.map((row) => row.endpoint.method.toUpperCase()))].sort();
    // Un `GET` declarado implica que `HEAD` se puede pedir, y el `Allow` tiene que decirlo.
    if (allow.includes("GET") && !allow.includes("HEAD")) allow.push("HEAD");
    return { kind: "wrong-method", allow: allow.sort() };
  }

  // Lo literal gana a lo que tiene hueco, segmento a segmento y de izquierda a derecha: `/users/me`
  // contesta a `/users/me` aunque `/users/{id}` también encaje. A igualdad, el método exacto antes
  // que el `GET` que atiende un `HEAD`, y al final el orden del proyecto, para que sea determinista.
  const best = onMethod.sort((left, right) => {
    if (left.template.shape !== right.template.shape) return left.template.shape > right.template.shape ? -1 : 1;
    const exact = (row: (typeof onMethod)[number]) => (row.endpoint.method.toUpperCase() === wanted ? 0 : 1);
    return exact(left) - exact(right) || left.endpoint.orderIndex - right.endpoint.orderIndex;
  })[0];
  return { kind: "route", endpoint: best.endpoint };
}

/* ------------------------------------------------------------------ *
 * El ejemplo
 * ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** La cadena de consulta de una URL guardada, que puede ser relativa o traer `{{variables}}`. */
export function queryOf(url: string): Map<string, string[]> {
  const at = url.indexOf("?");
  const pairs = new Map<string, string[]>();
  if (at < 0) return pairs;
  for (const [name, value] of new URLSearchParams(url.slice(at + 1))) {
    pairs.set(name, [...(pairs.get(name) ?? []), value]);
  }
  return pairs;
}

/**
 * Cuánto se parece la petición que entra a la que produjo el ejemplo.
 *
 * Solo cuenta lo que el ejemplo **afirma**. Un parámetro del que no dice nada no es evidencia en
 * ningún sentido; uno que dice otra cosa resta, porque es evidencia de que el ejemplo es otro. Si no
 * se restara, un ejemplo con veinte campos ganaría siempre por tener más con los que coincidir.
 */
export function requestScore(example: EndpointExample, request: MockRequest): number {
  let score = 0;
  const stored = queryOf(example.request.url);
  for (const [name, value] of request.query) {
    const values = stored.get(name);
    if (!values) continue;
    score += values.includes(value) ? 1 : -1;
  }
  if (isPlainObject(request.body)) {
    const body = parseJson(example.request.body.text);
    if (isPlainObject(body)) {
      for (const [key, value] of Object.entries(request.body)) {
        if (!(key in body)) continue;
        score += isDeepStrictEqual(body[key], value) ? 1 : -1;
      }
    }
  }
  return score;
}

/** El 2xx más bajo, y si no hay ninguno el estado más bajo. A igualdad, el orden de la lista. */
function defaultExample(examples: EndpointExample[]): EndpointExample {
  const rank = (example: EndpointExample) => (example.response.status < 300 && example.response.status >= 200 ? 0 : 1);
  return [...examples].sort(
    (left, right) =>
      rank(left) - rank(right) || left.response.status - right.response.status || left.orderIndex - right.orderIndex,
  )[0];
}

export type Choice = { kind: "example"; example: EndpointExample; reason: MockReason } | MockProblem;

export function chooseExample(examples: EndpointExample[], request: MockRequest): Choice {
  if (!examples.length) {
    return {
      kind: "problem",
      status: 501,
      code: "mock-no-example",
      title: "Este endpoint no tiene ejemplos",
      detail:
        "La ruta está declarada en el proyecto pero nadie ha guardado nunca lo que contesta, así que el mock no tiene con qué contestar. Envía la petición una vez y guarda la respuesta.",
    };
  }

  const header = (names: readonly string[]) => {
    for (const name of names) {
      const value = request.headers[name]?.trim();
      if (value) return value;
    }
    return "";
  };

  const wantedName = header(EXAMPLE_HEADERS);
  if (wantedName) {
    const example = examples.find((row) => row.name === wantedName || row.id === wantedName);
    if (example) return { kind: "example", example, reason: "by-name" };
    // Servir otro sería lo peor que puede hacer: la prueba que pidió el ejemplo de error pasaría
    // en verde contra el ejemplo de éxito, y nadie se enteraría.
    return {
      kind: "problem",
      status: 400,
      code: "mock-example-unknown",
      title: "Ese ejemplo no existe",
      detail: `No hay ningún ejemplo llamado «${wantedName}» en este endpoint. Tiene: ${examples
        .map((row) => `«${row.name}»`)
        .join(", ")}.`,
    };
  }

  const wantedStatus = header(STATUS_HEADERS);
  if (wantedStatus) {
    const status = Number(wantedStatus);
    const matching = examples.filter((row) => row.response.status === status);
    if (matching.length) return { kind: "example", example: matching[0], reason: "by-status" };
    return {
      kind: "problem",
      status: 400,
      code: "mock-status-unknown",
      title: "Ese estado no tiene ejemplo",
      detail: `Este endpoint no tiene ningún ejemplo con estado ${wantedStatus}. Tiene: ${[
        ...new Set(examples.map((row) => row.response.status)),
      ]
        .sort()
        .join(", ")}.`,
    };
  }

  const scored = examples.map((example) => ({ example, score: requestScore(example, request) }));
  const best = Math.max(...scored.map((row) => row.score));
  if (best > 0) {
    const winners = scored.filter((row) => row.score === best).map((row) => row.example);
    // Varios empatados en lo que encaja: entonces decide lo de siempre, no el azar.
    return { kind: "example", example: defaultExample(winners), reason: "request-match" };
  }

  return { kind: "example", example: defaultExample(examples), reason: "lowest-2xx" };
}

/* ------------------------------------------------------------------ *
 * La respuesta
 * ------------------------------------------------------------------ */

/** Un nombre de cabecera válido según HTTP: un `token`, sin espacios ni separadores. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// eslint-disable-next-line no-control-regex -- los caracteres de control son justo lo que se quita
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Las cabeceras que salen: las del ejemplo menos las que serían falsas o rompen al cliente.
 *
 * Y saneadas, porque el valor no lo escribió nadie: lo contestó otro servidor o lo trajo un HAR. Un
 * salto de línea dentro partiría la respuesta en dos, y eso es una inyección de cabeceras. La
 * validación del ejemplo ya no deja entrar uno, así que esto es la segunda puerta — y la única que
 * cubre lo que entró por el importador, que construye ejemplos sin pasar por ella.
 */
export function responseHeaders(example: EndpointExample): EndpointHeader[] {
  const kept = example.response.headers
    .filter((header) => header.enabled !== false && !DROPPED_RESPONSE_HEADER.test(header.name.trim()))
    .filter((header) => HEADER_NAME.test(header.name.trim()))
    .map((header) => ({ ...header, value: header.value.replace(CONTROL_CHARS, "") }));
  const hasType = kept.some((header) => header.name.trim().toLowerCase() === "content-type");
  // Sin `Content-Type` el navegador adivina, y adivina mal: un JSON sin tipo se pinta como texto.
  if (!hasType && example.response.contentType)
    kept.push({ name: "Content-Type", value: example.response.contentType, enabled: true });
  return kept;
}

/**
 * Lo que el mock contesta a una petición.
 *
 * `endpoints` ya viene filtrado a los vivos del proyecto, y `examplesOf` los da por endpoint: así
 * esta función no sabe nada de la base de datos y se puede probar con dos arrays.
 */
export function serveMock(
  endpoints: Endpoint[],
  examplesOf: (endpointId: string) => EndpointExample[],
  request: MockRequest,
): MockOutcome {
  const match = matchRoute(endpoints, request);
  if (match.kind === "wrong-method") {
    return {
      kind: "problem",
      status: 405,
      code: "mock-wrong-method",
      title: "Ese método no, en esa ruta",
      detail: `El mock sirve ${normalizeMockPath(request.path)} con ${match.allow.join(", ")}, y no con ${request.method.toUpperCase()}.`,
      allow: match.allow,
    };
  }
  if (match.kind === "no-route") {
    const near = nearestRoutes(endpoints, request.path);
    return {
      kind: "problem",
      status: 404,
      code: "mock-no-route",
      title: "Esa ruta no la sirve este mock",
      detail: near.length
        ? `${request.method.toUpperCase()} ${normalizeMockPath(request.path)} no está. Se parece a: ${near.join(", ")}.`
        : `${request.method.toUpperCase()} ${normalizeMockPath(request.path)} no está, y ninguna de las ${endpoints.length} rutas del mock se le parece.`,
    };
  }

  const choice = chooseExample(examplesOf(match.endpoint.id), request);
  if (choice.kind === "problem") return choice;

  return {
    kind: "hit",
    status: choice.example.response.status,
    headers: responseHeaders(choice.example),
    // `HEAD` no lleva cuerpo, y las cabeceras son las mismas. Mandarlo sería ilegal y algunos
    // clientes lo leen como el cuerpo de la petición siguiente.
    body: request.method.toUpperCase() === "HEAD" ? "" : choice.example.response.body,
    trace: {
      endpointId: match.endpoint.id,
      endpointRoute: mockRoute(match.endpoint),
      exampleId: choice.example.id,
      exampleName: choice.example.name,
      reason: choice.reason,
    },
  };
}
