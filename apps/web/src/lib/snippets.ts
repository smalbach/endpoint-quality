/**
 * La petición escrita como código, en los lenguajes en los que la gente la va a pegar.
 *
 * Postman tiene esto y no es un adorno: el trabajo de una herramienta de peticiones acaba cuando
 * alguien se lleva la petición **a su servicio**, y hasta ahora la única salida era un `curl` y
 * volver a escribirlo a mano en el lenguaje de destino. Una petición reescrita a mano es una
 * petición que ya no reproduce lo que se probó aquí, que es justo lo que este producto existe para
 * evitar.
 *
 * Lo que decide la forma del módulo: **resolver la petición se hace una vez, no dieciséis.**
 * Sustituir variables, montar la URL con sus parámetros de ruta y de consulta, decidir qué
 * `Content-Type` lleva el cuerpo y qué cabeceras pone la autenticación es donde están los errores
 * silenciosos, y hacerlo dentro de cada generador sería tener dieciséis sitios donde equivocarse
 * distinto. Así que hay un `SnippetRequest` —la petición ya resuelta, sin lenguaje— y cada lenguaje
 * es una función pura de ahí al texto.
 *
 * **Lo secreto no sale.** La sustitución deja una variable sensible como `{{nombre}}`, por lo mismo
 * que el `curl`: un fragmento de código se pega en un ticket, en un chat y en un repositorio, y es
 * exactamente donde el token de staging de alguien no debe viajar. El precio es que el fragmento no
 * corre tal cual cuando hay un secreto, y eso se dice en pantalla en vez de esconderlo.
 *
 * **Y lo que el lenguaje no puede hacer, lo dice.** Una firma de AWS o de Hawk se calcula sobre la
 * petición entera: no es una cabecera que se pueda escribir. Un fragmento que ponga la cabecera sin
 * firmar es un fragmento que falla con un 403 y no explica por qué, así que sale un comentario que
 * nombra lo que falta. Lo mismo con un cuerpo binario, que necesita un fichero del disco de quien
 * lo pegue.
 */
import { shellQuote } from "@/lib/curl";
import type { RequestAuthView } from "@/lib/types";

/** Un cuerpo, en las cinco formas que el editor sabe mandar. */
export type SnippetBody =
  | { kind: "none" }
  /** Texto tal cual: JSON, XML, lo que sea. `json` distingue el modo para poder ser idiomático. */
  | { kind: "text"; text: string; contentType: string; json: boolean }
  | { kind: "form"; fields: { name: string; value: string }[] }
  | { kind: "multipart"; fields: { name: string; value: string; file: boolean }[] }
  | { kind: "binary"; filename: string };

/**
 * La petición ya resuelta y sin lenguaje: lo que cada generador escribe.
 *
 * `headers` son solo las que alguien escribió. El `Content-Type` del cuerpo y las que pone la
 * autenticación **no** están aquí: cada lenguaje las coloca donde le toca —`StringContent` en C#,
 * `toRequestBody` en Kotlin, `json=` en Python— y meterlas en la lista obligaría a que todos las
 * escribieran como cabecera suelta, que es lo que hace que el código generado se note generado.
 */
export type SnippetRequest = {
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body: SnippetBody;
  /** Con los parámetros ya sustituidos. Semántica, no aplanada: ver el comentario de `headers`. */
  auth: RequestAuthView;
};

/* ------------------------------------------------------------------ *
 * Comillas
 *
 * Aquí es donde un generador de fragmentos se rompe de verdad, y en silencio: un `$` sin escapar
 * en una cadena de PHP se convierte en una variable vacía, y el fragmento manda un cuerpo distinto
 * del que se probó. No compila, o peor, compila y manda otra cosa.
 * ------------------------------------------------------------------ */

// Los caracteres de control en la clase de caracteres son el sentido de esta expresión, no un
// descuido: es la que los encuentra para escaparlos. Deja fuera `\n`, `\r` y `\t`, que ya se han
// convertido a su forma corta antes de llegar aquí.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const escaped = (text: string, unicode: (code: number) => string): string =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(CONTROL, (char) => unicode(char.charCodeAt(0)));

const hex4 = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;

/** Comillas dobles con barras, que es literalmente la misma sintaxis en JS, Python, Go, Java, C#
 * y Swift. Un solo escapador para los seis en vez de seis que hay que mantener iguales. */
export const dq = (text: string): string => `"${escaped(text, hex4).replace(/"/g, '\\"')}"`;

/** PHP interpola `$` dentro de comillas dobles: sin escaparlo, `"$id"` es una variable vacía. */
export const phpQuote = (text: string): string => `"${escaped(text, hex4).replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;

/** Ruby interpola `#{`. Escapar todo `#` también es legal y no hay que mirar el siguiente carácter. */
export const rubyQuote = (text: string): string => `"${escaped(text, hex4).replace(/"/g, '\\"').replace(/#/g, "\\#")}"`;

/** Kotlin interpola `$`, y lo acepta escapado. */
export const kotlinQuote = (text: string): string =>
  `"${escaped(text, hex4).replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;

/** Dart interpola `$` y se escribe con comilla simple por costumbre de la comunidad. */
export const dartQuote = (text: string): string =>
  `'${escaped(text, hex4).replace(/'/g, "\\'").replace(/\$/g, "\\$")}'`;

/** Rust escribe los caracteres de control `\u{7f}`, no `\u007f`: la otra forma no compila. */
export const rustQuote = (text: string): string =>
  `"${escaped(text, (code) => `\\u{${code.toString(16)}}`).replace(/"/g, '\\"')}"`;

/** PowerShell no interpreta nada dentro de comilla simple, y una comilla se dobla. Un salto de
 * línea literal es legal, así que no se escapa: el cuerpo se lee como se escribió. */
export const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/* ------------------------------------------------------------------ *
 * La autenticación, una vez
 * ------------------------------------------------------------------ */

