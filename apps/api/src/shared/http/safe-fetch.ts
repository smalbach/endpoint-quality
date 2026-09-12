/**
 * Fetching a URL the user chose, without becoming their proxy into our own network.
 *
 * This is the guard §4.8 of the plan describes, and it arrives **in P2 rather than P4** because
 * importing a spec by URL is already the server making a request to an address a customer typed.
 * The threat does not wait for the run engine.
 *
 * The coupled dashboard never faced this: its fetch ran in a Worker on the operator's own
 * machine, aimed at their own laptop. Hosted, the same feature means anybody with an account can
 * ask our server to GET `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and
 * read the answer — cloud credentials, from a form field labelled "URL del contrato".
 *
 * Four things have to hold together, and any one of them alone is not enough:
 *
 *  1. **Resolve DNS first and check the IP**, never the hostname. A name the attacker controls
 *     can point anywhere, and `evil.com → 127.0.0.1` defeats every string-based blocklist.
 *  2. **Re-check on every redirect.** A public URL that 302s to `10.0.0.5` is the standard way
 *     around a check performed only once, so redirects are followed by hand, one at a time.
 *  3. **Connect to the IP that was checked.** Checking a name, then letting the HTTP client
 *     resolve it again, leaves a window in which the second answer differs — DNS rebinding. The
 *     request goes to the literal address, with `Host` set to the original name.
 *  4. **Cap what comes back.** A URL that streams forever is a denial of service that needs no
 *     private address at all.
 *
 * `ALLOW_PRIVATE_TARGETS` turns rule 1 off, and exists because the self-hosted case is real: an
 * operator running this on their laptop against `http://localhost:8100` is the *normal* use. It
 * defaults to false, so a hosted deployment is safe unless somebody deliberately opens it.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SafeFetchPolicy = {
  allowPrivateTargets: boolean;
  maxRedirects: number;
  timeoutMs: number;
  maxResponseBytes: number;
};

/**
 * Where the milliseconds went.
 *
 * «Tardó 900 ms» is not actionable and «el DNS tardó 850» is. The three that are measurable from
 * here are worth having for exactly that reason: a name that resolves slowly, a server that takes
 * its time before answering, and a response body large enough that reading it is the wait.
 *
 * **`connect` and `tls` are deliberately absent.** Getting them out of `fetch` means a custom
 * `undici` dispatcher hooked into diagnostics channels — a lot of machinery, tied to the internals
 * of a library, to split a number this code would then have to keep honest. Three numbers that are
 * certainly right beat five where two are guesses.
 */
export type RequestTiming = {
  /** Resolving the name. Zero when the URL already carried a literal address. */
  dnsMs: number;
  /** From sending the request to the response headers arriving: the target's own thinking time. */
  ttfbMs: number;
  /** Reading the body after that, which is the part that grows with the payload. */
  downloadMs: number;
};

export type SafeFetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  /** Milliseconds for the request that produced this response, redirects excluded. */
  durationMs: number;
  timing: RequestTiming;
};

export class BlockedTargetError extends Error {
  constructor(
    readonly target: string,
    readonly why: string,
  ) {
    super(`El destino ${target} está bloqueado: ${why}`);
    this.name = "BlockedTargetError";
  }
}

/**
 * The ranges a hosted deployment must never reach.
 *
 * `169.254.169.254` is the one that matters most — it is the cloud metadata endpoint on AWS,
 * GCP and Azure alike, it needs no credential, and it answers with the instance's own. The rest
 * close the loopback, private and carrier-grade ranges, plus the IPv6 equivalents, because
 * `::ffff:127.0.0.1` and `[::1]` reach exactly the same places.
 */
const BLOCKED_V4: { cidr: string; why: string }[] = [
  { cidr: "0.0.0.0/8", why: "dirección no especificada" },
  { cidr: "10.0.0.0/8", why: "red privada" },
  { cidr: "100.64.0.0/10", why: "CGNAT" },
  { cidr: "127.0.0.0/8", why: "loopback" },
  { cidr: "169.254.0.0/16", why: "link-local, incluye el endpoint de metadatos de la nube" },
  { cidr: "172.16.0.0/12", why: "red privada" },
  { cidr: "192.0.0.0/24", why: "reservada IETF" },
  { cidr: "192.168.0.0/16", why: "red privada" },
  { cidr: "198.18.0.0/15", why: "benchmarking" },
  { cidr: "224.0.0.0/4", why: "multicast" },
  { cidr: "240.0.0.0/4", why: "reservada" },
];

function toLong(address: string): number {
  return address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
}

export function isBlockedAddress(address: string): { blocked: boolean; why?: string } {
  const family = isIP(address);
  if (family === 4) {
    const value = toLong(address);
    for (const { cidr, why } of BLOCKED_V4) {
      const [network, bits] = cidr.split("/");
      const mask = bits === "0" ? 0 : (-1 << (32 - Number(bits))) >>> 0;
      if ((value & mask) >>> 0 === (toLong(network) & mask) >>> 0) return { blocked: true, why };
    }
    return { blocked: false };
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    // An IPv4-mapped address is an IPv4 address wearing a costume, and checking it as a string
    // would let `::ffff:169.254.169.254` straight through.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (normalized === "::" || normalized === "::1") return { blocked: true, why: "loopback IPv6" };
    if (normalized.startsWith("fe80")) return { blocked: true, why: "link-local IPv6" };
    if (/^f[cd]/.test(normalized)) return { blocked: true, why: "unique local IPv6" };
    return { blocked: false };
  }
  return { blocked: true, why: "no es una dirección IP" };
}

