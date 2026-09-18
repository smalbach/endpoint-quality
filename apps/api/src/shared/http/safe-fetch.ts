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
 *     address is pinned **in the connection's lookup**, and the name stays in the URL: TLS checks
 *     the certificate against the name (SNI), which is what a certificate is issued for. Writing
 *     the address into the URL instead — what this did before — pinned just as well and failed
 *     every HTTPS server with a real certificate, because `https://199.232.157.51` matches none.
 *  4. **Cap what comes back.** A URL that streams forever is a denial of service that needs no
 *     private address at all.
 *
 * `ALLOW_PRIVATE_TARGETS` turns rule 1 off, and exists because the self-hosted case is real: an
 * operator running this on their laptop against `http://localhost:8100` is the *normal* use. It
 * defaults to false, so a hosted deployment is safe unless somebody deliberately opens it.
 */
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as pinnedFetch } from "undici";
import { cookieHeaderFor, type Cookie } from "@eq/runner-core";

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
  /**
   * Las cabeceras `Set-Cookie`, una por una y de **todos** los saltos.
   *
   * Aparte de `headers` porque ahí no caben: varias `Set-Cookie` leídas como un solo valor se unen
   * con comas, y un `Expires=Wed, 09 Jun 2027 10:18:14 GMT` lleva una coma dentro. Partir esa
   * cadena es adivinar. De todos los saltos porque un login suele contestar 302 con la cookie
   * puesta, y la cookie de ese salto es justo la que hace falta.
   */
  setCookie: string[];
  body: string;
  /**
   * The bytes, and only when the caller asked for them with `responseAs: "bytes"`.
   *
   * Opt-in rather than always present because every response would then be held twice — once
   * decoded and once raw — and the run engine makes thousands of them. When it is set, `body` is
   * the empty string: a `.zip` decoded into a UTF-8 string is a corrupted `.zip`, and returning
   * that alongside the real bytes would be handing the next caller a trap.
   */
  bytes?: Uint8Array;
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
    // Y el mismo disfraz escrito en hexadecimal, que es la forma en la que llega de verdad.
    //
    // Esto era un agujero, y comprobado contra la pila: `new URL("http://[::ffff:127.0.0.1]/")`
    // **normaliza** el nombre a `::ffff:7f00:1`, así que la línea de arriba —que busca los cuatro
    // números con puntos— no lo veía nunca. Solo acertaba cuando alguien llamaba a esta función
    // con la cadena escrita a mano, que es exactamente lo que hacía su prueba. Por esa puerta se
    // leía loopback y `169.254.169.254` con la guarda puesta.
    const embedded = embeddedV4(normalized);
    if (embedded) return isBlockedAddress(embedded);
    if (normalized === "::" || normalized === "::1") return { blocked: true, why: "loopback IPv6" };
    if (normalized.startsWith("fe80")) return { blocked: true, why: "link-local IPv6" };
    if (/^f[cd]/.test(normalized)) return { blocked: true, why: "unique local IPv6" };
    return { blocked: false };
  }
  return { blocked: true, why: "no es una dirección IP" };
}

/**
 * La IPv4 que lleva dentro una IPv6, cuando la lleva.
 *
 * Tres prefijos, y los tres significan «esto acaba en una IPv4»:
 *
 * - `::ffff:a:b` — la mapeada, que es como un sistema con doble pila escribe una IPv4.
 * - `::a:b` — la compatible, retirada hace años pero que las bibliotecas siguen resolviendo.
 * - `64:ff9b::a:b` — NAT64, el prefijo con el que una red traduce a IPv4 al salir.
 *
 * Se decide por el prefijo y no por «parece que acaba en algo»: una IPv6 normal también termina en
 * dos grupos hexadecimales, y tratarlos como IPv4 bloquearía direcciones públicas legítimas. Lo que
 * devuelve vuelve a `isBlockedAddress`, que es quien tiene la lista: aquí no se decide nada, solo
 * se le quita el disfraz.
 */