/** Lo que la autenticación aporta, separado por cómo lo escribe cada lenguaje. */
export type AuthPlan = {
  /** Cabeceras que cualquier lenguaje puede poner tal cual. */
  headers: { name: string; value: string }[];
  /** Una clave que va en la URL. */
  query: { name: string; value: string }[];
  /** Basic: todos los clientes HTTP lo traen de fábrica, así que se pasa sin aplanar. */
  basic: { username: string; password: string } | null;
  /** Digest: solo `curl` y `requests` lo negocian solos. El resto se lleva el aviso. */
  digest: { username: string; password: string } | null;
  /** Lo que este fragmento no puede llevar, dicho en una línea. */
  note: string | null;
};

const EMPTY_PLAN: AuthPlan = { headers: [], query: [], basic: null, digest: null, note: null };

/**
 * La autenticación resuelta, o el aviso de que no se puede resolver.
 *
 * Una cabecera `Authorization` escrita a mano gana: si alguien la puso, es la que quiere mandar, y
 * añadir la del bloque `auth` daría dos y un 401 que no se explica.
 */
export function authPlan(auth: RequestAuthView, headers: { name: string; value: string }[]): AuthPlan {
  const written = headers.some((header) => header.name.toLowerCase() === "authorization");
  if (written || auth.type === "inherit" || auth.type === "none") return EMPTY_PLAN;
  const of = (name: string) => auth.params[name] ?? "";
  const bearer = (token: string) => ({ ...EMPTY_PLAN, headers: [{ name: "Authorization", value: `Bearer ${token}` }] });

  switch (auth.type) {
    case "bearer":
      return of("token") ? bearer(of("token")) : EMPTY_PLAN;
    case "basic":
      return { ...EMPTY_PLAN, basic: { username: of("username"), password: of("password") } };
    case "digest":
      return { ...EMPTY_PLAN, digest: { username: of("username"), password: of("password") } };
    case "apikey": {
      if (!of("key")) return EMPTY_PLAN;
      const pair = { name: of("key"), value: of("value") };
      return (auth.params.in ?? "header") === "query"
        ? { ...EMPTY_PLAN, query: [pair] }
        : { ...EMPTY_PLAN, headers: [pair] };
    }
    case "jwt":
    case "oauth2": {
      const token = of("accessToken") || of("token");
      const label = auth.type === "jwt" ? "JWT" : "OAuth 2.0";
      return token ? bearer(token) : { ...EMPTY_PLAN, note: `falta el token de ${label}` };
    }
    default:
      // Firma calculada sobre la petición entera. No es una cabecera que se pueda escribir, y
      // escribirla a medias da un 403 que no dice por qué.
      return {
        ...EMPTY_PLAN,
        note: `${auth.type}: la firma se calcula sobre la petición y este fragmento no la lleva`,
      };
  }
}

/** La URL con lo que la autenticación le añada. Los generadores no la montan: la piden hecha. */
export function fullUrl(request: SnippetRequest, plan: AuthPlan): string {
  if (!plan.query.length) return request.url;
  const extra = new URLSearchParams();
  for (const pair of plan.query) extra.append(pair.name, pair.value);
  return `${request.url}${request.url.includes("?") ? "&" : "?"}${extra.toString()}`;
}

/** Las cabeceras finales: las escritas, las de la autenticación, y la del cuerpo cuando hace falta.
 * En este orden porque es el que tiene sentido leyendo: lo que pusiste, lo que entra, y el tipo. */
export function allHeaders(request: SnippetRequest, plan: AuthPlan): { name: string; value: string }[] {
  const rows = [...request.headers, ...plan.headers];
  const has = (name: string) => rows.some((header) => header.name.toLowerCase() === name);
  const type = contentTypeOf(request.body);
  if (type && !has("content-type")) rows.push({ name: "Content-Type", value: type });
  return rows;
}

/** El `Content-Type` que el cuerpo implica, o nada cuando el cliente lo pone él. */
export function contentTypeOf(body: SnippetBody): string | null {
  if (body.kind === "text") return body.json ? "application/json" : body.contentType;
  if (body.kind === "form") return "application/x-www-form-urlencoded";
  // `multipart` lleva un `boundary` que genera el cliente: escribirlo a mano lo rompe.
  return null;
}

/** El cuerpo como texto, cuando es texto. Un formulario se codifica; lo demás no es una cadena. */
export function bodyText(body: SnippetBody): string | null {
  if (body.kind === "text") return body.text;
  if (body.kind === "form") {
    const form = new URLSearchParams();
    for (const field of body.fields) form.append(field.name, field.value);
    return form.toString();
  }
  return null;
}

/** Lo que este fragmento no puede llevar: se enseña encima del código, no se calla. */
export function snippetNotes(request: SnippetRequest, plan: AuthPlan): string[] {
  const notes: string[] = [];
  if (plan.note) notes.push(plan.note);
  if (plan.digest) notes.push("Digest: solo curl y requests negocian el 401 solos; el resto lo pide a mano");
  if (request.body.kind === "binary") notes.push(`el cuerpo es un fichero: ${request.body.filename}`);
  if (request.body.kind === "multipart" && request.body.fields.some((field) => field.file))
    notes.push("los campos de tipo fichero salen con el nombre, no con el contenido");
  const secrets = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) secrets.add(match[1]);
  };
  scan(request.url);
  for (const header of allHeaders(request, plan)) scan(header.value);
  scan(bodyText(request.body) ?? "");
  for (const value of Object.values(request.auth.params)) scan(value);
  if (secrets.size) notes.push(`quedan sin sustituir por ser secretas: ${[...secrets].sort().join(", ")}`);
  return notes;
}

/* ------------------------------------------------------------------ *
 * Ayudas de forma
 * ------------------------------------------------------------------ */

const indent = (lines: string[], pad: string) => lines.map((line) => `${pad}${line}`);

/** Un mapa de cabeceras, con el par escrito por quien lo pide. */
const headerMap = (
  headers: { name: string; value: string }[],
  pair: (name: string, value: string) => string,
  pad: string,
): string[] =>
  indent(
    headers.map((header) => pair(header.name, header.value)),
    pad,
  );

