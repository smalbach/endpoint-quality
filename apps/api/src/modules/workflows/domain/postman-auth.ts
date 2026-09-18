/**
 * El bloque `auth` de un fichero de Postman, leído y escrito.
 *
 * Hasta ahora se tiraba entero y sin decirlo. Una colección real casi siempre lleva su
 * autenticación **en la colección**, no en cada petición: se pone una vez arriba y las peticiones
 * la heredan. Perder ese bloque no perdía un detalle, perdía la única cosa sin la cual ninguna de
 * las peticiones importadas responde otra cosa que 401.
 *
 * Leer y escribir viven juntos a propósito: son inversos, y cuando se separan uno aprende un tipo
 * nuevo y el otro no, que es exactamente cómo una exportación deja de poder reimportarse.
 *
 * La **herencia** se resuelve aquí, no después: en Postman la petición manda sobre la carpeta y la
 * carpeta sobre la colección, y un bloque ausente significa «hereda» mientras que `noauth`
 * significa «esta no, aunque las de arriba sí». Son dos cosas distintas y guardarlas igual borra la
 * decisión de quien escribió el fichero.
 */
import {
  AUTH_TYPES,
  NO_AUTH,
  isAuthType,
  type AuthType,
  type RequestAuth,
  type WorkflowDocument,
} from "@eq/runner-core";

/** Los nombres de Postman que no son los nuestros. El resto coincide y no hace falta traducir. */
const FROM_POSTMAN: Record<string, AuthType> = { noauth: "none" };
const TO_POSTMAN: Partial<Record<AuthType, string>> = { none: "noauth" };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

/** Lo leído: la autenticación, o el nombre de un tipo que este lector no conoce. */
export type ReadAuth = RequestAuth | { unsupported: string };

export const isReadable = (read: ReadAuth): read is RequestAuth => !("unsupported" in read);

/**
 * El bloque tal cual está en el fichero, o `null` si no hay ninguno —que significa «hereda».
 *
 * Postman guarda los parámetros de dos formas según la versión que los escribió: una lista de
 * `{key, value}` en v2.1, y un objeto plano en ficheros más viejos o editados a mano. Se aceptan
 * las dos porque las dos existen en los ficheros que la gente tiene guardados.
 */
export function readPostmanAuth(value: unknown): ReadAuth | null {
  const block = asRecord(value);
  if (!block) return null;
  const raw = asString(block.type).toLowerCase();
  if (!raw) return null;
  const type = FROM_POSTMAN[raw] ?? (isAuthType(raw) && raw !== "inherit" ? raw : null);
  // Un tipo que no conocemos se nombra. Lo contrario es lo que hacía este lector hasta ahora:
  // seguir como si la petición no tuviera autenticación y dejar que el 401 lo explique.
  if (!type) return { unsupported: raw };
  if (type === "none") return NO_AUTH;

  const params: Record<string, string> = {};
  const holder = block[raw];
  if (Array.isArray(holder)) {
    for (const entry of holder) {
      const pair = asRecord(entry);
      if (!pair) continue;
      const key = asString(pair.key);
      if (key) params[key] = asString(pair.value);
    }
  } else {
    const object = asRecord(holder);
    if (object) for (const [key, item] of Object.entries(object)) params[key] = asString(item);
  }
  return { type, params };
}

/** Lo que el fichero declara arriba, para que las peticiones de dentro lo hereden. */
export type AuthTrail = { collection: RequestAuth | null; folders: (RequestAuth | null)[] };

/**
 * Cuál de los tres bloques gana.
 *
 * La carpeta más interna manda sobre las de fuera, y cualquiera de ellas sobre la colección. Una
 * petición sin bloque hereda; con `noauth` no hereda nada, y eso es una decisión que se respeta.
 */
export function resolveAuth(own: RequestAuth | null, trail: AuthTrail): RequestAuth {
  if (own) return own;
  for (let index = trail.folders.length - 1; index >= 0; index -= 1) {
    const folder = trail.folders[index];
    if (folder) return folder;
  }
  return trail.collection ?? { type: "inherit", params: {} };
}

/**
 * De vuelta al fichero.
 *
 * **Ningún secreto sale como valor.** Un `password`, un `secretKey` o un `clientSecret` salen con
 * su nombre y vacíos, y quien reciba el fichero ve qué credencial falta en vez de recibir la
 * nuestra. Lo que sí sale entero es un valor que es solo `{{variables}}`: eso no es un secreto,
 * es el nombre de dónde está el secreto, y quitarlo rompería el fichero sin proteger nada.
 */
