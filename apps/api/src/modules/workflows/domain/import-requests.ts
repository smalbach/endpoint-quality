/**
 * Requests that somebody already has, turned into saved requests of this project.
 *
 * The thing people actually have is never an OpenAPI document: it is a `curl` in a ticket, a
 * Postman collection a colleague exported, an Insomnia workspace. Until now the only way in was
 * OpenAPI 3.x, so the first five minutes with this tool were spent retyping requests that already
 * worked somewhere else — and a retyped request is a request that reproduces something slightly
 * different from the one that was reported.
 *
 * **What comes out is a request template, never an operation.** That is the rule the whole product
 * rests on: the endpoints are the contract's, and a `curl` that invents one would break the
 * property that makes drift detectable. So every imported request has to *land on* an operation
 * the active contract already declares — matched by method and path — and one that does not is
 * reported by name rather than imported as something new. That report is useful on its own: a
 * collection with four requests the contract does not declare is either a stale collection or an
 * undocumented endpoint, and both are worth knowing.
 *
 * Pure, and in the domain, for the usual reason: a parser is a pile of edge cases — a quoted space,
 * a `{{var}}` inside a path, a collection nested four folders deep — and every one of them is a
 * test that must not need a database.
 */
import type { Operation, RequestAuth } from "@eq/runner-core";
import type { RequestBody } from "@eq/runner-core";
import { isReadable, readPostmanAuth, redactAuth, resolveAuth } from "./postman-auth";

/** One request as it was read, before anything of this project is known about it. */
export type ParsedRequest = {
  /** What the source called it. A `curl` has no name, so it is derived from the method and path. */
  name: string;
  method: string;
  /** Absolute or not — `https://api/x`, `{{base}}/x` and `/x` all arrive here. The matcher only
   * ever reads the path, which is why an unparseable origin is not a reason to reject. */
  url: string;
  headers: Record<string, string>;
  body: RequestBody;
  /** Cómo entra. `inherit` cuando la fuente no dice nada, que es lo que dice Postman. */
  auth: RequestAuth;
  /**
   * Las respuestas que la fuente guardaba para esta petición: los ejemplos.
   *
   * Vive aquí y no en un canal aparte porque es lo mismo que el resto — «lo que el fichero decía de
   * esta petición»— y porque así los dos importadores que la usan, el de endpoints y el de
   * peticiones guardadas, la reciben sin que ninguno tenga un caso especial. Vacío en los formatos
   * que no guardan respuestas, que son todos menos Postman.
   */
  examples: PostmanExample[];
};

/** A request that could not be turned into a template, and why — said in words somebody can act
 * on, because «4 no se importaron» is a number nobody can do anything with. */
export type SkippedRequest = { name: string; method: string; url: string; reason: string };

export type ImportedRequests = { requests: ParsedRequest[]; skipped: SkippedRequest[] };

// -----------------------------------------------------------------------------------------------
// cURL
// -----------------------------------------------------------------------------------------------

/**
 * Splits a command into arguments the way a shell would, and no further.
 *
 * Single quotes are literal, double quotes allow `\"`, and a backslash before a newline continues
 * the line — which is the one piece of shell grammar that matters here, because every `curl`
 * anybody copies out of a browser or a tool is wrapped that way. Nothing is expanded: a `$HOME` in
 * a pasted command is text, and resolving it would mean reading this process's environment on
 * behalf of a string somebody pasted.
 */