const commented = (notes: string[], prefix: string): string[] => notes.map((note) => `${prefix} ${note}`);

/* ------------------------------------------------------------------ *
 * Los lenguajes
 * ------------------------------------------------------------------ */

/**
 * `curl`, y es el que estaba antes: sale idéntico byte a byte.
 *
 * Que sea idéntico no es casualidad ni cortesía: la prueba que ya existía compara la cadena
 * completa, así que si este refactor hubiera cambiado el comando, se pone roja. Es la única forma
 * de demostrar que mover el `curl` a una lista de dieciséis no le cambió nada.
 */
function curl(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const lines = [`curl ${request.method === "GET" ? "" : `-X ${request.method} `}${shellQuote(request.url)}`];
  for (const header of request.headers) lines.push(`  -H ${shellQuote(`${header.name}: ${header.value}`)}`);

  if (plan.basic) lines.push(`  -u ${shellQuote(`${plan.basic.username}:${plan.basic.password}`)}`);
  else if (plan.digest) lines.push(`  --digest -u ${shellQuote(`${plan.digest.username}:${plan.digest.password}`)}`);
  else if (plan.query.length)
    for (const pair of plan.query) lines.push(`  --url-query ${shellQuote(`${pair.name}=${pair.value}`)}`);
  else if (plan.headers.length)
    for (const header of plan.headers) lines.push(`  -H ${shellQuote(`${header.name}: ${header.value}`)}`);
  else if (plan.note) lines.push(`  # ${plan.note}`);

  const body = request.body;
  const written = request.headers.some((header) => header.name.toLowerCase() === "content-type");
  if (body.kind === "text") {
    if (!written)
      lines.push(`  -H ${shellQuote(`Content-Type: ${body.json ? "application/json" : body.contentType}`)}`);
    lines.push(`  --data ${shellQuote(body.text)}`);
  } else if (body.kind === "form") {
    for (const field of body.fields) lines.push(`  --data-urlencode ${shellQuote(`${field.name}=${field.value}`)}`);
  } else if (body.kind === "multipart") {
    for (const field of body.fields)
      lines.push(`  -F ${shellQuote(`${field.name}=${field.file ? `@${field.value}` : field.value}`)}`);
  } else if (body.kind === "binary") {
    lines.push(`  --data-binary ${shellQuote(`@${body.filename}`)}`);
  }
  return lines.join(" \\\n");
}

/** HTTPie, que es el `curl` de quien ya no quiere escribir `curl`. */
function httpie(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const parts = [`http ${request.method} ${shellQuote(fullUrl(request, plan))}`];
  for (const header of [...request.headers, ...plan.headers])
    parts.push(`  ${shellQuote(`${header.name}:${header.value}`)}`);
  if (plan.basic) parts.push(`  --auth ${shellQuote(`${plan.basic.username}:${plan.basic.password}`)}`);
  if (plan.digest)
    parts.push(`  --auth-type digest --auth ${shellQuote(`${plan.digest.username}:${plan.digest.password}`)}`);
  if (plan.note) parts.push(`  # ${plan.note}`);

  const body = request.body;
  if (body.kind === "text") {
    parts.push(`  --raw ${shellQuote(body.text)}`);
    if (!body.json) parts.push(`  ${shellQuote(`Content-Type:${body.contentType}`)}`);
  } else if (body.kind === "form") {
    parts.push("  --form");
    for (const field of body.fields) parts.push(`  ${shellQuote(`${field.name}=${field.value}`)}`);
  } else if (body.kind === "multipart") {
    parts.push("  --multipart");
    for (const field of body.fields)
      parts.push(`  ${shellQuote(`${field.name}${field.file ? "@" : "="}${field.value}`)}`);
  } else if (body.kind === "binary") {
    parts.push(`  < ${shellQuote(body.filename)}`);
  }
  return parts.join(" \\\n");
}

/** Base64 de UTF-8. `btoa` solo acepta latin-1 y lanza con una contraseña con acento, que es
 * justo la que nadie prueba. */
export const base64Utf8 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/**
 * La petición cruda, tal y como va por el cable.
 *
 * No es un lenguaje y es la entrada que más veces resuelve un problema: cuando un proxy o un
 * balanceador contesta algo raro, lo que hay que poder leer es la petición literal —el orden de las
 * cabeceras, el `Host`, el `Content-Length`— y no la versión que un cliente HTTP escribiría.
 */
function httpRaw(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  let target = fullUrl(request, plan);
  let host = "";
  try {
    const url = new URL(target);
    host = url.host;
    target = `${url.pathname}${url.search}`;
  } catch {
    // Una URL con `{{baseUrl}}` sin resolver no se puede partir. Se escribe entera, que es más
    // honesto que inventar un `Host`.
  }
  const lines = [`${request.method} ${target} HTTP/1.1`];
  if (host) lines.push(`Host: ${host}`);
  for (const header of allHeaders(request, plan)) lines.push(`${header.name}: ${header.value}`);
  // El Basic **se calcula**, no se describe: esta entrada existe para poder mandar la petición por
  // un socket, y una cabecera que dice «aquí va el base64» no se puede mandar. Con una variable sin
  // sustituir no hay nada que calcular, y entonces sí sale el marcador.
  if (plan.basic) {
    const pair = `${plan.basic.username}:${plan.basic.password}`;
    lines.push(`Authorization: Basic ${pair.includes("{{") ? `<base64 de ${pair}>` : base64Utf8(pair)}`);
  }
  if (plan.digest) lines.push("Authorization: Digest <se calcula con el nonce que venga en el 401>");
  // El aviso **no** se escribe aquí. En los otros quince va como comentario del lenguaje y viaja
  // con el código copiado, que es lo que se quiere; aquí una línea que empieza por `#` no es una
  // cabecera HTTP, y mandada por un socket rompe la petición entera. Esta entrada existe para ser
  // mandable, así que el aviso se queda solo en la lista de arriba.

  const body = request.body;
  const text = bodyText(body);
  if (text !== null) {
    lines.push(`Content-Length: ${new TextEncoder().encode(text).length}`, "", text);
  } else if (body.kind === "multipart") {
    const boundary = "----limite";
    lines.push(`Content-Type: multipart/form-data; boundary=${boundary}`, "");
    for (const field of body.fields) {
      lines.push(`--${boundary}`);
      lines.push(
        field.file
          ? `Content-Disposition: form-data; name="${field.name}"; filename="${field.value}"`
          : `Content-Disposition: form-data; name="${field.name}"`,
      );
      lines.push("", field.file ? "<el contenido del fichero>" : field.value);
    }
    lines.push(`--${boundary}--`);
  } else if (body.kind === "binary") {
    lines.push("", `<el contenido de ${body.filename}>`);
  }
  return lines.join("\n");
}