/** Validates the URL and resolves it to the address the request will actually go to. */
export async function resolveTarget(
  rawUrl: string,
  policy: SafeFetchPolicy,
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(rawUrl, "no es una URL válida");
  }
  // `file:`, `gopher:` and friends are not oversights to be handled later — they are the other
  // half of SSRF, and an allowlist is the only way to be sure a new scheme does not appear.
  if (!["http:", "https:"].includes(url.protocol))
    throw new BlockedTargetError(rawUrl, `esquema ${url.protocol} no permitido, solo http y https`);
  if (url.username || url.password) throw new BlockedTargetError(rawUrl, "las credenciales en la URL no se aceptan");

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  const { address, family } = literal ? { address: hostname, family: literal } : await lookupOrFail(hostname, rawUrl);

  if (!policy.allowPrivateTargets) {
    const verdict = isBlockedAddress(address);
    if (verdict.blocked) throw new BlockedTargetError(rawUrl, `${verdict.why} (${address})`);
  }
  return { url, address, family };
}

async function lookupOrFail(hostname: string, rawUrl: string): Promise<{ address: string; family: number }> {
  try {
    return await lookup(hostname);
  } catch {
    throw new BlockedTargetError(rawUrl, `no se pudo resolver el nombre ${hostname}`);
  }
}

export type SafeRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  /** Bytes as well as text: a file sent from the endpoint editor is not a string, and decoding it
   * into one would corrupt anything that is not UTF-8. */
  body?: string | Uint8Array;
};

/**
 * A request that follows redirects by hand, re-validating each hop.
 *
 * `redirect: "manual"` and a loop, rather than letting fetch follow them: the whole point is
 * that hop two gets the same scrutiny as hop one, and a client that follows redirects internally
 * gives no opportunity to look.
 *
 * Any method, because the runner exercises all of them — but the **body is not replayed across a
 * redirect**, and a redirected non-idempotent request is refused instead. A 307 that moves a
 * DELETE somewhere else is either a misconfiguration or an attempt to have us delete something
 * at an address we did not check, and neither is worth guessing about.
 */
export async function safeFetch(
  rawUrl: string,
  policy: SafeFetchPolicy,
  options: SafeRequestOptions = {},
): Promise<SafeFetchResult> {
  const method = (options.method ?? "GET").toUpperCase();
  let current = rawUrl;
  const visited = new Set<string>();

  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    if (visited.has(current)) throw new BlockedTargetError(current, "bucle de redirecciones");
    visited.add(current);

    const resolvingAt = Date.now();
    const { url, address, family } = await resolveTarget(current, policy);
    const dnsMs = Date.now() - resolvingAt;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);

    let response: Response;
    try {
      // The request goes to the address that was checked, with `Host` carrying the original
      // name. Re-resolving the hostname here would reopen the DNS rebinding window that
      // checking the IP was supposed to close.
      const literalHost = family === 6 ? `[${address}]` : address;
      const direct = new URL(url.toString());
      direct.hostname = literalHost;
      const headers: Record<string, string> = {
        Accept: "application/json, application/yaml, text/yaml, */*",
        ...options.headers,
        Host: url.host,
      };
      response = await fetch(direct, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new BlockedTargetError(current, `sin respuesta en ${policy.timeoutMs} ms`);
      throw new BlockedTargetError(current, error instanceof Error ? error.message : "la petición falló");
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new BlockedTargetError(current, `redirección ${response.status} sin cabecera Location`);
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        // Following it would repeat a write at an address the caller never chose. It is also
        // indistinguishable, from here, from an attempt to have us delete something elsewhere.
        throw new BlockedTargetError(
          current,
          `redirección ${response.status} sobre un ${method}: no se reenvía una escritura`,
        );
      }
      current = new URL(location, url).toString();
      continue;
    }

    // The split is taken here, between `fetch` resolving — which is the headers having arrived —
    // and the body having been read. Those are the two halves of a slow response and they have
    // different owners.
    const headersAt = Date.now();
    const body = await readCapped(response, policy.maxResponseBytes, current);
    const readAt = Date.now();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      finalUrl: url.toString(),
      durationMs: readAt - started,
      timing: { dnsMs, ttfbMs: headersAt - started, downloadMs: readAt - headersAt },
    };
  }

  throw new BlockedTargetError(rawUrl, `más de ${policy.maxRedirects} redirecciones`);
}

/**
 * Reads the body, stopping at the cap.
 *
 * Streamed rather than `await response.text()`: a `Content-Length` can lie or be absent, and a
 * URL that emits bytes forever would otherwise fill the process's memory. The cap is enforced on
 * what actually arrives.
 */
async function readCapped(response: Response, maxBytes: number, target: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BlockedTargetError(target, `la respuesta supera ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export const SAFE_FETCH = Symbol("SAFE_FETCH");

export interface SafeFetchPort {
  get(url: string, options?: { headers?: Record<string, string> }): Promise<SafeFetchResult>;
  request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult>;
}