export function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && (command[index + 1] === '"' || command[index + 1] === "\\")) {
        current += command[index + 1];
        index += 1;
      } else if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    // A backslash-newline is a continuation and disappears; a backslash before anything else
    // escapes it, which is how a `?` or a `&` survives in an unquoted URL.
    if (char === "\\") {
      if (command[index + 1] === "\n" || (command[index + 1] === "\r" && command[index + 2] === "\n")) {
        index += command[index + 1] === "\r" ? 2 : 1;
        continue;
      }
      if (index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
        started = true;
        continue;
      }
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** Flags that take no value and change nothing about what is sent. Listed rather than inferred
 * from the leading dash, because a flag that *does* take a value would otherwise swallow the URL. */
const IGNORED_FLAGS = new Set([
  "-i",
  "--include",
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "-v",
  "--verbose",
  "--compressed",
  "-f",
  "--fail",
  "-g",
  "--globoff",
  "-N",
  "--no-buffer",
  "--http1.1",
  "--http2",
  "-4",
  "-6",
  "-#",
  "--progress-bar",
]);
/** Flags whose value is deliberately dropped, with their value consumed so it is not read as the
 * URL. */
const DROPPED_WITH_VALUE = new Set([
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-o",
  "--output",
  "--max-time",
  "-m",
  "--connect-timeout",
  "--retry",
  "--proxy",
  "-x",
  "--cert",
  "--key",
  "--cacert",
]);

/**
 * One `curl` command as a request.
 *
 * `null` when there is no URL in it, which is the only thing that makes a command unusable. A flag
 * this does not know is skipped rather than refused: `curl` has upwards of two hundred of them,
 * almost all about the transport, and refusing a command over `--http2` would reject the very
 * commands people paste — the ones a browser's «Copy as cURL» produced.
 */
export function parseCurl(command: string): ParsedRequest | null {
  const tokens = shellSplit(command.trim());
  if (tokens[0] === "curl") tokens.shift();

  let url = "";
  let method = "";
  const headers: Record<string, string> = {};
  const form: Record<string, string> = {};
  const data: string[] = [];
  let urlencodeOnly = false;
  let asQuery = false;
  let basic = "";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => tokens[++index] ?? "";
    if (IGNORED_FLAGS.has(token)) continue;
    if (DROPPED_WITH_VALUE.has(token)) {
      next();
      continue;
    }
    if (token === "-X" || token === "--request") {
      method = next().toUpperCase();
    } else if (token === "-H" || token === "--header") {
      const raw = next();
      const cut = raw.indexOf(":");
      // A header with no colon is not a header. `curl` reads `-H 'X-Foo;'` as «send it empty»;
      // anything else is a line somebody mistyped, and inventing a name for it would be worse
      // than dropping it.
      if (cut > 0) headers[raw.slice(0, cut).trim()] = raw.slice(cut + 1).trim();
    } else if (token === "-F" || token === "--form") {
      const raw = next();
      const cut = raw.indexOf("=");
      if (cut > 0) form[raw.slice(0, cut)] = raw.slice(cut + 1);
    } else if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
      data.push(next());
    } else if (token === "--data-urlencode") {
      data.push(next());
      urlencodeOnly = true;
    } else if (token === "-G" || token === "--get") {
      asQuery = true;
    } else if (token === "-u" || token === "--user") {
      // El usuario se queda; la contraseña la quita `redactAuth`, porque iría a una columna en
      // claro. Antes se tiraban los dos y el `Basic` importado no existía.
      basic = next();
    } else if (token === "-b" || token === "--cookie") {
      headers["Cookie"] = next();
    } else if (token === "--url") {
      url = next();
    } else if (!token.startsWith("-") && !url) {
      url = token;
    } else if (token.startsWith("--") && tokens[index + 1] && !tokens[index + 1].startsWith("-")) {
      // An unknown long flag that looks like it takes a value. Its value is consumed so it cannot
      // be mistaken for the URL, which is the one mistake that turns a good command into a bad
      // request instead of into a skipped one.
      next();
    }
  }

  if (!url) return null;

  // `-G` moves the payload into the query string, which is how people send a filtered GET.
  if (asQuery && data.length) {
    url += (url.includes("?") ? "&" : "?") + data.join("&");
    data.length = 0;
  }

  const payload = data.join("&");
  const declared = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const body = bodyFrom({ form, payload, declared, urlencodeOnly });
  // What `curl` itself infers, and for the same reason: a command with a payload and no `-X` is a
  // POST, and one without is a GET.
  const inferred = method || (body.type === "none" ? "GET" : "POST");

  const cut = basic.indexOf(":");
  const auth: RequestAuth = basic
    ? {
        type: "basic",
        params: { username: cut >= 0 ? basic.slice(0, cut) : basic, password: cut >= 0 ? basic.slice(cut + 1) : "" },
      }
    : { type: "inherit", params: {} };
  return {
    name: `${inferred} ${pathOf(url)}`,
    method: inferred,
    url,
    headers,
    body,
    auth: redactAuth(auth).auth,
    // Un `curl` no guarda respuestas: no hay ejemplos que traer.
    examples: [],
  };
}