/** `fetch`, que es el que ya está en el navegador y en Node desde la 18. */
function jsFetch(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  if (plan.basic) headers.push({ name: "Authorization", value: "__BASIC__" });
  const lines: string[] = [...commented(snippetNotes(request, plan), "//")];

  const body = request.body;
  if (body.kind === "multipart") {
    lines.push("const form = new FormData();");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `form.append(${dq(field.name)}, fichero); // ${field.value}`
          : `form.append(${dq(field.name)}, ${dq(field.value)});`,
      );
    lines.push("");
  }

  lines.push(`const response = await fetch(${dq(fullUrl(request, plan))}, {`, `  method: ${dq(request.method)},`);
  if (headers.length) {
    lines.push("  headers: {");
    for (const header of headers)
      lines.push(
        header.value === "__BASIC__"
          ? `    ${dq(header.name)}: "Basic " + btoa(${dq(`${plan.basic!.username}:${plan.basic!.password}`)}),`
          : `    ${dq(header.name)}: ${dq(header.value)},`,
      );
    lines.push("  },");
  }
  if (body.kind === "text") lines.push(`  body: ${dq(body.text)},`);
  else if (body.kind === "form") lines.push(`  body: ${dq(bodyText(body)!)},`);
  else if (body.kind === "multipart") lines.push("  body: form,");
  else if (body.kind === "binary") lines.push(`  body: fichero, // ${body.filename}`);
  lines.push("});", "", "console.log(response.status);", "console.log(await response.text());");
  return lines.join("\n");
}

/** `axios`, que sigue siendo lo que hay en la mayoría de los proyectos que ya existen. */
function axios(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const lines: string[] = ['import axios from "axios";', "", ...commented(snippetNotes(request, plan), "//")];

  const body = request.body;
  if (body.kind === "multipart") {
    lines.push("const form = new FormData();");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `form.append(${dq(field.name)}, fichero); // ${field.value}`
          : `form.append(${dq(field.name)}, ${dq(field.value)});`,
      );
    lines.push("");
  }

  lines.push(
    "const response = await axios({",
    `  method: ${dq(request.method.toLowerCase())},`,
    `  url: ${dq(fullUrl(request, plan))},`,
  );
  if (headers.length) {
    lines.push("  headers: {");
    lines.push(...headerMap(headers, (name, value) => `${dq(name)}: ${dq(value)},`, "    "));
    lines.push("  },");
  }
  if (plan.basic) lines.push(`  auth: { username: ${dq(plan.basic.username)}, password: ${dq(plan.basic.password)} },`);
  if (body.kind === "text" || body.kind === "form") lines.push(`  data: ${dq(bodyText(body)!)},`);
  else if (body.kind === "multipart") lines.push("  data: form,");
  else if (body.kind === "binary") lines.push(`  data: fichero, // ${body.filename}`);
  lines.push("});", "", "console.log(response.status, response.data);");
  return lines.join("\n");
}

/** Python con `requests`, que es como se escribe una petición en Python. */
function python(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const lines = ["import requests", ""];
  if (plan.digest) lines.push("from requests.auth import HTTPDigestAuth", "");
  lines.push(...commented(snippetNotes(request, plan), "#"));

  lines.push(`url = ${dq(fullUrl(request, plan))}`);
  if (headers.length) {
    lines.push("headers = {");
    lines.push(...headerMap(headers, (name, value) => `${dq(name)}: ${dq(value)},`, "    "));
    lines.push("}");
  }

  const call: string[] = ["url"];
  if (headers.length) call.push("headers=headers");
  if (body.kind === "text") {
    lines.push(`payload = ${dq(body.text)}`);
    call.push("data=payload");
  } else if (body.kind === "form") {
    lines.push("payload = {");
    lines.push(...headerMap(body.fields, (name, value) => `${dq(name)}: ${dq(value)},`, "    "));
    lines.push("}");
    call.push("data=payload");
  } else if (body.kind === "multipart") {
    const texts = body.fields.filter((field) => !field.file);
    const files = body.fields.filter((field) => field.file);
    if (texts.length) {
      lines.push("payload = {");
      lines.push(...headerMap(texts, (name, value) => `${dq(name)}: ${dq(value)},`, "    "));
      lines.push("}");
      call.push("data=payload");
    }
    if (files.length) {
      lines.push("files = {");
      for (const field of files) lines.push(`    ${dq(field.name)}: open(${dq(field.value)}, "rb"),`);
      lines.push("}");
      call.push("files=files");
    }
  } else if (body.kind === "binary") {
    lines.push(`payload = open(${dq(body.filename)}, "rb")`);
    call.push("data=payload");
  }
  if (plan.basic) call.push(`auth=(${dq(plan.basic.username)}, ${dq(plan.basic.password)})`);
  if (plan.digest) call.push(`auth=HTTPDigestAuth(${dq(plan.digest.username)}, ${dq(plan.digest.password)})`);

  lines.push(
    "",
    `response = requests.request(${dq(request.method)}, ${call.join(", ")})`,
    "print(response.status_code)",
    "print(response.text)",
  );
  return lines.join("\n");
}

