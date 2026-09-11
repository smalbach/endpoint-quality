/** Postman-style variable interpolation shared by generated cases and user-authored workflows. */

/**
 * What may name a variable. Declared once and imported by everything that validates one — the
 * environment's own map, and a flow's capture target — because two copies of a rule are two rules
 * that will disagree the first time one of them is widened.
 */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
/** A computed value: `$name`, optionally followed by `:` and its arguments. */
const COMPUTED = /\{\{\s*\$([A-Za-z][A-Za-z0-9]*)(?::([^}]*))?\s*\}\}/g;

export type RuntimeVariables = Record<string, string>;

/**
 * The part of a computed value the engine cannot produce, handed in from outside.
 *
 * `runner-core` has no clock, no randomness and no crypto, and that is not an accident to work
 * around: it is what lets a run be replayed and a rule be tested without a machine. So the three
 * impure ingredients arrive as data — one identifier, one instant, one number — and the one
 * function that cannot be data arrives as a function.
 *
 * **One seed per case, so every occurrence inside a case agrees.** A flow that puts `{{$uuid}}` in
 * an idempotency header and in the payload means the same value in both, and its read-back step
 * means the same value again; a fresh one per occurrence would break exactly the flows this is for.
 * Two cases get different seeds, which is the other half — that is what stops the second run of a
 * POST over a natural key from being a 409 about the first.
 */
export type ComputedSeed = {
  uuid: string;
  now: Date;
  /** In `[0, 1)`. The engine turns it into whatever range the token asked for. */
  random: number;
  hmacSha256: (key: string, text: string) => string;
};

/**
 * The declarative answer to `preRequestScript`.
 *
 * The analyzer ran user JavaScript on `node:vm` before every request. `vm` is not a security
 * boundary, and this runner executes on the server with every project's secrets in memory, so that
 * door stays shut. What people actually wrote in those scripts is a short list — a fresh id, the
 * current time, a random number, a base64, a signature — and all five are values rather than
 * programs. Written as values they cover almost all of it and execute nobody's code.
 */
function computed(name: string, args: string, seed: ComputedSeed): string | null {
  switch (name) {
    case "uuid":
      return seed.uuid;
    case "now":
      // `unix` because a signed request or a JWT-shaped payload wants epoch seconds, and the ISO
      // string cannot be turned into one by anything else on this list.
      return args === "unix" ? String(Math.floor(seed.now.getTime() / 1000)) : seed.now.toISOString();
    case "randomInt": {
      const [from, to] = args.split(":");
      const min = Number.isFinite(Number(from)) && from !== "" ? Math.trunc(Number(from)) : 0;
      const max = Number.isFinite(Number(to)) && to !== undefined && to !== "" ? Math.trunc(Number(to)) : 999_999;
      // Both ends included, which is what somebody writing `1:100` means. An inverted range is
      // read in the order it was written rather than refused: a token that silently produced
      // nothing would be worse than one that produces a number in the range they described.
      const [low, high] = min <= max ? [min, max] : [max, min];
      return String(low + Math.floor(seed.random * (high - low + 1)));
    }
    case "base64":
      // Over UTF-8 bytes and not over code units: `btoa` throws on anything above U+00FF, and a
      // payload with an accent in it is the ordinary case here.
      return bytesToBase64(new TextEncoder().encode(args));
    case "hmacSha256": {
      const cut = args.indexOf(":");
      if (cut < 1) return null;
      return seed.hmacSha256(args.slice(0, cut), args.slice(cut + 1));
    }
    default:
      // Unknown, so it is left standing — and `unresolvedVariables` reports it. Guessing would
      // send somebody's typo to the target as a literal.
      return null;
  }
}

/** Written by hand because `Buffer` is Node's and this package runs in a browser bundle too. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Named variables first, computed values second.
 *
 * The order is what lets a computed value take a variable as an argument.
 * `{{$hmacSha256:{{clave}}:texto}}` is not one token this grammar could parse — the inner braces
 * would end the outer match — but after the first pass it is `{{$hmacSha256:mi-clave:texto}}`,
 * which the second pass reads without knowing anything happened.
 */
export function interpolateText(value: string, variables: RuntimeVariables, seed?: ComputedSeed): string {
  const named = value.replace(TOKEN, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : token,
  );
  if (!seed) return named;
  return named.replace(COMPUTED, (token, name: string, args: string | undefined) => {
    const resolved = computed(name, args ?? "", seed);
    return resolved ?? token;
  });
}

export function interpolateValue<T>(value: T, variables: RuntimeVariables, seed?: ComputedSeed): T {
  if (typeof value === "string") return interpolateText(value, variables, seed) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, variables, seed)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateValue(item, variables, seed)]),
    ) as T;
  }
  return value;
}

/** Reads a dot path with optional array indexes, for example `data.items.0.id`. */
export function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current === null || current === undefined || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[segment];
    }, value);
}

/**
 * The tokens still standing after interpolation, so a request that would carry `{{userId}}` into
 * somebody's URL is blocked instead of sent.
 *
 * It decodes `%7B`/`%7D` first and `interpolateText` does not, which is deliberate and not an
 * oversight: a token that reached this point percent-encoded was encoded by `requestPathFor` after
 * the substitution pass, so it can no longer be replaced — but it is still a variable nobody
 * supplied, and that is what the caller needs to hear.
 */
export function unresolvedVariables(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      const decoded = entry.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
      for (const match of decoded.matchAll(new RegExp(TOKEN.source, "g"))) found.add(match[1]);
      // A computed value nobody recognised is reported the same way. `{{$uuidd}}` is a typo, and
      // letting it travel to the target as a literal would come back as a 400 about a value the
      // report shows as if it had been sent on purpose — which is the exact failure the named
      // check above exists to prevent.
      for (const match of decoded.matchAll(new RegExp(COMPUTED.source, "g"))) found.add(`$${match[1]}`);
    } else if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  visit(value);
  return [...found];
}
