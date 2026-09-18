/**
 * The process a script runs in. Started for one script, killed or exited right after.
 *
 * It imports nothing but `node:vm` — this file runs with no environment, no file system beyond
 * itself and no path aliases, and anything it required would have to survive all three.
 *
 * Inside the process there is a second wall: the script runs in a `vm` context that holds **no
 * object from this side**. The whole `pm` API is built by {@link prelude} from inside the context,
 * out of the context's own `Object` and `Function`, and the input reaches it as one JSON string. So
 * there is no host function whose `constructor` a script could climb — and if it found one, code
 * generation from strings is off for the whole isolate.
 */
import { Script, createContext } from "node:vm";

type Limits = {
  scriptMs: number;
  maxLogs: number;
  maxLineLength: number;
  maxTests: number;
  maxValueLength: number;
  maxTemplateLength: number;
  maxVisualizationData: number;
};

const SCRIPT_FILE = "script.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Runs **inside** the context, from its source text: it must not reference anything outside its
 * own body. Everything a script can touch is defined here.
 */
function prelude(global: any): void {
  "use strict";
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const assign = Object.assign;
  const keys = Object.keys;
  const freeze = Object.freeze;

  const input = parse(global.__input);
  delete global.__input;
  const limits = input.limits;
  const pre = input.phase === "pre";
  const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

  const logs: any[] = [];
  const tests: any[] = [];
  const values = assign(Object.create(null), input.environment.values);
  const environmentSet = Object.create(null);
  const environmentUnset = Object.create(null);
  const locals = assign(Object.create(null), input.variables);
  const localSet = Object.create(null);
  const headers = assign(Object.create(null), input.request.headers);

  class AssertionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AssertionError";
    }
  }

  const compact = (value: any): string => {
    if (value === undefined) return "undefined";
    try {
      const text = stringify(value);
      return (text === undefined ? String(value) : text).slice(0, 200);
    } catch {
      return String(value).slice(0, 200);
    }
  };
  const show = (value: any): string => {
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value;
    try {
      const text = stringify(value, null, 2);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const write = (level: string, args: any[]) => {
    if (logs.length >= limits.maxLogs) return;
    logs[logs.length] = { level, text: args.map(show).join(" ").slice(0, limits.maxLineLength) };
  };
  const variableName = (key: any): string => {
    const text = String(key);
    if (!NAME.test(text)) throw new TypeError(`Nombre de variable no válido: «${text}»`);
    return text;
  };
  const text = (value: any): string => String(value ?? "").slice(0, limits.maxValueLength);

  const environment = freeze({
    name: input.environment.name,
    get: (key: any) => (String(key) in values ? values[String(key)] : undefined),
    has: (key: any) => String(key) in values,
    set: (key: any, value: any) => {
      const name = variableName(key);
      values[name] = text(value);
      environmentSet[name] = values[name];
      delete environmentUnset[name];
    },
    unset: (key: any) => {
      const name = variableName(key);
      delete values[name];
      delete environmentSet[name];
      environmentUnset[name] = true;
    },
    toObject: () => assign({}, values),
  });

  const variables = freeze({
    get: (key: any) => {
      const name = String(key);
      return name in locals ? locals[name] : name in values ? values[name] : undefined;
    },
    has: (key: any) => String(key) in locals || String(key) in values,
    set: (key: any, value: any) => {
      const name = variableName(key);
      locals[name] = text(value);
      localSet[name] = locals[name];
    },
    /**
     * Forgets a request-scoped name, and **only** that.
     *
     * `pm.environment.unset` reaches the stored environment; this one deliberately does not, which
     * is the difference between the two stores. The cost is that a name this clears is still known
     * to later steps of the same run — the honest price of not letting an imported cleanup script
     * empty a variable somebody's environment actually holds.
     */
    unset: (key: any) => {
      const name = variableName(key);
      delete locals[name];
      delete localSet[name];
    },
    toObject: () => assign({}, values, locals),
  });

  /**
   * A read-only header bag that answers both ways.
   *
   * Postman's own is a `HeaderList` with `.get(name)`, and a collection written against it — every
   * collection that asserts a `Content-Type` — calls that method. A frozen plain object is what
   * reads better for everything else (`headers["content-type"]`), and a script that had to know
   * which of the two this is would be a script that only runs here. Both, then: the map's own keys
   * plus `get`/`has`, case-insensitive, because that is what an HTTP header name is.
   */
  const readableHeaders = (map: Record<string, string>) => {
    const find = (key: any) => keys(map).find((name) => name.toLowerCase() === String(key).toLowerCase());
    return freeze(
      assign({}, map, {
        get: (key: any) => {
          const found = find(key);
          return found === undefined ? undefined : map[found];
        },
        has: (key: any) => find(key) !== undefined,
        toObject: () => assign({}, map),
      }),
    );
  };

  const findHeader = (key: any) => keys(headers).find((name) => name.toLowerCase() === String(key).toLowerCase());
  const headerEdit = (header: any): [string, string] => {
    if (!pre) throw new TypeError("Las cabeceras solo se cambian en el script previo");
    const name = String(header?.key ?? "").trim();
    const value = text(header?.value);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError(`Nombre de cabecera no válido: «${name}»`);
    if (/[\r\n]/.test(value)) throw new TypeError("Una cabecera no lleva saltos de línea");
    return [name, value];
  };
  const headerList = freeze({
    get: (key: any) => {
      const found = findHeader(key);
      return found === undefined ? undefined : headers[found];
    },
    has: (key: any) => findHeader(key) !== undefined,
    add: (header: any) => {
      const [name, value] = headerEdit(header);
      headers[name] = value;
    },
    upsert: (header: any) => {
      const [name, value] = headerEdit(header);
      const found = findHeader(name);
      if (found !== undefined) delete headers[found];
      headers[name] = value;
    },
    remove: (key: any) => {
      headerEdit({ key, value: "" });
      const found = findHeader(key);
      if (found !== undefined) delete headers[found];
    },
    toObject: () => assign({}, headers),
  });

  /**
   * The URL as the string it is, plus the `query` a collection reads off it.
   *
   * `pm.request.url` is a string here and has to stay one: it is interpolated, logged and compared
   * as text all over. Postman's is an object with a parsed `query`, and the assertion people write
   * with it — «`links.self` echoes the parameters that were sent» — is one of the most common
   * things in a generated collection. A `String` object carries both: it still behaves as its text
   * everywhere, and it answers `.query` with the `{ key, value }` rows Postman would give.
   */
  const urlOf = (raw: string) => {
    const url: any = new String(raw);
    const cut = raw.indexOf("?");
    const search = cut === -1 ? "" : raw.slice(cut + 1).split("#")[0];
    url.query = freeze(
      search
        ? search
            .split("&")
            .filter((pair: string) => pair)
            .map((pair: string) => {
              const equals = pair.indexOf("=");
              const name = equals === -1 ? pair : pair.slice(0, equals);
              const value = equals === -1 ? "" : pair.slice(equals + 1);
              // `disabled` is always false: a row Postman had switched off never reached the URL,
              // so what is here is what was sent — which is the question the assertion asks.
              return freeze({ key: name, value, disabled: false });
            })
        : [],
    );
    url.getQueryString = () => search;
    return freeze(url);
  };

  const request = freeze({
    method: input.request.method,
    url: urlOf(String(input.request.url ?? "")),
    body: input.request.body,
    headers: headerList,
  });

  const typeName = (value: any) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);
  const deepEqual = (left: any, right: any): boolean => {
    if (Object.is(left, right)) return true;
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const leftKeys = keys(left);
    const rightKeys = keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
    );
  };

  const chain = (actual: any, negate: boolean, quantifier: "all" | "any" = "all"): any => {
    const api: any = {};
    const check = (ok: boolean, message: string) => {
      if (ok === negate) throw new AssertionError(`${negate ? "no se esperaba" : "se esperaba"} ${message}`);
      return api;
    };
    const words = [
      "to",
      "be",
      "been",
      "is",
      "that",
      "which",
      "and",
      "has",
      "have",
      "with",
      "at",
      "of",
      "same",
      "does",
      "deep",
      "also",
    ];
    for (const word of words) Object.defineProperty(api, word, { get: () => api });
    Object.defineProperty(api, "not", { get: () => chain(actual, !negate, quantifier) });
    // `all` and `any` are what `keys` below reads: `to.have.all.keys(a, b)` is «exactamente esas»
    // and `to.have.any.keys(a, b)` is «al menos una». Two words that mean opposite assertions, so
    // they cannot be noise — a chain that ignored them would turn one into the other.
    Object.defineProperty(api, "all", { get: () => chain(actual, negate, "all") });
    Object.defineProperty(api, "any", { get: () => chain(actual, negate, "any") });
    const getters: [string, () => boolean, string][] = [
      ["true", () => actual === true, "true"],
      ["false", () => actual === false, "false"],
      ["null", () => actual === null, "null"],
      ["undefined", () => actual === undefined, "undefined"],
      ["ok", () => Boolean(actual), "un valor verdadero"],
      ["exist", () => actual !== null && actual !== undefined, "un valor"],
      ["NaN", () => Number.isNaN(actual), "NaN"],
      [
        "empty",
        () =>
          typeof actual === "string" || Array.isArray(actual)
            ? actual.length === 0
            : actual !== null && typeof actual === "object" && keys(actual).length === 0,
        "vacío",
      ],
    ];
    for (const [word, test, expected] of getters)
      Object.defineProperty(api, word, { get: () => check(test(), `${expected} y llegó ${compact(actual)}`) });

    api.equal =
      api.equals =
      api.eq =
        (expected: any) => check(actual === expected, `${compact(expected)} y llegó ${compact(actual)}`);
    api.eql = api.eqls = (expected: any) =>
      check(deepEqual(actual, expected), `${compact(expected)} y llegó ${compact(actual)}`);
    api.a = api.an = (type: any) =>
      check(typeName(actual) === String(type).toLowerCase(), `un ${String(type)} y llegó ${typeName(actual)}`);
    api.include =
      api.includes =
      api.contain =
      api.contains =
        (item: any) => {
          const ok =
            typeof actual === "string"
              ? actual.includes(String(item))
              : Array.isArray(actual)
                ? actual.some((element) => deepEqual(element, item))
                : actual !== null && typeof actual === "object" && item !== null && typeof item === "object"
                  ? keys(item).every((key) => deepEqual(actual[key], item[key]))
                  : false;
          return check(ok, `que ${compact(actual)} incluyera ${compact(item)}`);
        };
    api.property = function (name: any, ...value: any[]) {
      const has = actual !== null && actual !== undefined && Object.prototype.hasOwnProperty.call(Object(actual), name);
      const ok = value.length ? has && deepEqual(actual[name], value[0]) : has;
      return check(ok, `la propiedad «${String(name)}»${value.length ? ` con ${compact(value[0])}` : ""}`);
    };
    api.keys = api.key = (...expected: any[]) => {
      const wanted = (expected.length === 1 && Array.isArray(expected[0]) ? expected[0] : expected).map(String);
      const present = actual !== null && typeof actual === "object" ? keys(actual) : [];
      const ok =
        quantifier === "any"
          ? wanted.some((name) => present.indexOf(name) !== -1)
          : wanted.every((name) => present.indexOf(name) !== -1) && present.length === wanted.length;
      return check(
        ok,
        `${quantifier === "any" ? "alguna de las claves" : "exactamente las claves"} ${compact(wanted)} y llegó ${compact(present)}`,
      );
    };
    api.lengthOf = (length: any) =>
      check(actual?.length === length, `longitud ${String(length)} y llegó ${String(actual?.length)}`);
    api.above =
      api.gt =
      api.greaterThan =
        (limit: any) => check(actual > limit, `más de ${compact(limit)} y llegó ${compact(actual)}`);
    api.below =
      api.lt =
      api.lessThan =
        (limit: any) => check(actual < limit, `menos de ${compact(limit)} y llegó ${compact(actual)}`);
    api.least = api.gte = (limit: any) =>
      check(actual >= limit, `al menos ${compact(limit)} y llegó ${compact(actual)}`);
    api.most = api.lte = (limit: any) =>
      check(actual <= limit, `como mucho ${compact(limit)} y llegó ${compact(actual)}`);
    api.match = api.matches = (pattern: any) =>
      check(
        pattern instanceof RegExp && pattern.test(String(actual)),
        `que ${compact(actual)} cumpliera ${String(pattern)}`,
      );
    api.oneOf = (list: any) =>
      check(
        Array.isArray(list) && list.some((item) => deepEqual(item, actual)),
        `uno de ${compact(list)} y llegó ${compact(actual)}`,
      );
    return api;
  };
  const expect = (actual: any) => chain(actual, false);

  const test = (name: any, fn: any) => {
    if (tests.length >= limits.maxTests) return;
    const entry = { name: String(name), passed: true, message: null as string | null };
    try {
      if (typeof fn === "function") fn();
    } catch (error: any) {
      entry.passed = false;
      entry.message = error && typeof error.message === "string" ? error.message : String(error);
    }
    tests[tests.length] = entry;
  };

  /**
   * `pm.visualizer.set(template, data, options)`: a Handlebars template and the data it renders.
   *
   * Nothing is rendered here. Both leave the process as text and the browser renders them in a
   * sandboxed frame, which is where Postman renders them too. The data is serialized now, at the
   * call: what the frame shows is what the script handed over, not what it mutated afterwards.
   */
  let visualization: { template: string; data: string; options: string } | null = null;
  const serialized = (value: any, what: string, limit: number): string => {
    let json: string | undefined;
    try {
      json = stringify(value);
    } catch {
      throw new TypeError(`${what} del visualizador no se pueden pasar a JSON`);
    }
    if (json === undefined) json = "null";
    if (json.length > limit) throw new RangeError(`${what} del visualizador pasan de ${limit} caracteres`);
    return json;
  };
  const visualizer = freeze({
    set: (template: any, data: any, options: any) => {
      if (pre) throw new TypeError("pm.visualizer solo existe en el script posterior");
      const source = String(template ?? "");
      if (source.length > limits.maxTemplateLength)
        throw new RangeError(`La plantilla del visualizador pasa de ${limits.maxTemplateLength} caracteres`);
      visualization = {
        template: source,
        data: serialized(data === undefined ? {} : data, "Los datos", limits.maxVisualizationData),
        options: serialized(options === undefined || options === null ? {} : options, "Las opciones", 10_000),
      };
    },
    clear: () => {
      visualization = null;
    },
  });

  const raw = input.response;
  const noResponse = (method: string) => () => {
    throw new TypeError(`pm.response.${method} solo existe en el script posterior`);
  };
  const responseAssertions = freeze({
    have: freeze({
      status: (code: any) => {
        if (!raw) noResponse("to.have.status")();
        if (raw.status !== code)
          throw new AssertionError(`se esperaba el estado ${String(code)} y llegó ${raw.status}`);
      },
      header: (key: any) => {
        if (!raw) noResponse("to.have.header")();
        if (!keys(raw.headers).some((name) => name.toLowerCase() === String(key).toLowerCase()))
          throw new AssertionError(`se esperaba la cabecera «${String(key)}»`);
      },
    }),
  });
  const response = raw
    ? freeze({
        code: raw.status,
        status: raw.status,
        statusCode: raw.status,
        responseTime: raw.durationMs,
        headers: readableHeaders(raw.headers),
        text: () => raw.body,
        json: () => {
          try {
            return parse(raw.body);
          } catch {
            throw new SyntaxError("La respuesta no es JSON");
          }
        },
        to: responseAssertions,
      })
    : null;
  const emptyResponse = freeze({
    code: 0,
    status: 0,
    statusCode: 0,
    responseTime: 0,
    headers: readableHeaders({}),
    text: noResponse("text()"),
    json: noResponse("json()"),
    to: responseAssertions,
  });

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const btoa = (value: any): string => {
    const source = String(value);
    let out = "";
    for (let index = 0; index < source.length; index += 3) {
      const a = source.charCodeAt(index);
      const b = index + 1 < source.length ? source.charCodeAt(index + 1) : 0;
      const c = index + 2 < source.length ? source.charCodeAt(index + 2) : 0;
      if (a > 255 || b > 255 || c > 255) throw new TypeError("btoa: carácter fuera de Latin-1");
      const bits = (a << 16) | (b << 8) | c;
      out +=
        ALPHABET[(bits >> 18) & 63] +
        ALPHABET[(bits >> 12) & 63] +
        (index + 1 < source.length ? ALPHABET[(bits >> 6) & 63] : "=") +
        (index + 2 < source.length ? ALPHABET[bits & 63] : "=");
    }
    return out;
  };
  const atob = (value: any): string => {
    const source = String(value).replace(/[\s=]+/g, "");
    let out = "";
    let buffer = 0;
    let bits = 0;
    for (const character of source) {
      const digit = ALPHABET.indexOf(character);
      if (digit < 0) throw new TypeError("atob: base64 no válido");
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 255);
        buffer &= (1 << bits) - 1;
      }
    }
    return out;
  };
  const randomUUID = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const digit = Math.floor(Math.random() * 16);
      return (character === "x" ? digit : (digit & 3) | 8).toString(16);
    });

  const consoleApi = freeze({
    log: (...args: any[]) => write("log", args),
    info: (...args: any[]) => write("info", args),
    debug: (...args: any[]) => write("log", args),
    warn: (...args: any[]) => write("warn", args),
    error: (...args: any[]) => write("error", args),
  });

  const pm = freeze({
    environment,
    variables,
    // Postman keeps four stores — environment, collection, globals, request-scoped — and a run of
    // this engine has **one** flat map of variables, which is the whole reason `{{name}}` resolves
    // the same everywhere. So the two stores a collection reaches for are the request-scoped one:
    // `get` already falls back to what the run knows, and `set` writes where a later step reads.
    //
    // Not aliases of `environment`, deliberately: in an endpoint script `pm.environment.set`
    // *persists* to the stored environment, and a collection variable is not something Postman ever
    // wrote there. A script that filled forty of them would otherwise leave forty rows behind.
    collectionVariables: variables,
    globals: variables,
    request,
    response: response ?? emptyResponse,
    test,
    expect,
    visualizer,
    info: freeze({ eventName: pre ? "prerequest" : "test" }),
  });

  const globals: Record<string, unknown> = {
    pm,
    env: environment,
    request,
    response,
    console: consoleApi,
    log: (...args: any[]) => write("log", args),
    btoa,
    atob,
    crypto: freeze({ randomUUID }),
  };
  for (const name of keys(globals))
    Object.defineProperty(global, name, { value: globals[name], writable: false, configurable: false });

  Object.defineProperty(global, "__finish", {
    writable: false,
    configurable: false,
    value: (error: string | null) =>
      stringify({
        error,
        logs,
        tests,
        environmentSet: assign({}, environmentSet),
        environmentUnset: keys(environmentUnset),
        variables: assign({}, localSet),
        headers: pre ? assign({}, headers) : null,
        visualization,
      }),
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** An error from either realm, as one line: its name, its message and the line of the script. */
function describe(caught: unknown, limits: Limits): string {
  if (typeof caught !== "object" || caught === null) return `Error: ${String(caught)}`;
  const error = caught as { code?: unknown; name?: unknown; message?: unknown; stack?: unknown };
  if (error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
    return `El script tardó más de ${limits.scriptMs / 1000} s y se detuvo`;
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : "";
  const line = typeof error.stack === "string" ? new RegExp(`${SCRIPT_FILE}:(\\d+)`).exec(error.stack)?.[1] : undefined;
  return `${name}: ${message}${line ? ` (línea ${line})` : ""}`;
}

function run(message: { input: Record<string, unknown>; limits: Limits }): string {
  const { input, limits } = message;
  const context = createContext(Object.create(null) as object, {
    name: "script",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  (context as { __input?: string }).__input = JSON.stringify({ ...input, limits });
  new Script(`(${prelude.toString()})(globalThis);`, { filename: "prelude.js" }).runInContext(context, {
    timeout: 1_000,
  });

  let error: string | null = null;
  try {
    new Script(String(input.code ?? ""), { filename: SCRIPT_FILE }).runInContext(context, {
      timeout: limits.scriptMs,
      displayErrors: false,
    });
  } catch (caught) {
    error = describe(caught, limits);
  }
  const answer: unknown = new Script(`__finish(${JSON.stringify(error)})`, { filename: "finish.js" }).runInContext(
    context,
    { timeout: 1_000 },
  );
  if (typeof answer !== "string") throw new Error("Resultado no legible");
  return answer;
}

// Userland's shortcut to every built-in module. Nothing here needs it after this line, and a
// script that somehow reached `process` should not find it lying there.
delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;

process.once("message", (message: { input: Record<string, unknown>; limits: Limits }) => {
  let reply: { result: string } | { failure: string };
  try {
    reply = { result: run(message) };
  } catch (caught) {
    reply = { failure: describe(caught, message.limits) };
  }
  process.send?.(reply, () => process.exit(0));
});