/**
 * Go con `net/http`, y los `import` calculados.
 *
 * Go **no compila** con un `import` que no se usa. Un generador que escriba siempre la misma lista
 * de imports da código que no compila la mitad de las veces, así que la lista se monta con lo que
 * este fragmento acaba usando.
 */
function go(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);

  const imports = new Set(["fmt", "io", "net/http"]);
  if (text !== null) imports.add("strings");
  if (body.kind === "multipart" || body.kind === "binary") imports.add("os");
  if (body.kind === "multipart") {
    imports.add("bytes");
    imports.add("mime/multipart");
  }

  const lines = ["package main", "", "import ("];
  for (const name of [...imports].sort()) lines.push(`\t${dq(name)}`);
  lines.push(")", "", "func main() {", ...indent(commented(snippetNotes(request, plan), "//"), "\t"));

  let payload = "nil";
  if (text !== null) {
    lines.push(`\tpayload := strings.NewReader(${dq(text)})`);
    payload = "payload";
  } else if (body.kind === "multipart") {
    lines.push("\tvar buffer bytes.Buffer", "\twriter := multipart.NewWriter(&buffer)");
    for (const field of body.fields) {
      if (field.file) {
        lines.push(
          `\tfile, err := os.Open(${dq(field.value)})`,
          "\tif err != nil {",
          "\t\tpanic(err)",
          "\t}",
          `\tpart, err := writer.CreateFormFile(${dq(field.name)}, ${dq(field.value)})`,
          "\tif err != nil {",
          "\t\tpanic(err)",
          "\t}",
          "\tif _, err := io.Copy(part, file); err != nil {",
          "\t\tpanic(err)",
          "\t}",
          "\tfile.Close()",
        );
      } else {
        lines.push(`\twriter.WriteField(${dq(field.name)}, ${dq(field.value)})`);
      }
    }
    lines.push("\twriter.Close()");
    payload = "&buffer";
  } else if (body.kind === "binary") {
    lines.push(
      `\tfile, err := os.Open(${dq(body.filename)})`,
      "\tif err != nil {",
      "\t\tpanic(err)",
      "\t}",
      "\tdefer file.Close()",
    );
    payload = "file";
  }

  lines.push(
    `\treq, err := http.NewRequest(${dq(request.method)}, ${dq(fullUrl(request, plan))}, ${payload})`,
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
  );
  for (const header of headers) lines.push(`\treq.Header.Set(${dq(header.name)}, ${dq(header.value)})`);
  if (body.kind === "multipart") lines.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
  if (plan.basic) lines.push(`\treq.SetBasicAuth(${dq(plan.basic.username)}, ${dq(plan.basic.password)})`);
  lines.push(
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer res.Body.Close()",
    "\tout, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(res.Status)",
    "\tfmt.Println(string(out))",
    "}",
  );
  return lines.join("\n");
}

/** Java con el `HttpClient` de la plataforma: sin dependencias, que es lo que quiere quien copia. */
function java(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);

  const lines = [
    "import java.net.URI;",
    "import java.net.http.HttpClient;",
    "import java.net.http.HttpRequest;",
    "import java.net.http.HttpResponse;",
  ];
  if (plan.basic) lines.push("import java.util.Base64;");
  if (body.kind === "multipart" || body.kind === "binary") lines.push("import java.nio.file.Path;");
  lines.push("", ...commented(snippetNotes(request, plan), "//"));
  if (body.kind === "multipart")
    lines.push("// multipart: el HttpClient de la plataforma no lo monta; usa un BodyPublisher propio");

  const publisher =
    text !== null
      ? `HttpRequest.BodyPublishers.ofString(${dq(text)})`
      : body.kind === "binary"
        ? `HttpRequest.BodyPublishers.ofFile(Path.of(${dq(body.filename)}))`
        : "HttpRequest.BodyPublishers.noBody()";

  lines.push(
    "HttpClient client = HttpClient.newHttpClient();",
    "HttpRequest request = HttpRequest.newBuilder()",
    `    .uri(URI.create(${dq(fullUrl(request, plan))}))`,
  );
  for (const header of headers) lines.push(`    .header(${dq(header.name)}, ${dq(header.value)})`);
  if (plan.basic)
    lines.push(
      `    .header("Authorization", "Basic " + Base64.getEncoder().encodeToString(${dq(`${plan.basic.username}:${plan.basic.password}`)}.getBytes()))`,
    );
  lines.push(
    `    .method(${dq(request.method)}, ${publisher})`,
    "    .build();",
    "",
    "HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());",
    "System.out.println(response.statusCode());",
    "System.out.println(response.body());",
  );
  return lines.join("\n");
}

/**
 * C# con `HttpClient`.
 *
 * El detalle que casi todos los generadores fallan: `Headers.Add("Content-Type", …)` **lanza** una
 * excepción en tiempo de ejecución. Es una cabecera de contenido y va en el `HttpContent`, no en la
 * petición. Aquí se separa.
 */
function csharp(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);
  const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value;
  const rest = headers.filter((header) => header.name.toLowerCase() !== "content-type");

  const lines = ["using System.Net.Http.Headers;", "using System.Text;"];
  // `File.ReadAllBytes` necesita su `using`, y sin él no compila: se pone cuando hace falta y no
  // «siempre por si acaso», que es lo que llena de imports muertos el código generado.
  if (body.kind === "multipart" || body.kind === "binary") lines.push("using System.IO;");
  lines.push("", ...commented(snippetNotes(request, plan), "//"));
  lines.push(
    "using var client = new HttpClient();",
    `var request = new HttpRequestMessage(new HttpMethod(${dq(request.method)}), ${dq(fullUrl(request, plan))});`,
  );
  for (const header of rest) lines.push(`request.Headers.Add(${dq(header.name)}, ${dq(header.value)});`);
  if (plan.basic)
    lines.push(
      `request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(${dq(`${plan.basic.username}:${plan.basic.password}`)})));`,
    );

  if (text !== null) {
    lines.push(`request.Content = new StringContent(${dq(text)}, Encoding.UTF8, ${dq(contentType ?? "text/plain")});`);
  } else if (body.kind === "multipart") {
    lines.push("var content = new MultipartFormDataContent();");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `content.Add(new ByteArrayContent(File.ReadAllBytes(${dq(field.value)})), ${dq(field.name)}, ${dq(field.value)});`
          : `content.Add(new StringContent(${dq(field.value)}), ${dq(field.name)});`,
      );
    lines.push("request.Content = content;");
  } else if (body.kind === "binary") {
    lines.push(`request.Content = new ByteArrayContent(File.ReadAllBytes(${dq(body.filename)}));`);
  }

  lines.push(
    "",
    "var response = await client.SendAsync(request);",
    "Console.WriteLine((int)response.StatusCode);",
    "Console.WriteLine(await response.Content.ReadAsStringAsync());",
  );
  return lines.join("\n");
}

