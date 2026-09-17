/**
 * La página: los endpoints de un proyecto convertidos en documentación publicable.
 *
 * Es una función pura de `(proyecto, sitio, endpoints, ejemplos)` a `DocPage`, y está separada del
 * manejador por la misma razón que el motor del mock: **aquí se decide qué sale por una URL que
 * cualquiera puede abrir**, y eso hay que poder probarlo con dos arrays y sin base de datos.
 *
 * ## Una lista de lo que entra, no de lo que se quita
 *
 * `DocEndpoint` se escribe campo a campo desde `Endpoint`. No hay ningún `...endpoint` en este
 * fichero, y eso no es estilo: es la diferencia entre que un campo nuevo del endpoint aparezca solo
 * en la página pública —callado, el día que alguien añada `internalNotes`— y que no aparezca hasta
 * que se decida. Lo que **nunca** está en la lista:
 *
 * - `auth.params`. Un `bearer` guardado lleva el token dentro. De la autenticación sale el tipo y
 *   una frase de qué hay que mandar; el valor no sale ni tapado, porque ni tapado hace falta.
 * - `preRequestScript` y `postResponseScript`. Un script no documenta la API: documenta cómo se
 *   prueba aquí dentro, y suele llevar el token de alguien escrito.
 * - Las filas apagadas. Una cabecera con `enabled: false` no se manda, así que no es parte del
 *   contrato de nada.
 * - Los endpoints que no están `active`. Uno archivado es lo contrario de documentación.
 *
 * ## Las cabeceras: el nombre sí, el valor según
 *
 * Aquí la política es **la contraria** que al guardar un ejemplo, y el motivo es que cambia para qué
 * sirve el dato. `redactHeaders` tira la cabecera entera porque un ejemplo guardado no necesita
 * saber que había un `Authorization`. Una documentación sí: «esta ruta pide `Authorization`» es
 * justo lo que hay que decir. Así que el nombre se queda y el valor se tapa.
 *
 * ## Las variables se quedan escritas
 *
 * Un `{{token}}` sale como `{{token}}`. Esta página no tiene entorno, y resolverlas contra el del
 * proyecto sería publicar sus valores — que es de lo que un entorno está lleno.
 */
import type { AuthType } from "@eq/runner-core";

import { MASK, SECRET_HEADER, redactBody, type EndpointExample } from "@/modules/endpoints/domain/examples";
import type { Endpoint, EndpointBody, EndpointHeader } from "@/modules/endpoints/domain/model";
import type { DocSite } from "./model";

/** El grupo de los que no llevan etiqueta. Va al final: no es una etiqueta, es su ausencia. */
export const UNTAGGED_GROUP = "Sin etiqueta";

/** Un parámetro, como se documenta: qué se llama, si hace falta y un valor de muestra. */
export type DocParameter = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  /** El valor guardado, con sus `{{variables}}` intactas. Vacío cuando nadie escribió ninguno. */
  example: string;
};

/** `masked` dice que ahí había una credencial: el nombre documenta, el valor no se publica. */
export type DocHeader = { name: string; value: string; masked: boolean };

export type DocBody = {
  mode: EndpointBody["mode"];
  contentType: string;
  /** Con los campos que son credenciales tapados, cuando es JSON. */
  text: string;
  fields: { name: string; value: string; file: boolean }[];
  /** Qué campos se taparon, para decirlo en la página en vez de que parezca el valor de verdad. */
  masked: string[];
};

/**
 * De la autenticación sale el tipo y qué hay que mandar. **Nunca un valor.**
 *
 * `keyName` es la excepción, y es del mismo tamaño que la de las cabeceras: el *nombre* de la
 * cabecera o del parámetro por el que entra una API key es documentación —sin él, quien lea la
 * página no sabe dónde poner su clave— y no es un secreto. Su valor no sale, ni tapado. Nada más de
 * `params` cruza esta frontera: un usuario de `basic` es un dato personal de alguien y una URL de
 * login es infraestructura del proyecto, no de la API que documenta.
 */
export type DocAuth = {
  type: AuthType;
  label: string;
  detail: string;
  /** Solo en `apikey`: por qué nombre entra la clave. Vacío cuando no se sabe. */
  keyName: string;
  /** Solo en `apikey`: en una cabecera o en la query. */
  in: "header" | "query";
};

export type DocExample = {
  name: string;
  status: number;
  contentType: string;
  body: string;
  headers: DocHeader[];
};

export type DocEndpoint = {
  id: string;
  method: string;
  path: string;
  /** La URL entera con la base del sitio delante, o la ruta sola si el sitio no tiene base. */
  url: string;
  description: string;
  tags: string[];
  requiresAuth: boolean;
  auth: DocAuth;
  pathParameters: DocParameter[];
  query: DocParameter[];
  headers: DocHeader[];
  body: DocBody | null;
  examples: DocExample[];
};