function bodyFrom(input: {
  form: Record<string, string>;
  payload: string;
  declared: string;
  urlencodeOnly: boolean;
}): RequestBody {
  if (Object.keys(input.form).length) return { type: "form-data", fields: input.form, disabledFields: {} };
  if (!input.payload) return { type: "none" };
  if (input.declared.includes("x-www-form-urlencoded") || input.urlencodeOnly) {
    const fields = Object.fromEntries(new URLSearchParams(input.payload));
    return { type: "x-www-form-urlencoded", fields, disabledFields: {} };
  }
  // JSON only when it parses **to an object**. A payload that happens to be `"3"` is valid JSON
  // and is not a body this editor can show as a tree, so it stays text — which is also what was
  // sent.
  if (!input.declared || input.declared.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(input.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { type: "json", json: parsed as Record<string, unknown> };
      }
    } catch {
      // Not JSON. Falls through to raw, which is the honest reading of bytes nobody can parse.
    }
  }
  return { type: "raw", text: input.payload, contentType: input.declared || "text/plain" };
}

/**
 * Every `curl` in a blob of text, whether it is one command or a document full of them.
 *
 * The document case is the one worth supporting: what teams keep is a markdown runbook with
 * fifteen fenced commands in it, and importing that one block at a time is the retyping this
 * exists to remove. Fences are stripped and the text is cut at every `curl` that starts a line, so
 * the same function reads a single pasted command, a fenced block, and a whole page of them.
 */