/** PHP con cURL, que es lo que hay en cualquier PHP sin instalar nada. */
function php(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);

  const lines = [
    "<?php",
    "",
    ...commented(snippetNotes(request, plan), "//"),
    "$curl = curl_init();",
    "",
    "curl_setopt_array($curl, [",
  ];
  lines.push(`    CURLOPT_URL => ${phpQuote(fullUrl(request, plan))},`);
  lines.push("    CURLOPT_RETURNTRANSFER => true,");
  lines.push("    CURLOPT_FOLLOWLOCATION => true,");
  lines.push(`    CURLOPT_CUSTOMREQUEST => ${phpQuote(request.method)},`);
  if (text !== null) lines.push(`    CURLOPT_POSTFIELDS => ${phpQuote(text)},`);
  else if (body.kind === "multipart") {
    lines.push("    CURLOPT_POSTFIELDS => [");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `        ${phpQuote(field.name)} => new CURLFile(${phpQuote(field.value)}),`
          : `        ${phpQuote(field.name)} => ${phpQuote(field.value)},`,
      );
    lines.push("    ],");
  } else if (body.kind === "binary") {
    lines.push(`    CURLOPT_POSTFIELDS => file_get_contents(${phpQuote(body.filename)}),`);
  }
  if (plan.basic) {
    lines.push("    CURLOPT_HTTPAUTH => CURLAUTH_BASIC,");
    lines.push(`    CURLOPT_USERPWD => ${phpQuote(`${plan.basic.username}:${plan.basic.password}`)},`);
  }
  if (plan.digest) {
    lines.push("    CURLOPT_HTTPAUTH => CURLAUTH_DIGEST,");
    lines.push(`    CURLOPT_USERPWD => ${phpQuote(`${plan.digest.username}:${plan.digest.password}`)},`);
  }
  if (headers.length) {
    lines.push("    CURLOPT_HTTPHEADER => [");
    lines.push(...headerMap(headers, (name, value) => `${phpQuote(`${name}: ${value}`)},`, "        "));
    lines.push("    ],");
  }
  lines.push(
    "]);",
    "",
    "$response = curl_exec($curl);",
    "echo curl_getinfo($curl, CURLINFO_HTTP_CODE), PHP_EOL;",
    "curl_close($curl);",
    "echo $response;",
  );
  return lines.join("\n");
}

/** Ruby con `Net::HTTP`, que viene en la biblioteca estándar. */
function ruby(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);
  // `Net::HTTP::Post`, no `Net::HTTP::POST`: son nombres de clase.
  const klass = `${request.method.charAt(0)}${request.method.slice(1).toLowerCase()}`;

  const lines = [
    'require "net/http"',
    'require "uri"',
    "",
    ...commented(snippetNotes(request, plan), "#"),
    `uri = URI(${rubyQuote(fullUrl(request, plan))})`,
    `request = Net::HTTP::${klass}.new(uri)`,
  ];
  for (const header of headers) lines.push(`request[${rubyQuote(header.name)}] = ${rubyQuote(header.value)}`);
  if (plan.basic)
    lines.push(`request.basic_auth(${rubyQuote(plan.basic.username)}, ${rubyQuote(plan.basic.password)})`);
  if (text !== null) lines.push(`request.body = ${rubyQuote(text)}`);
  else if (body.kind === "multipart") {
    lines.push("request.set_form(");
    lines.push("  [");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `    [${rubyQuote(field.name)}, File.open(${rubyQuote(field.value)})],`
          : `    [${rubyQuote(field.name)}, ${rubyQuote(field.value)}],`,
      );
    lines.push('  ], "multipart/form-data")');
  } else if (body.kind === "binary") {
    lines.push(`request.body = File.binread(${rubyQuote(body.filename)})`);
  }

  lines.push(
    "",
    'response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|',
    "  http.request(request)",
    "end",
    "",
    "puts response.code",
    "puts response.body",
  );
  return lines.join("\n");
}

/** Rust con `reqwest`. `OPTIONS` no tiene atajo, así que va por `Method`. */
function rust(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);
  const shortcuts = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
  const start = shortcuts.has(request.method)
    ? `.${request.method.toLowerCase()}(${rustQuote(fullUrl(request, plan))})`
    : `.request(reqwest::Method::${request.method}, ${rustQuote(fullUrl(request, plan))})`;

  const lines = [
    "#[tokio::main]",
    "async fn main() -> Result<(), Box<dyn std::error::Error>> {",
    ...indent(commented(snippetNotes(request, plan), "//"), "    "),
    "    let client = reqwest::Client::new();",
    "    let response = client",
    `        ${start}`,
  ];
  for (const header of headers) lines.push(`        .header(${rustQuote(header.name)}, ${rustQuote(header.value)})`);
  if (plan.basic)
    lines.push(`        .basic_auth(${rustQuote(plan.basic.username)}, Some(${rustQuote(plan.basic.password)}))`);
  if (text !== null) lines.push(`        .body(${rustQuote(text)})`);
  else if (body.kind === "multipart") {
    lines.push("        .multipart({");
    lines.push("            let mut form = reqwest::multipart::Form::new();");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `            form = form.file(${rustQuote(field.name)}, ${rustQuote(field.value)}).await?;`
          : `            form = form.text(${rustQuote(field.name)}, ${rustQuote(field.value)});`,
      );
    lines.push("            form", "        })");
  } else if (body.kind === "binary") {
    lines.push(`        .body(std::fs::read(${rustQuote(body.filename)})?)`);
  }
  lines.push(
    "        .send()",
    "        .await?;",
    "",
    '    println!("{}", response.status());',
    '    println!("{}", response.text().await?);',
    "    Ok(())",
    "}",
  );
  return lines.join("\n");
}