export const SECRET_PARAMS = new Set([
  "password",
  "secret",
  "secretKey",
  "clientSecret",
  "consumerSecret",
  "tokenSecret",
  "authKey",
  "token",
  "accessToken",
  "apiKey",
  "value",
  "privateKey",
]);

const ONLY_VARIABLES = /^(?:\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}\s*)+$/;

/**
 * Los parámetros que se guardan de verdad.
 *
 * Un campo de texto que alguien dejó en blanco no se guarda: no es nada, y guardarlo hace que el
 * fichero exportado anuncie un parámetro que nadie escribió. Un **secreto** vacío sí se queda: ese
 * vacío es la marca de que la credencial existe y no está aquí, y es lo que hace que quien abra el
 * fichero vea qué le falta en vez de una petición que parece no necesitar nada.
 */
export function storableParams(auth: RequestAuth): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.params ?? {})) {
    if (value !== "" || isSecretParam(auth.type, key)) params[key] = value;
  }
  return params;
}

export const isSecretParam = (type: RequestAuth["type"], key: string): boolean =>
  SECRET_PARAMS.has(key) && (key !== "value" || type === "apikey");

export type WrittenAuth = { block: Record<string, unknown> | null; redacted: string[] };

export function writePostmanAuth(auth: RequestAuth): WrittenAuth {
  if (auth.type === "inherit") return { block: null, redacted: [] };
  const name = TO_POSTMAN[auth.type] ?? auth.type;
  if (auth.type === "none") return { block: { type: name }, redacted: [] };

  const redacted: string[] = [];
  const entries = Object.entries(auth.params).map(([key, value]) => {
    const secret = isSecretParam(auth.type, key);
    if (secret && value && !ONLY_VARIABLES.test(value.trim())) {
      redacted.push(key);
      return { key, value: "", type: "string" };
    }
    return { key, value, type: "string" };
  });
  return { block: { type: name, [name]: entries }, redacted };
}

/**
 * La autenticación sin los secretos literales, que es la única forma en la que puede guardarse.
 *
 * Los parámetros van a una columna `jsonb`, y una contraseña ahí es una contraseña en claro en la
 * base de datos — exactamente lo que la tabla de credenciales y las variables sensibles existen
 * para evitar. Un valor que es solo `{{variables}}` sí se queda: eso no es el secreto, es el nombre
 * del sitio donde está, y ese sitio sí lo cifra.
 *
 * Lo que se cae se **nombra**, con la frase que dice qué hacer. El comportamiento anterior era
 * tirar el bloque entero en silencio, y quien importaba se encontraba con 401 sin saber por qué.
 */
export function redactAuth(auth: RequestAuth): { auth: RequestAuth; dropped: string[] } {
  const dropped: string[] = [];
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.params)) {
    const secret = isSecretParam(auth.type, key);
    if (secret && value.trim() && !ONLY_VARIABLES.test(value.trim())) {
      dropped.push(key);
      params[key] = "";
      continue;
    }
    params[key] = value;
  }
  return { auth: { type: auth.type, params }, dropped };
}

/** Para enseñar en una lista lo que se importó, con el nombre que la gente reconoce. */
export const AUTH_LABELS: Record<AuthType, string> = {
  none: "Sin autenticación",
  inherit: "Heredada",
  basic: "Basic",
  bearer: "Bearer",
  apikey: "Clave de API",
  jwt: "JWT",
  digest: "Digest",
  oauth1: "OAuth 1.0",
  oauth2: "OAuth 2.0",
  hawk: "Hawk",
  awsv4: "AWS Signature",
  edgegrid: "Akamai EdgeGrid",
  ntlm: "NTLM",
};

export { AUTH_TYPES };

/**
 * El flujo con los secretos escritos a mano vaciados en la autenticación de sus llamadas.
 *
 * El documento de un flujo es un `jsonb` sin cifrar, y la ayuda del inspector ya dice que un secreto
 * tiene que ser una `{{variable}}` —que vive cifrada en el entorno—. Esto es lo que hace verdad esa
 * frase: la misma regla que el import y que un endpoint, en cada puerta que escribe un flujo —
 * guardarlo, importar un proyecto, copiar entre proyectos, que puede traer una fila de antes de esta
 * regla—. El secreto vacío se queda como marca de que falta, y la corrida lo dice al firmar.
 */
export function withoutLiteralSecrets(definition: WorkflowDocument): WorkflowDocument {
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (step.fetch?.auth) return { ...step, fetch: { ...step.fetch, auth: redactAuth(step.fetch.auth).auth } };
      if (step.graphql?.auth)
        return { ...step, graphql: { ...step.graphql, auth: redactAuth(step.graphql.auth).auth } };
      return step;
    }),
  };
}