export type DocGroup = { tag: string; endpoints: DocEndpoint[] };

export type DocPage = {
  title: string;
  /** La descripción del proyecto, que es la que ya está escrita en un sitio. */
  description: string;
  /** Lo que escribió quien publica, solo para esta página. */
  intro: string;
  baseUrl: string;
  groups: DocGroup[];
  counts: { endpoints: number; documented: number; examples: number };
  generatedAt: string;
};

/**
 * Qué hay que mandar, por tipo de autenticación.
 *
 * Es una frase y no el parámetro guardado: quien lee esto tiene que conseguir **su** credencial, no
 * la de quien montó el proyecto. `inherit` se resuelve antes de llegar aquí; si llega, es que el
 * proyecto tampoco tenía ninguna.
 */
const AUTH_DETAIL: Record<AuthType, { label: string; detail: string }> = {
  none: { label: "Sin autenticación", detail: "Esta ruta no pide credenciales." },
  inherit: { label: "Sin autenticación", detail: "Esta ruta no pide credenciales." },
  basic: { label: "Basic", detail: "Cabecera Authorization: Basic con usuario y contraseña en base64." },
  bearer: { label: "Bearer", detail: "Cabecera Authorization: Bearer con tu token." },
  apikey: { label: "API key", detail: "Una clave en la cabecera o en la query, según lo que te den." },
  jwt: { label: "JWT", detail: "Cabecera Authorization: Bearer con un JWT firmado." },
  digest: { label: "Digest", detail: "Autenticación Digest: el cliente responde al reto del servidor." },
  oauth1: { label: "OAuth 1.0", detail: "Firma OAuth 1.0 con tu clave y tu secreto de consumidor." },
  oauth2: { label: "OAuth 2.0", detail: "Un token de acceso obtenido del proveedor OAuth 2.0." },
  hawk: { label: "Hawk", detail: "Firma Hawk con tu identificador y tu clave." },
  awsv4: { label: "AWS Signature v4", detail: "Firma SigV4 con tus credenciales de AWS." },
  edgegrid: { label: "Akamai EdgeGrid", detail: "Firma EdgeGrid con tus credenciales de Akamai." },
  ntlm: { label: "NTLM", detail: "Autenticación NTLM con usuario y dominio." },
};

/**
 * La autenticación del proyecto, dicha en el vocabulario de la de un endpoint.
 *
 * Son dos listas distintas por historia: el proyecto tiene cuatro tipos —`none`, `bearer`, `basic`,
 * `api_key`— y un endpoint los trece de Postman. Un endpoint con `inherit` documenta la del
 * proyecto, y para eso hay que traducir. `api_key` y `apikey` son lo mismo escrito de dos maneras.
 */
export function projectAuthType(type: string): AuthType {
  if (type === "api_key") return "apikey";
  if (type === "bearer" || type === "basic") return type;
  return "none";
}

export function docAuth(endpoint: Endpoint, project: { authType: AuthType; apiKeyName: string }): DocAuth {
  // `inherit` significa «la del proyecto», así que lo que se documenta es la del proyecto. Sin una,
  // la ruta no pide nada y eso es lo que hay que decir.
  const inherited = endpoint.auth.type === "inherit";
  const type = inherited ? project.authType : endpoint.auth.type;
  const resolved = type === "inherit" ? "none" : type;
  // El nombre, no el valor. El del endpoint si lo escribió; el del proyecto cuando hereda.
  const keyName = resolved === "apikey" ? (inherited ? project.apiKeyName : endpoint.auth.params.key || "") : "";
  const where = endpoint.auth.params.in === "query" ? "query" : "header";
  return { type: resolved, ...AUTH_DETAIL[resolved], keyName: keyName.trim(), in: where };
}

/** La cabecera como se documenta: el nombre entero, y el valor solo si no es una credencial. */
export function docHeaders(headers: EndpointHeader[]): DocHeader[] {
  return headers
    .filter((header) => header.enabled !== false && header.name.trim())
    .map((header) =>
      SECRET_HEADER.test(header.name.trim())
        ? { name: header.name.trim(), value: MASK, masked: true }
        : { name: header.name.trim(), value: header.value, masked: false },
    );
}

/** Igual, para las cabeceras de un ejemplo guardado — que ya vienen redactadas, pero no se supone. */
function exampleHeaders(headers: EndpointHeader[]): DocHeader[] {
  return docHeaders(headers.map((header) => ({ ...header, enabled: header.enabled !== false })));
}