/** Swift con `URLSession`. */
function swift(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);

  const lines = [
    "import Foundation",
    "",
    ...commented(snippetNotes(request, plan), "//"),
    `var request = URLRequest(url: URL(string: ${dq(fullUrl(request, plan))})!)`,
    `request.httpMethod = ${dq(request.method)}`,
  ];
  for (const header of headers)
    lines.push(`request.setValue(${dq(header.value)}, forHTTPHeaderField: ${dq(header.name)})`);
  if (plan.basic) {
    lines.push(
      `let credential = ${dq(`${plan.basic.username}:${plan.basic.password}`)}.data(using: .utf8)!.base64EncodedString()`,
      'request.setValue("Basic \\(credential)", forHTTPHeaderField: "Authorization")',
    );
  }
  if (text !== null) lines.push(`request.httpBody = ${dq(text)}.data(using: .utf8)`);
  else if (body.kind === "multipart")
    lines.push("// multipart: URLSession no lo monta; escribe el cuerpo con su boundary a mano");
  else if (body.kind === "binary")
    lines.push(`request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${dq(body.filename)}))`);

  lines.push(
    "",
    "let (data, response) = try await URLSession.shared.data(for: request)",
    "print((response as? HTTPURLResponse)?.statusCode ?? 0)",
    'print(String(data: data, encoding: .utf8) ?? "")',
  );
  return lines.join("\n");
}

/** Kotlin con OkHttp. Los métodos sin cuerpo se piden por `method(…, null)`. */
function kotlin(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);
  const contentType = contentTypeOf(body) ?? "application/octet-stream";

  const lines = [
    "import okhttp3.MediaType.Companion.toMediaType",
    "import okhttp3.OkHttpClient",
    "import okhttp3.Request",
  ];
  if (text !== null) lines.push("import okhttp3.RequestBody.Companion.toRequestBody");
  if (plan.basic) lines.push("import okhttp3.Credentials");
  if (body.kind === "multipart")
    lines.push(
      "import okhttp3.MultipartBody",
      "import java.io.File",
      "import okhttp3.RequestBody.Companion.asRequestBody",
    );
  lines.push("", ...commented(snippetNotes(request, plan), "//"), "val client = OkHttpClient()");

  let payload = "null";
  if (text !== null) {
    lines.push(`val body = ${kotlinQuote(text)}.toRequestBody(${kotlinQuote(contentType)}.toMediaType())`);
    payload = "body";
  } else if (body.kind === "multipart") {
    lines.push("val body = MultipartBody.Builder()", "    .setType(MultipartBody.FORM)");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `    .addFormDataPart(${kotlinQuote(field.name)}, ${kotlinQuote(field.value)}, File(${kotlinQuote(field.value)}).asRequestBody())`
          : `    .addFormDataPart(${kotlinQuote(field.name)}, ${kotlinQuote(field.value)})`,
      );
    lines.push("    .build()");
    payload = "body";
  } else if (body.kind === "binary") {
    lines.push(`val body = File(${kotlinQuote(body.filename)}).asRequestBody()`);
    payload = "body";
  }

  lines.push("val request = Request.Builder()", `    .url(${kotlinQuote(fullUrl(request, plan))})`);
  for (const header of headers) lines.push(`    .addHeader(${kotlinQuote(header.name)}, ${kotlinQuote(header.value)})`);
  if (plan.basic)
    lines.push(
      `    .addHeader("Authorization", Credentials.basic(${kotlinQuote(plan.basic.username)}, ${kotlinQuote(plan.basic.password)}))`,
    );
  lines.push(`    .method(${kotlinQuote(request.method)}, ${payload})`, "    .build()");
  lines.push(
    "",
    "client.newCall(request).execute().use { response ->",
    "    println(response.code)",
    "    println(response.body?.string())",
    "}",
  );
  return lines.join("\n");
}

/** Dart con `package:http`. */
function dart(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);

  const lines = ["import 'package:http/http.dart' as http;"];
  if (plan.basic) lines.push("import 'dart:convert';");
  lines.push("", ...commented(snippetNotes(request, plan), "//"));

  if (body.kind === "multipart") {
    lines.push(
      `final request = http.MultipartRequest(${dartQuote(request.method)}, Uri.parse(${dartQuote(fullUrl(request, plan))}));`,
    );
    for (const field of body.fields)
      lines.push(
        field.file
          ? `request.files.add(await http.MultipartFile.fromPath(${dartQuote(field.name)}, ${dartQuote(field.value)}));`
          : `request.fields[${dartQuote(field.name)}] = ${dartQuote(field.value)};`,
      );
    for (const header of headers)
      lines.push(`request.headers[${dartQuote(header.name)}] = ${dartQuote(header.value)};`);
    lines.push(
      "",
      "final response = await http.Response.fromStream(await request.send());",
      "print(response.statusCode);",
      "print(response.body);",
    );
    return lines.join("\n");
  }

  lines.push(
    `final request = http.Request(${dartQuote(request.method)}, Uri.parse(${dartQuote(fullUrl(request, plan))}));`,
  );
  for (const header of headers) lines.push(`request.headers[${dartQuote(header.name)}] = ${dartQuote(header.value)};`);
  if (plan.basic)
    lines.push(
      `request.headers['Authorization'] = 'Basic ' + base64Encode(utf8.encode(${dartQuote(`${plan.basic.username}:${plan.basic.password}`)}));`,
    );
  if (text !== null) lines.push(`request.body = ${dartQuote(text)};`);
  else if (body.kind === "binary")
    lines.push(`request.bodyBytes = await File(${dartQuote(body.filename)}).readAsBytes();`);
  lines.push(
    "",
    "final response = await http.Response.fromStream(await request.send());",
    "print(response.statusCode);",
    "print(response.body);",
  );
  return lines.join("\n");
}