function embeddedV4(normalized: string): string | null {
  const groups = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!groups) return null;
  const high = Number.parseInt(groups[1], 16);
  const low = Number.parseInt(groups[2], 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

/**
 * Los esquemas que acepta una llamada que no diga otra cosa.
 *
 * Es una lista blanca y no una negra por el motivo que dice el comentario de abajo. Vive aquí
 * arriba para que se vea que el defecto no cambia cuando alguien pide otra: `resolveTarget` sin
 * tercer argumento sigue siendo exactamente lo que era.
 */
const DEFAULT_SCHEMES = ["http:", "https:"] as const;

/**
 * Validates the URL and resolves it to the address the request will actually go to.
 *
 * `schemes` existe porque hay más de un protocolo que sale de aquí: un `ws://` es un GET con
 * `Upgrade`, así que las cuatro reglas de la cabecera valen tal cual y lo único que sobra es la
 * lista blanca. Se parametriza **esto** y no se copia el resto: una segunda lista de rangos
 * privados, o un segundo sitio donde se resuelve el nombre, sería el fallo. Quien pide un esquema
 * nuevo pide solo eso; las reglas son las mismas.
 */
export async function resolveTarget(
  rawUrl: string,
  policy: SafeFetchPolicy,
  options: { schemes?: readonly string[] } = {},
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(rawUrl, "no es una URL válida");
  }
  // `file:`, `gopher:` and friends are not oversights to be handled later — they are the other
  // half of SSRF, and an allowlist is the only way to be sure a new scheme does not appear.
  const schemes = options.schemes ?? DEFAULT_SCHEMES;
  if (!schemes.includes(url.protocol)) {
    const names = schemes.map((scheme) => scheme.replace(":", "")).join(" y ");
    throw new BlockedTargetError(rawUrl, `esquema ${url.protocol} no permitido, solo ${names}`);
  }
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
  /**
   * El tarro de cookies que presenta la petición, si lo hay.
   *
   * Se calcula **por salto** y no una vez: una redirección puede llevar a otro host o a otra ruta,
   * y las cookies que le tocan son otras. Una cabecera `Cookie` escrita a mano gana: quien la
   * escribe está diciendo exactamente qué quiere mandar.
   */
  jar?: Cookie[];
  /** What to do with the response body. `"bytes"` skips the decode and fills `bytes` instead —
   * see `SafeFetchResult.bytes`. Anything not UTF-8 (a `.zip`) needs it. */
  responseAs?: "text" | "bytes";
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
  let method = (options.method ?? "GET").toUpperCase();
  let current = rawUrl;
  let body = options.body;
  const visited = new Set<string>();
  const setCookie: string[] = [];
  const wroteCookie = Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "cookie");

  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    if (visited.has(current)) throw new BlockedTargetError(current, "bucle de redirecciones");
    visited.add(current);

    const resolvingAt = Date.now();
    const { url, address, family } = await resolveTarget(current, policy);
    const dnsMs = Date.now() - resolvingAt;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    // Un agente por salto, con la dirección comprobada fija en su `lookup`: la conexión no vuelve a
    // preguntar al DNS —la ventana del rebinding sigue cerrada— y el nombre sigue en la URL, que es
    // contra lo que TLS valida el certificado.
    const agent = pinnedAgent(address, family);

    try {
      let response: Awaited<ReturnType<typeof pinnedFetch>>;
      try {
        const headers: Record<string, string> = {
          Accept: "application/json, application/yaml, text/yaml, */*",
          // `Host` lo pone la URL. Uno escrito a mano mandaría la petición a un nombre y el
          // certificado de otro.
          ...Object.fromEntries(
            Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "host"),
          ),
        };
        // Las cookies de *este* salto: una redirección a otro host no lleva las del anterior.
        const cookieHeader =
          options.jar && !wroteCookie ? cookieHeaderFor(url.toString(), options.jar, Date.now()) : "";
        if (cookieHeader) headers.Cookie = cookieHeader;
        response = await pinnedFetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal: controller.signal,
          dispatcher: agent,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new BlockedTargetError(current, `sin respuesta en ${policy.timeoutMs} ms`);
        throw new BlockedTargetError(current, failureOf(error));
      } finally {
        clearTimeout(timeout);
      }

      setCookie.push(...response.headers.getSetCookie());

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new BlockedTargetError(current, `redirección ${response.status} sin cabecera Location`);
        // `307` y `308` conservan el método y el cuerpo, así que seguirlas sobre una escritura sería
        // repetir esa escritura en una dirección que nadie eligió — indistinguible, desde aquí, de un
        // intento de que borremos algo en otro sitio. Eso se sigue rechazando.
        if (!["GET", "HEAD", "OPTIONS"].includes(method) && (response.status === 307 || response.status === 308)) {
          throw new BlockedTargetError(
            current,
            `redirección ${response.status} sobre un ${method}: no se reenvía una escritura`,
          );
        }
        // `301`, `302` y `303` sobre una escritura se siguen **como un GET sin cuerpo**, que es lo
        // que hace cualquier navegador y lo que la RFC 9110 exige para el 303. No es repetir la
        // escritura: es leer en la dirección nueva, y sin esto un login que contesta 302 —el caso
        // normal de una API con cookies— no se puede seguir hasta el final.
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          method = "GET";
          body = undefined;
        }
        current = new URL(location, url).toString();
        continue;
      }

      // The split is taken here, between `fetch` resolving — which is the headers having arrived —
      // and the body having been read. Those are the two halves of a slow response and they have
      // different owners.
      const headersAt = Date.now();
      const raw = await readCapped(response, policy.maxResponseBytes, current);
      const readAt = Date.now();
      const asBytes = options.responseAs === "bytes";
      return {
        status: response.status,
        headers: {
          ...Object.fromEntries(response.headers.entries()),
          // `entries()` devuelve una entrada por cada `Set-Cookie`, así que `fromEntries` se queda
          // **con la última** y pierde las demás: una captura que leyera `set-cookie` estaría
          // leyendo una cookie que no es la que buscaba. Aquí van todas, unidas como las une la
          // propia plataforma, y quien necesite precisión usa `setCookie`.
          ...(setCookie.length ? { "set-cookie": setCookie.join(", ") } : {}),
        },
        setCookie,
        body: asBytes ? "" : new TextDecoder().decode(raw),
        ...(asBytes ? { bytes: raw } : {}),
        finalUrl: url.toString(),
        durationMs: readAt - started,
        timing: { dnsMs, ttfbMs: headersAt - started, downloadMs: readAt - headersAt },
      };
    } finally {
      // Cortado y no esperado: en una redirección el cuerpo no se lee, y esperar a que se vacíe
      // sería esperar a un servidor que no tiene por qué terminar.
      agent.destroy().catch(() => undefined);
    }
  }

  throw new BlockedTargetError(rawUrl, `más de ${policy.maxRedirects} redirecciones`);
}

/**
 * Un agente que conecta siempre a `address`, pregunte por el nombre que pregunte.
 *
 * El `lookup` es el de `net.connect`, que con `autoSelectFamily` pide la lista entera (`all`) y sin
 * ella una sola dirección: se contestan las dos formas con la misma dirección, la comprobada.
 */
export function pinnedAgent(address: string, family: number): Agent {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  return new Agent({ connect: { lookup } });
}

/** El motivo que da `fetch`: «fetch failed» no dice nada, y su `cause` —el certificado, el reset— sí. */
function failureOf(error: unknown): string {
  if (!(error instanceof Error)) return "la petición falló";
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message;
}

/**
 * Reads the body, stopping at the cap.
 *
 * Streamed rather than `await response.text()`: a `Content-Length` can lie or be absent, and a
 * URL that emits bytes forever would otherwise fill the process's memory. The cap is enforced on
 * what actually arrives.
 *
 * It hands back the bytes and lets the caller decide whether to decode them, because that is the
 * one decision this function cannot make for a `.zip`.
 */
async function readCapped(
  response: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
  target: string,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
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
  return concat(chunks, total);
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