export function parseCurlDocument(text: string): ImportedRequests {
  const withoutFences = text.replace(/^[ \t]*```[^\n]*$/gm, "");
  const commands = withoutFences
    .split(/^(?=[ \t]*curl[ \t\\])/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => /^curl[\s\\]/.test(chunk));

  const requests: ParsedRequest[] = [];
  const skipped: SkippedRequest[] = [];
  for (const command of commands) {
    const parsed = parseCurl(command);
    if (parsed) requests.push(parsed);
    else skipped.push({ name: "curl", method: "", url: "", reason: "el comando no lleva ninguna URL" });
  }
  return { requests, skipped };
}

// -----------------------------------------------------------------------------------------------
// Postman v2.1 and Insomnia
// -----------------------------------------------------------------------------------------------

/**
 * Reading somebody else's export without believing a word of it.
 *
 * Both formats are JSON somebody downloaded from a tool and handed over, so every field is
 * `unknown` until it has been looked at. The alternative — a type assertion over the whole
 * document — is how an export from a version this was not written against becomes a crash while
 * somebody is watching, instead of a list of what could not be read.
 */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A `{ key, value, disabled }` list, which is how both tools store headers, query and form
 * fields. A row somebody switched off there stays off here: it is the same idea and the same
 * reason, and importing it as active would send something nobody asked for. */
function fromKeyValues(list: unknown): { enabled: Record<string, string>; disabled: Record<string, string> } {
  const enabled: Record<string, string> = {};
  const disabled: Record<string, string> = {};
  for (const entry of asArray(list)) {
    const row = asRecord(entry);
    const key = asString(row?.key ?? row?.name).trim();
    if (!row || !key) continue;
    (row.disabled === true ? disabled : enabled)[key] = asString(row.value);
  }
  return { enabled, disabled };
}

/**
 * A Postman collection, v2.1, read whole: its folders, its requests and the scripts beside them.
 *
 * The items nest: a collection is folders of folders of requests, and the depth is whatever its
 * author felt like. Walked rather than flattened by a fixed number of levels, and the folder trail
 * is kept — both because it names the request (`Pedidos / Alta / Crear` is what makes two requests
 * both called «Crear» tellable apart in a list of forty) and because a folder is the closest thing
 * a collection has to a flow.
 *
 * The `event` blocks come too. They are the point of the whole format for anybody who has written
 * tests in it: a `prerequest` that fills a variable and a `test` that asserts over the answer are
 * what turns a pile of requests into a scenario, and a reader that dropped them would leave the
 * only part nobody can retype.
 *
 * Postman's own `{{variables}}` are left exactly as they are. They are the same syntax this engine
 * interpolates, so a collection written against `{{baseUrl}}` and `{{token}}` arrives working, and
 * rewriting them would break the one thing that already lines up.
 */
export type PostmanItem = {
  /** The folders it hangs under, outermost first. Empty for a request at the root. */
  trail: string[];
  /** What the collection calls it, without its trail. */
  name: string;
  /** The trail and the name joined — the label every importer uses. */
  label: string;
  request: ParsedRequest;
  /** The `prerequest` script's code, or empty. */
  prerequest: string;
  /** The `test` script's code, or empty. */
  test: string;
};

/**
 * Una respuesta guardada de una colección.
 *
 * Postman guarda el par entero: la respuesta y, en `originalRequest`, la petición que la produjo,
 * que puede diferir de la petición actual del `item` —es justo el caso interesante, porque un
 * ejemplo de 422 se guardó con un cuerpo inválido a propósito—. Cuando no la trae, se entiende que
 * es la del `item`, que es lo que hace Postman al enseñarla.
 */
export type PostmanExample = {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  request: { method: string; url: string; headers: Record<string, string>; body: string; contentType: string } | null;
};

/** Una credencial que venía escrita en el fichero y no se guarda. Se nombra para poder decirlo. */
export type DroppedSecret = { label: string; type: string; params: string[] };

export type PostmanCollection = {
  name: string;
  items: PostmanItem[];
  skipped: SkippedRequest[];
  /** Los secretos literales que traía el fichero y que no se guardan en claro. */
  secrets: DroppedSecret[];
  /** The scripts the collection itself declares, which Postman runs around **every** request. */
  scripts: { prerequest: string; test: string };
};

/** `null` when the text is not JSON, which is the one thing a reader cannot work around. */
export function readPostmanCollection(text: string): PostmanCollection | null {
  const document = asRecord(safeJson(text));
  if (!document) return null;

  const items: PostmanItem[] = [];
  const skipped: SkippedRequest[] = [];
  const secrets: DroppedSecret[] = [];

  // La autenticación de la colección y la de cada carpeta por la que se baja: una petición sin
  // bloque propio hereda la de la carpeta más cercana que tenga uno, y si no, la de la colección.
  const ownAuth = (value: unknown): RequestAuth | null => {
    const read = readPostmanAuth(value);
    return read && isReadable(read) ? read : null;
  };
  const collectionAuth = ownAuth(document.auth);

  const walk = (entries: unknown[], trail: string[], folderAuth: (RequestAuth | null)[]) => {
    for (const entry of entries) {
      const item = asRecord(entry);
      if (!item) continue;
      const name = asString(item.name);
      if (Array.isArray(item.item)) {
        walk(item.item, name ? [...trail, name] : trail, [...folderAuth, ownAuth(item.auth)]);
        continue;
      }
      const request = asRecord(item.request);
      if (!request) continue;
      const label = [...trail, name].filter(Boolean).join(" / ") || "Sin nombre";
      const url = postmanUrl(request.url);
      if (!url) {
        skipped.push({ name: label, method: asString(request.method), url: "", reason: "la petición no lleva URL" });
        continue;
      }
      const headers = fromKeyValues(request.header);
      const own = readPostmanAuth(request.auth);
      if (own && !isReadable(own)) {
        skipped.push({
          name: label,
          method: asString(request.method),
          url,
          reason: `usa una autenticación «${own.unsupported}» que este lector no conoce`,
        });
        continue;
      }
      const resolved = redactAuth(resolveAuth(own, { collection: collectionAuth, folders: folderAuth }));
      if (resolved.dropped.length) {
        secrets.push({ label, params: resolved.dropped, type: resolved.auth.type });
      }
      items.push({
        trail,
        name: name || "Sin nombre",
        label,
        request: {
          name: label,
          method: (asString(request.method) || "GET").toUpperCase(),
          url,
          headers: headers.enabled,
          body: postmanBody(request.body, headers.enabled),
          auth: resolved.auth,
          examples: postmanExamples(item.response),
        },
        prerequest: eventScript(item.event, "prerequest"),
        test: eventScript(item.event, "test"),
      });
    }
  };

  walk(asArray(document.item), [], []);
  return {
    name: asString(asRecord(document.info)?.name),
    items,
    skipped,
    secrets,
    scripts: { prerequest: eventScript(document.event, "prerequest"), test: eventScript(document.event, "test") },
  };
}

/** El `Content-Type` que Postman implica cuando anota el lenguaje de un cuerpo en vez del tipo. */
const LANGUAGE_TYPES: Record<string, string> = {
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  text: "text/plain",
};

/**
 * Las respuestas guardadas de un `item`, leídas como ejemplos.
 *
 * El `Content-Type` sale de las cabeceras de la respuesta cuando está, y si no de
 * `_postman_previewlanguage`, que es lo que Postman anota cuando el servidor no lo dijo. Sin
 * ninguno de los dos se queda en `text/plain`: inventar `application/json` haría que el lector de
 * cuerpos intentara parsear un HTML y lo diera por roto.
 *
 * Un ejemplo sin código de estado se descarta. Es el único campo del que no hay valor por defecto
 * honesto: un ejemplo que dice «200» sin que el fichero lo dijera es una afirmación inventada sobre
 * la API de alguien, y es exactamente lo que alguien va a leer como contrato.
 */
function postmanExamples(value: unknown): PostmanExample[] {
  const examples: PostmanExample[] = [];
  for (const entry of asArray(value)) {
    const row = asRecord(entry);
    if (!row) continue;
    const status = Number(row.code);
    if (!Number.isInteger(status) || status < 100 || status > 599) continue;

    const headers = fromKeyValues(row.header).enabled;
    const declared = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
    // `_postman_previewlanguage` es la cadena suelta («json», «html»), no el `{ language }` que
    // lleva un cuerpo de petición: se busca directo en la tabla.
    const contentType =
      declared || LANGUAGE_TYPES[asString(row._postman_previewlanguage).toLowerCase()] || "text/plain";

    const original = asRecord(row.originalRequest);
    const originalHeaders = original ? fromKeyValues(original.header).enabled : {};
    const originalBody = original ? asString(asRecord(original.body)?.raw) : "";

    examples.push({
      name: asString(row.name),
      status,
      headers,
      body: asString(row.body),
      contentType,
      request: original
        ? {
            method: (asString(original.method) || "GET").toUpperCase(),
            url: postmanUrl(original.url),
            headers: originalHeaders,
            body: originalBody,
            contentType:
              Object.entries(originalHeaders).find(([name]) => name.toLowerCase() === "content-type")?.[1] ??
              "application/json",
          }
        : null,
    });
  }
  return examples;
}

/**
 * The code of one `event` of an item.
 *
 * `script.exec` is an array of lines, which is how Postman stores every script it wrote itself; a
 * string is what a hand-edited file or an older export carries. `src` is an *external* script — a
 * URL Postman fetches — and is deliberately not read: following it would mean this importer making
 * a request on behalf of a pasted file.
 */
function eventScript(events: unknown, listen: string): string {
  for (const entry of asArray(events)) {
    const event = asRecord(entry);
    if (!event || asString(event.listen) !== listen || event.disabled === true) continue;
    const exec = asRecord(event.script)?.exec;
    const code = Array.isArray(exec) ? exec.map(asString).join("\n") : asString(exec);
    if (code.trim()) return code;
  }
  return "";
}

/** The requests of a collection, which is all the importers of saved requests and of endpoints
 * need: the folders and the scripts are the flow importer's business. */
export function parsePostmanCollection(text: string): ImportedRequests {
  const read = readPostmanCollection(text);
  if (!read) return { requests: [], skipped: [{ name: "", method: "", url: "", reason: "el fichero no es JSON" }] };
  // Los secretos que no se guardan se cuentan como avisos, no como peticiones perdidas: la
  // petición sí se importó, y lo que falta es un valor que su autor tiene que poner en una variable.
  return { requests: read.items.map((item) => item.request), skipped: read.skipped };
}

/** Postman stores a URL either as the string somebody typed or as the parsed object it made of
 * it. The string is the one to trust when both are there: the object is its reading of the string,
 * and a `{{base}}` survives the first and gets scattered across `host` by the second. */
function postmanUrl(value: unknown): string {
  if (typeof value === "string") return value;
  const url = asRecord(value);
  if (!url) return "";
  if (typeof url.raw === "string" && url.raw) return url.raw;
  const host = asArray(url.host).map(asString).join(".");
  const path = asArray(url.path).map(asString).join("/");
  return [host, path].filter(Boolean).join("/");
}

function postmanBody(value: unknown, headers: Record<string, string>): RequestBody {
  const body = asRecord(value);
  if (!body) return { type: "none" };
  const mode = asString(body.mode);
  if (mode === "urlencoded" || mode === "formdata") {
    const fields = fromKeyValues(body[mode]);
    const type = mode === "urlencoded" ? "x-www-form-urlencoded" : "form-data";
    return { type, fields: fields.enabled, disabledFields: fields.disabled };
  }
  if (mode !== "raw") return { type: "none" };
  const raw = asString(body.raw);
  if (!raw.trim()) return { type: "none" };
  // Postman keeps the language of a raw body next to it, which is the only hint about what it is —
  // and the `Content-Type` header, when the collection set one, is a better one.
  const declared =
    Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ??
    languageContentType(asRecord(body.options)?.raw);
  return bodyFrom({ form: {}, payload: raw, declared, urlencodeOnly: false });
}

const languageContentType = (options: unknown): string =>
  LANGUAGE_TYPES[asString(asRecord(options)?.language).toLowerCase()] ?? "";

/**
 * An Insomnia export, v4.
 *
 * A flat `resources` array where everything — workspaces, folders, environments, requests — is a
 * row with a `_type`, and the tree is rebuilt from `parentId`. Only the requests are read, and
 * their folder names are joined the same way Postman's are, so a list of imported requests reads
 * identically whichever tool it came from.
 *
 * Insomnia's own template syntax is `{% raw %}{{ _.base }}{% endraw %}`, which this leaves alone:
 * it is not this engine's syntax and rewriting it would be guessing at what somebody's environment
 * called things. The path still matches, because the matcher reads segments and a templated origin
 * is not one.
 */
export function parseInsomniaExport(text: string): ImportedRequests {
  const document = asRecord(safeJson(text));
  if (!document) return { requests: [], skipped: [{ name: "", method: "", url: "", reason: "el fichero no es JSON" }] };

  const resources = asArray(document.resources)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => !!row);
  const names = new Map<string, { name: string; parentId: string }>();
  for (const row of resources) {
    if (asString(row._type) === "request_group" || asString(row._type) === "workspace") {
      names.set(asString(row._id), { name: asString(row.name), parentId: asString(row.parentId) });
    }
  }
  const trailOf = (parentId: string): string[] => {
    const trail: string[] = [];
    const seen = new Set<string>();
    let current = parentId;
    // A cycle cannot happen in a valid export and costs nothing to survive; an import that hangs
    // on a malformed file is worse than one that reads it shallowly.
    while (current && names.has(current) && !seen.has(current)) {
      seen.add(current);
      const node = names.get(current)!;
      // The workspace is the file itself, so its name is not part of any request's name.
      if (node.name && node.parentId) trail.unshift(node.name);
      current = node.parentId;
    }
    return trail;
  };

  const requests: ParsedRequest[] = [];
  const skipped: SkippedRequest[] = [];
  for (const row of resources) {
    if (asString(row._type) !== "request") continue;
    const label = [...trailOf(asString(row.parentId)), asString(row.name)].filter(Boolean).join(" / ") || "Sin nombre";
    const url = asString(row.url);
    const method = (asString(row.method) || "GET").toUpperCase();
    if (!url) {
      skipped.push({ name: label, method, url: "", reason: "la petición no lleva URL" });
      continue;
    }
    const headers = fromKeyValues(row.headers);
    const query = fromKeyValues(row.parameters);
    const search = new URLSearchParams(Object.entries(query.enabled)).toString();
    requests.push({
      name: label,
      method,
      // Insomnia keeps the query out of the URL, in `parameters`. Folded back in here so the
      // matcher and the template see one URL, which is what every other source hands over.
      url: search ? `${url}${url.includes("?") ? "&" : "?"}${search}` : url,
      headers: headers.enabled,
      body: insomniaBody(row.body, headers.enabled),
      auth: redactAuth(insomniaAuth(row.authentication)).auth,
      // Insomnia tampoco guarda respuestas junto a la petición.
      examples: [],
    });
  }
  return { requests, skipped };
}

/**
 * La autenticación de Insomnia, que usa otros nombres para lo mismo.
 *
 * `disabled: true` es «déjala escrita pero no la mandes», que es `inherit` aquí y no `none`: `none`
 * significaría que esta petición decide no autenticarse, y lo que dice el fichero es otra cosa.
 */
function insomniaAuth(value: unknown): RequestAuth {
  const block = asRecord(value);
  if (!block || block.disabled === true) return { type: "inherit", params: {} };
  const type = asString(block.type).toLowerCase();
  const pick = (...names: string[]): Record<string, string> => {
    const params: Record<string, string> = {};
    for (const name of names) params[name] = asString(block[name]);
    return params;
  };
  switch (type) {
    case "basic":
      return { type: "basic", params: pick("username", "password") };
    case "bearer":
      return { type: "bearer", params: { token: asString(block.token), headerPrefix: asString(block.prefix) } };
    case "digest":
      return { type: "digest", params: pick("username", "password") };
    case "apikey":
      return { type: "apikey", params: { key: asString(block.key), value: asString(block.value), in: asString(block.addTo) || "header" } };
    case "oauth2":
      return {
        type: "oauth2",
        params: {
          accessToken: asString(block.accessToken),
          accessTokenUrl: asString(block.accessTokenUrl),
          clientId: asString(block.clientId),
          clientSecret: asString(block.clientSecret),
          scope: asString(block.scope),
          grantType: asString(block.grantType) === "password" ? "password_credentials" : "client_credentials",
        },
      };
    case "hawk":
      return { type: "hawk", params: { authId: asString(block.id), authKey: asString(block.key), algorithm: asString(block.algorithm) || "sha256" } };
    case "awsiam":
      return { type: "awsv4", params: { accessKey: asString(block.accessKeyId), secretKey: asString(block.secretAccessKey), sessionToken: asString(block.sessionToken) } };
    case "ntlm":
      return { type: "ntlm", params: pick("username", "password") };
    default:
      return { type: "inherit", params: {} };
  }
}

function insomniaBody(value: unknown, headers: Record<string, string>): RequestBody {
  const body = asRecord(value);
  if (!body) return { type: "none" };
  const mime = asString(body.mimeType);
  if (mime.includes("form-urlencoded") || mime.includes("form-data")) {
    const fields = fromKeyValues(body.params);
    const type = mime.includes("form-data") ? "form-data" : "x-www-form-urlencoded";
    return { type, fields: fields.enabled, disabledFields: fields.disabled };
  }
  const raw = asString(body.text);
  if (!raw.trim()) return { type: "none" };
  const declared = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] || mime;
  return bodyFrom({ form: {}, payload: raw, declared, urlencodeOnly: false });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------------------------
// Matching a request against the contract
// -----------------------------------------------------------------------------------------------

/**
 * The path of a URL, whatever shape the URL arrived in.
 *
 * Written by hand rather than with `new URL`, which throws on `{{base}}/pedidos` — the shape every
 * Postman export uses, and the one this has to read. Three cases, and telling them apart is the
 * whole job:
 *
 * - `https://api/x` — the origin ends at the first `/` after the `//`.
 * - `/x` — already a path.
 * - `{{base}}/x` or `api.ejemplo.com/x` — no scheme, and the first segment is still the host. A
 *   variable or something with a dot in it is a host; anything else is a path segment somebody
 *   wrote without its leading slash.
 */
export function pathOf(url: string): string {
  const withoutQuery = url.split("#")[0].split("?")[0];
  const afterScheme = withoutQuery.replace(/^[a-zA-Z][\w+.-]*:\/\//, "");
  if (withoutQuery !== afterScheme) {
    const slash = afterScheme.indexOf("/");
    return slash === -1 ? "/" : afterScheme.slice(slash);
  }
  if (withoutQuery.startsWith("/")) return withoutQuery;

  const slash = afterScheme.indexOf("/");
  const head = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const isHost = /^\{\{[^}]+\}\}$/.test(head) || /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?$/.test(head);
  if (!isHost) return `/${afterScheme}`;
  return slash === -1 ? "/" : afterScheme.slice(slash);
}

/** The query string as a map, or empty. Repeated names keep the last, like every other map in
 * this product. */
export function queryOf(url: string): Record<string, string> {
  const cut = url.indexOf("?");
  if (cut === -1) return {};
  return Object.fromEntries(
    new URLSearchParams(url.slice(cut + 1, url.indexOf("#") === -1 ? undefined : url.indexOf("#"))),
  );
}

export type OperationMatch = { operation: Operation; parameters: Record<string, string> };

/**
 * The operation a request lands on, and what its path placeholders were filled with.
 *
 * Matched from the **end** of the path, so a request written against `https://host/api/v1/pedidos`
 * still finds `/pedidos`: an exported collection carries whatever base URL its author used, and
 * this project's contract declares paths relative to a base the environment holds. Requiring the
 * two to agree would reject almost every real collection for a prefix nobody typed.
 *
 * Between two operations that both match, the one with **fewer placeholders** wins: `/widgets/new`
 * is a better reading of `GET /widgets/new` than `/widgets/{id}` is, and a literal segment is
 * always more specific than a variable that happens to accept it.
 */
export function matchOperation(request: ParsedRequest, operations: Operation[]): OperationMatch | null {
  const segments = pathOf(request.url).split("/").filter(Boolean);
  const candidates: OperationMatch[] = [];

  for (const operation of operations) {
    if (operation.method !== request.method) continue;
    const template = operation.path.split("/").filter(Boolean);
    if (template.length > segments.length) continue;
    // From the end: the extra segments at the front are the base path the collection carried.
    const tail = segments.slice(segments.length - template.length);
    const parameters: Record<string, string> = {};
    const fits = template.every((part, index) => {
      const placeholder = /^\{(.+)\}$/.exec(part);
      if (!placeholder) return part === tail[index];
      parameters[placeholder[1]] = decodeURIComponent(tail[index]);
      return true;
    });
    if (fits) candidates.push({ operation, parameters });
  }

  if (!candidates.length) return null;
  return candidates.sort((left, right) => placeholders(left.operation.path) - placeholders(right.operation.path))[0];
}

const placeholders = (path: string): number => (path.match(/\{/g) ?? []).length;

/**
 * The status an imported request expects.
 *
 * From the **contract** and not from a constant, because the contract is what this product treats
 * as the truth: the lowest success code the operation declares is what it says a working call
 * answers. A hardcoded 200 would make every imported POST fail its first run against an API that
 * correctly answers 201, and the report would blame the endpoint.
 */
export function expectedStatusFor(operation: Operation): number {
  const success = operation.statuses.filter((status) => status >= 200 && status < 300).sort((a, b) => a - b);
  return success[0] ?? 200;
}