/** PowerShell con `Invoke-RestMethod`, que es lo que se usa en una máquina Windows. */
function powershell(request: SnippetRequest): string {
  const plan = authPlan(request.auth, request.headers);
  const headers = allHeaders(request, plan);
  const body = request.body;
  const text = bodyText(body);

  const lines = [...commented(snippetNotes(request, plan), "#")];
  if (headers.length) {
    lines.push("$headers = @{");
    lines.push(...headerMap(headers, (name, value) => `${psQuote(name)} = ${psQuote(value)}`, "    "));
    lines.push("}");
  }
  if (plan.basic) {
    lines.push(
      `$pair = ${psQuote(`${plan.basic.username}:${plan.basic.password}`)}`,
      "$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))",
      `$headers${headers.length ? "" : " = @{}"}`,
      "$headers['Authorization'] = \"Basic $basic\"",
    );
  }

  const call = [`-Uri ${psQuote(fullUrl(request, plan))}`, `-Method ${psQuote(request.method)}`];
  if (headers.length || plan.basic) call.push("-Headers $headers");
  if (text !== null) {
    lines.push(`$body = ${psQuote(text)}`);
    call.push("-Body $body");
  } else if (body.kind === "multipart") {
    lines.push("$form = @{");
    for (const field of body.fields)
      lines.push(
        field.file
          ? `    ${psQuote(field.name)} = Get-Item ${psQuote(field.value)}`
          : `    ${psQuote(field.name)} = ${psQuote(field.value)}`,
      );
    lines.push("}");
    call.push("-Form $form");
  } else if (body.kind === "binary") {
    lines.push(`$body = [IO.File]::ReadAllBytes(${psQuote(body.filename)})`);
    call.push("-Body $body");
  }

  lines.push("", `$response = Invoke-RestMethod ${call.join(" ")}`, "$response | ConvertTo-Json -Depth 10");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * La lista
 * ------------------------------------------------------------------ */

export type SnippetLanguage = {
  id: string;
  /** El grupo que sale en el selector: el lenguaje. */
  group: string;
  /** La biblioteca, que es lo que distingue dos entradas del mismo lenguaje. */
  label: string;
  /**
   * Lo que hay que tener para que el fragmento corra, cuando no es obvio.
   *
   * No es decoración: pegar el de Go sin `go mod init` da un error de módulo que no tiene nada que
   * ver con la petición, y el crudo mandado por un socket con saltos de línea `\n` da un 400 que
   * tampoco. Una línea aquí ahorra el rato de buscar por qué.
   */
  hint?: string;
  render: (request: SnippetRequest) => string;
};

/**
 * Los dieciséis, y el criterio para que uno entre: que sea la forma en la que la gente de ese
 * lenguaje escribe de verdad una petición.
 *
 * Por eso hay `net/http` y no un envoltorio de Go, `HttpClient` y no `RestSharp` en C#, y por eso
 * `fetch` va antes que `axios`. Y por eso está el HTTP crudo, que no es un lenguaje: cuando lo que
 * contesta raro es un proxy, la petición literal es lo único que sirve.
 */
export const SNIPPET_LANGUAGES: SnippetLanguage[] = [
  { id: "curl", group: "Shell", label: "cURL", render: curl },
  { id: "httpie", group: "Shell", label: "HTTPie", hint: "brew install httpie", render: httpie },
  {
    id: "http",
    group: "HTTP",
    label: "Crudo",
    hint: "por el cable las líneas de cabecera van con CRLF, no con \\n; el cuerpo va tal cual o el Content-Length descuadra",
    render: httpRaw,
  },
  { id: "fetch", group: "JavaScript", label: "fetch", hint: "en el navegador y en Node desde la 18", render: jsFetch },
  { id: "axios", group: "JavaScript", label: "axios", hint: "npm i axios", render: axios },
  { id: "python", group: "Python", label: "requests", hint: "pip install requests", render: python },
  { id: "go", group: "Go", label: "net/http", hint: "go mod init ejemplo && go mod tidy", render: go },
  { id: "java", group: "Java", label: "HttpClient", hint: "java.net.http viene con el JDK desde la 11", render: java },
  {
    id: "csharp",
    group: "C#",
    label: "HttpClient",
    hint: "es código de nivel superior: vale en un Program.cs de .NET 6 o más",
    render: csharp,
  },
  { id: "php", group: "PHP", label: "cURL", render: php },
  { id: "ruby", group: "Ruby", label: "Net::HTTP", hint: "Net::HTTP viene con Ruby", render: ruby },
  {
    id: "rust",
    group: "Rust",
    label: "reqwest",
    hint: "cargo add reqwest tokio --features reqwest/json,tokio/full",
    render: rust,
  },
  { id: "swift", group: "Swift", label: "URLSession", render: swift },
  {
    id: "kotlin",
    group: "Kotlin",
    label: "OkHttp",
    hint: 'implementation("com.squareup.okhttp3:okhttp:4.12.0")',
    render: kotlin,
  },
  { id: "dart", group: "Dart", label: "http", hint: "dart pub add http", render: dart },
  { id: "powershell", group: "PowerShell", label: "Invoke-RestMethod", render: powershell },
];

export const DEFAULT_SNIPPET = "curl";

/** El fragmento, o el aviso de que ese lenguaje no está: un `id` que no existe es un error de
 * quien llama, y devolver cadena vacía lo esconde. */
export function renderSnippet(id: string, request: SnippetRequest): string {
  const language = SNIPPET_LANGUAGES.find((entry) => entry.id === id);
  if (!language) throw new Error(`No hay generador para «${id}»`);
  return language.render(request);
}