export function docBody(body: EndpointBody): DocBody | null {
  if (body.mode === "none") return null;
  if (body.mode === "form-data" || body.mode === "x-www-form-urlencoded") {
    return {
      mode: body.mode,
      contentType: body.mode === "form-data" ? "multipart/form-data" : "application/x-www-form-urlencoded",
      text: "",
      fields: body.fields
        .filter((field) => field.enabled !== false && field.name.trim())
        .map((field) => ({
          name: field.name,
          value: field.kind === "file" ? "" : field.value,
          file: field.kind === "file",
        })),
      masked: [],
    };
  }
  if (body.mode === "binary") {
    // Un cuerpo binario nunca se guardó: del fichero solo queda el nombre del campo. Decir «va un
    // fichero» es toda la documentación que hay, y es la correcta.
    return { mode: "binary", contentType: "application/octet-stream", text: "", fields: [], masked: [] };
  }
  const contentType = body.mode === "json" ? "application/json" : body.contentType || "text/plain";
  const redacted = redactBody(body.text, contentType);
  return { mode: body.mode, contentType, text: redacted.body, fields: [], masked: redacted.masked };
}

/**
 * La URL que se enseña.
 *
 * Sin base es la ruta sola, y eso es honesto: una documentación sin URL base no sabe contra qué se
 * llama, y poner `http://localhost:3000` de relleno sería inventarse el dato que falta.
 */
export function docUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

function docParameters(
  rows: { name: string; type: string; description: string; value: string; required?: boolean }[],
): DocParameter[] {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => ({
      name: row.name.trim(),
      type: row.type,
      // Un parámetro de ruta siempre hace falta: sin él la URL no existe. Uno de query lo dice.
      required: row.required ?? true,
      description: row.description ?? "",
      example: row.value ?? "",
    }));
}

export type DocPageInput = {
  project: {
    name: string;
    description: string;
    authType: AuthType;
    /** El nombre de la cabecera por la que entra la clave del proyecto. Un nombre, no un valor. */
    apiKeyName: string;
  };
  site: Pick<DocSite, "baseUrl" | "intro" | "includeExamples">;
  endpoints: Endpoint[];
  examplesOf: (endpointId: string) => EndpointExample[];
  generatedAt: Date;
};

export function buildDocPage(input: DocPageInput): DocPage {
  const { site } = input;
  // Solo los vivos y en activo, en el orden que tienen en la lista del proyecto: el que alguien
  // decidió arrastrando filas es mejor documentación que el alfabético.
  const endpoints = input.endpoints
    .filter((endpoint) => endpoint.status === "active")
    .sort((a, b) => a.orderIndex - b.orderIndex);

  let examples = 0;
  const documented: DocEndpoint[] = endpoints.map((endpoint) => {
    const saved = site.includeExamples ? input.examplesOf(endpoint.id) : [];
    const sorted = [...saved].sort((a, b) => a.orderIndex - b.orderIndex);
    examples += sorted.length;
    return {
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      url: docUrl(site.baseUrl, endpoint.path),
      description: endpoint.description ?? "",
      tags: endpoint.tags ?? [],
      requiresAuth: endpoint.requiresAuth,
      auth: docAuth(endpoint, input.project),
      pathParameters: docParameters(endpoint.pathParameters ?? []),
      query: docParameters((endpoint.query ?? []).filter((row) => row.enabled !== false)),
      headers: docHeaders(endpoint.headers ?? []),
      body: docBody(endpoint.body),
      examples: sorted.map((example) => ({
        name: example.name,
        status: example.response.status,
        contentType: example.response.contentType,
        body: example.response.body,
        headers: exampleHeaders(example.response.headers ?? []),
      })),
    };
  });

  // Por la primera etiqueta, como una carpeta de Postman: un endpoint aparece una vez y en un sitio.
  // Salir en tres grupos por llevar tres etiquetas es una lista que no se puede leer de arriba abajo.
  const groups: DocGroup[] = [];
  for (const endpoint of documented) {
    const tag = endpoint.tags[0]?.trim() || UNTAGGED_GROUP;
    const group = groups.find((entry) => entry.tag === tag);
    if (group) group.endpoints.push(endpoint);
    else groups.push({ tag, endpoints: [endpoint] });
  }
  groups.sort((a, b) => {
    if (a.tag === UNTAGGED_GROUP) return 1;
    if (b.tag === UNTAGGED_GROUP) return -1;
    return 0;
  });

  return {
    title: input.project.name,
    description: input.project.description ?? "",
    intro: site.intro,
    baseUrl: site.baseUrl,
    groups,
    counts: {
      endpoints: documented.length,
      // Cuántos tienen una descripción escrita. Es la cifra que dice si esto documenta algo o es
      // una lista de rutas, y sale antes de publicar para que se pueda arreglar antes.
      documented: documented.filter((endpoint) => endpoint.description.trim()).length,
      examples,
    },
    generatedAt: input.generatedAt.toISOString(),
  };
}
