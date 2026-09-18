/**
 * El proxy de captura: un proxy HTTP de reenvío, autenticado, con fecha de caducidad y con topes.
 *
 * Es lo más delicado que este producto expone, porque un proxy es **exactamente** lo que la guarda
 * de `safe-fetch.ts` existe para no ser: un sitio desde el que cualquiera pide cosas a la red en
 * nombre del servidor. Así que todo lo que hace pasa por las mismas cuatro reglas, y encima lleva
 * lo suyo:
 *
 * ## El modelo de seguridad
 *
 * 1. **Apagado por defecto.** Solo escucha si el despliegue define `CAPTURE_PROXY_PORT`, y solo
 *    mientras hay alguna sesión abierta: sin sesiones, el puerto está cerrado.
 * 2. **Un token por sesión.** 256 bits aleatorios, enseñados una vez al abrir; aquí dentro solo se
 *    guarda su hash, igual que un token de API. Viaja en `Proxy-Authorization: Basic` porque es lo
 *    único que un navegador o un móvil saben mandar a un proxy; el usuario da igual, cuenta la
 *    contraseña. Sin él, un 407 y nada más.
 * 3. **Con caducidad y con topes.** Treinta minutos por defecto, un número máximo de peticiones y un
 *    máximo de bytes guardados por cuerpo. Llegar a cualquiera de los dos primeros cierra la sesión
 *    y corta sus conexiones: el token deja de servir.
 * 4. **La misma guarda que el resto.** Cada petición y cada túnel resuelven el nombre, comprueban la
 *    IP con `resolveTarget` y conectan **a esa IP** (`pinnedAgent`, o `net.connect` con la dirección
 *    comprobada). Con `ALLOW_PRIVATE_TARGETS=false` no se llega a loopback, a la red privada ni al
 *    endpoint de metadatos de la nube, se escriba como se escriba el nombre.
 * 5. **Las redirecciones no se siguen**: se devuelven al cliente, que pide el siguiente salto otra
 *    vez por el proxy y otra vez pasa por la guarda. Es la regla 2 de `safe-fetch.ts` sin tener que
 *    reescribirla.
 * 6. **Nada en claro llega a la tabla.** Lo que se graba se tapa antes de guardarlo
 *    (`captureItemFrom`), y la `Proxy-Authorization` —el token de la propia sesión— ni se reenvía
 *    ni se graba.
 * 7. **Túneles, solo a puertos web.** Un `CONNECT` va a 443, 80 u 8443 salvo que el despliegue diga
 *    otra lista (`CAPTURE_CONNECT_PORTS`). Otro puerto es un 403, grabado como rechazado.
 *
 * ## HTTPS: el túnel, sin mirar dentro
 *
 * Un `CONNECT` abre un túnel TCP y el proxy no ve más que `host:puerto`. Se graba así, marcado
 * «cifrado, sin detalle». Ver dentro exigiría hacer de intermediario (MITM) con una CA propia que el
 * dispositivo tendría que instalar como raíz de confianza: una CA así firma certificados para
 * **cualquier** dominio, y su clave privada es entonces la cosa más valiosa de la instalación. Eso
 * no se ha hecho. Ni siquiera como opción: generar la CA pide una dependencia de X.509 que el
 * proyecto no tiene, y hacerlo a medias —con la clave en disco o en una columna sin cifrar— sería
 * peor que no tenerlo.
 *
 * ## Una instancia
 *
 * El registro de sesiones vive en memoria del proceso que las abrió, igual que los sockets de un
 * canal. Con varias instancias detrás de un balanceador el puerto del proxy tiene que llegar a la
 * instancia que abrió la sesión; aquí no se reparte nada.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { BlockedTargetError, pinnedAgent, resolveTarget, type SafeFetchPolicy } from "@/shared/http/safe-fetch";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import type { CaptureLimits, CaptureStopReason, RawExchange } from "../domain/model";

/** Una sesión viva, como la ve el proxy. */
export type ProxySession = {
  id: string;
  projectId: string;
  tokenHash: string;
  expiresAt: Date;
  limits: CaptureLimits;
  /** Cuántas lleva grabadas; al llegar a `limits.maxRequests` se cierra. */
  recorded: number;
};

type LiveSession = ProxySession & { sockets: Set<Socket>; timer: NodeJS.Timeout | null };

export type CaptureProxyHooks = {
  /** Una petición o un túnel, en bruto. Quien lo recibe lo tapa antes de guardarlo. */
  onExchange: (session: ProxySession, exchange: RawExchange) => void;
  /** El proxy cerró una sesión por su cuenta: caducó o llegó al tope. */
  onStop: (session: ProxySession, reason: CaptureStopReason) => void;
};

export type CaptureProxyOptions = {
  policy: SafeFetchPolicy;
  hooks: CaptureProxyHooks;
  now: () => Date;
  /** El cuerpo más grande que se **reenvía**. Uno mayor es un 413: el proxy lo tiene entero en memoria. */
  maxForwardBodyBytes: number;
  /** Cuánto aguanta un túnel callado antes de cortarse. */
  tunnelIdleMs: number;
  /** Los puertos a los que se abre túnel. Otro puerto es un 403, grabado como rechazado. */
  connectPorts: ReadonlySet<number>;
};

/** El nombre con el que el navegador pregunta por la credencial. */
export const PROXY_REALM = "Captura de endpoint-quality";

/**
 * Las cabeceras de un salto, que no se reenvían: son de esta conexión y no de la petición.
 *
 * `proxy-authorization` va aquí y es la que importa: es el token de la sesión, y reenviarlo sería
 * regalárselo al destino. `expect` va porque `undici` no lo admite, y `accept-encoding` se
 * reescribe aparte (ver `forwardHeaders`).
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
]);

export class CaptureProxy {
  private server: Server | null = null;
  private readonly sessions = new Map<string, LiveSession>();
  /** Los tokens de sesiones ya cerradas, para poder decir «terminó» en vez de «no existe». */
  private readonly ended = new Map<string, CaptureStopReason>();

  constructor(private readonly options: CaptureProxyOptions) {}

  get listening(): boolean {
    return this.server !== null;
  }

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  liveCount(): number {
    return this.sessions.size;
  }

  isLive(sessionId: string): boolean {
    return [...this.sessions.values()].some((session) => session.id === sessionId);
  }

  /** Empieza a escuchar. Devuelve el puerto de verdad, que es otro cuando se pidió el 0. */
  async listen(port: number, host: string): Promise<number> {
    if (this.server) return this.port!;
    const server = createServer({ requestTimeout: this.options.policy.timeoutMs * 2 });
    // Un tope de conexiones: el proxy está autenticado, pero el apretón de manos TCP no.
    server.maxConnections = 256;
    server.on("request", (request, response) => void this.onRequest(request, response));
    server.on("connect", (request, socket, head) => void this.onConnect(request, socket as Socket, head));
    // Un WebSocket por el proxy en claro. No se graba ni se reenvía: se dice que no.
    server.on("upgrade", (_request, socket: Socket) => {
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    server.on("clientError", (_error, socket: Socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    return this.port!;
  }

  /** Deja de escuchar y corta todo lo que siga abierto. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const session of this.sessions.values()) this.release(session);
    this.sessions.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Da de alta una sesión. El token llega ya como hash: el proxy nunca ve uno en claro guardado. */
  open(session: ProxySession): void {
    const live: LiveSession = { ...session, sockets: new Set(), timer: null };
    const remaining = session.expiresAt.getTime() - this.options.now().getTime();
    // El reloj de verdad cierra la sesión aunque nadie vuelva a usarla; la comprobación al
    // autenticar cubre el reloj de las pruebas y cualquier desfase del temporizador.
    live.timer = setTimeout(() => this.end(live, "expired", true), Math.max(0, remaining));
    live.timer.unref();
    this.sessions.set(session.tokenHash, live);
  }

  /** Cierra una sesión desde fuera —«Parar», o que se abrió otra—: el token deja de servir ya. */
  stop(sessionId: string, reason: CaptureStopReason): void {
    const live = [...this.sessions.values()].find((session) => session.id === sessionId);
    if (live) this.end(live, reason, false);
  }

  private end(session: LiveSession, reason: CaptureStopReason, notify: boolean): void {
    if (!this.sessions.delete(session.tokenHash)) return;
    this.ended.set(session.tokenHash, reason);
    // Acotado: es solo para dar un mensaje mejor, y no puede crecer sin fin.
    if (this.ended.size > 1000) this.ended.delete(this.ended.keys().next().value!);
    this.release(session);
    if (notify) this.options.hooks.onStop(session, reason);
  }

  private release(session: LiveSession): void {
    if (session.timer) clearTimeout(session.timer);
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
  }

  /**
   * La sesión a la que pertenece una petición, o por qué no hay ninguna.
   *
   * Se busca por el hash del token y no comparando uno a uno: un `Map` sobre el hash de 256 bits
   * no filtra por tiempo cuánto se parecía el token a uno bueno.
   */
  private authenticate(header: string | undefined): LiveSession | { refused: string } {
    const token = tokenFrom(header);
    if (!token) return { refused: "Falta la credencial de la sesión de captura" };
    const hash = hashOpaqueToken(token);
    const session = this.sessions.get(hash);
    if (!session) {
      const reason = this.ended.get(hash);
      return {
        refused: reason ? `La sesión de captura terminó (${reason})` : "La credencial no es de ninguna sesión abierta",
      };
    }
    if (session.expiresAt.getTime() <= this.options.now().getTime()) {
      this.end(session, "expired", true);
      return { refused: "La sesión de captura terminó (expired)" };
    }
    return session;
  }

  /** Graba lo visto y, si con esto llega al tope, cierra la sesión. */
  private record(session: LiveSession, exchange: RawExchange): void {
    if (!this.sessions.has(session.tokenHash)) return;
    session.recorded += 1;
    this.options.hooks.onExchange(session, exchange);
    if (session.recorded >= session.limits.maxRequests) this.end(session, "request-limit", true);
  }

  private track(session: LiveSession, socket: Socket): void {
    if (session.sockets.has(socket)) return;
    session.sockets.add(socket);
    socket.once("close", () => session.sockets.delete(socket));
  }

  /* ---------------------------------------------------------------- *
   * HTTP en claro
   * ---------------------------------------------------------------- */

  private async onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.on("error", () => undefined);
    const session = this.authenticate(request.headers["proxy-authorization"]);
    if ("refused" in session) {
      request.resume();
      return challenge(response, session.refused);
    }
    this.track(session, request.socket);

    const target = request.url ?? "";
    // En forma de origen (`GET /x`) no es una petición de proxy: es alguien abriendo el puerto en
    // el navegador. Y `https://` en forma absoluta no se atiende: un cliente de verdad usa CONNECT.
    if (!/^http:\/\//i.test(target)) {
      request.resume();
      return plain(
        response,
        400,
        "Esto es el proxy de captura: configúralo como proxy HTTP en el navegador o el dispositivo en vez de abrirlo como página.",
      );
    }

    const at = this.options.now();
    const started = Date.now();
    const method = (request.method ?? "GET").toUpperCase();
    const recordedHeaders = recordableHeaders(request.rawHeaders);
    const cap = session.limits.maxBodyBytes;

    let body: Buffer;
    try {
      body = await readAll(request, this.options.maxForwardBodyBytes);
    } catch {
      return plain(
        response,
        413,
        `El cuerpo supera ${this.options.maxForwardBodyBytes} bytes, el máximo que reenvía el proxy`,
      );
    }
    const exchange = (patch: Partial<RawExchange>): RawExchange => ({
      at,
      method,
      url: target,
      status: null,
      encrypted: false,
      requestHeaders: recordedHeaders,
      requestBody: body.subarray(0, cap),
      requestBodyTruncated: body.length > cap,
      responseHeaders: {},
      responseBody: Buffer.alloc(0),
      responseBodyTruncated: false,
      durationMs: Date.now() - started,
      error: null,
      ...patch,
    });

    let resolved: Awaited<ReturnType<typeof resolveTarget>>;
    try {
      resolved = await resolveTarget(target, this.options.policy);
    } catch (error) {
      const why = error instanceof BlockedTargetError ? error.message : "no se pudo resolver el destino";
      this.record(session, exchange({ error: why }));
      return plain(response, 403, why);
    }

    const agent = pinnedAgent(resolved.address, resolved.family);
    try {
      const upstream = await agent.request({
        origin: resolved.url.origin,
        path: `${resolved.url.pathname}${resolved.url.search}`,
        method: method as never,
        headers: forwardHeaders(request.rawHeaders),
        body: body.length ? body : null,
        headersTimeout: this.options.policy.timeoutMs,
        bodyTimeout: this.options.policy.timeoutMs,
      });

      const headers = responseHeaders(upstream.headers);
      response.writeHead(upstream.statusCode, headers.forward);

      // Lo que pasa por el proxy **no** se corta: se corta lo que se guarda. Cortar el reenvío
      // rompería la aplicación que alguien está usando para capturar.
      const kept: Buffer[] = [];
      let keptBytes = 0;
      let total = 0;
      response.once("close", () => {
        if (!response.writableFinished) upstream.body.destroy();
      });
      for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (keptBytes < cap) {
          const slice = chunk.subarray(0, cap - keptBytes);
          kept.push(slice);
          keptBytes += slice.length;
        }
        if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
      }
      response.end();

      const truncated = total > cap;
      const encoding = String(upstream.headers["content-encoding"] ?? "");
      this.record(
        session,
        exchange({
          status: upstream.statusCode,
          responseHeaders: headers.recorded,
          responseBody: truncated ? Buffer.alloc(0) : decoded(Buffer.concat(kept), encoding, cap),
          responseBodyTruncated: truncated,
          durationMs: Date.now() - started,
        }),
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : "el destino no contestó";
      if (!response.headersSent) plain(response, 502, `El destino no contestó: ${why}`);
      else response.destroy();
      this.record(session, exchange({ error: `el destino no contestó: ${why}`, durationMs: Date.now() - started }));
    } finally {
      agent.destroy().catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTPS: el túnel
   * ---------------------------------------------------------------- */

  private async onConnect(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => undefined);
    const session = this.authenticate(request.headers["proxy-authorization"]);
    if ("refused" in session) {
      client.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_REALM}", charset="UTF-8"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    this.track(session, client);

    const at = this.options.now();
    const authority = request.url ?? "";
    let hostname: string;
    let port: number;
    try {
      const parsed = new URL(`https://${authority}`);
      if (!parsed.hostname || parsed.pathname !== "/" || parsed.username || parsed.password) throw new Error();
      hostname = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : 443;
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const url = `https://${hostname}:${port}`;
    const tunnel = (patch: Partial<RawExchange>): RawExchange => ({
      at,
      method: "CONNECT",
      url,
      status: null,
      encrypted: true,
      requestHeaders: {},
      requestBody: Buffer.alloc(0),
      requestBodyTruncated: false,
      responseHeaders: {},
      responseBody: Buffer.alloc(0),
      responseBodyTruncated: false,
      durationMs: 0,
      error: null,
      ...patch,
    });

    // Un túnel es un cable TCP: sin esta lista, el token valdría para hablar con un servidor de
    // correo o con cualquier servicio de una IP pública. Se graba para que la pantalla diga por qué.
    if (!this.options.connectPorts.has(port)) {
      this.record(
        session,
        tunnel({ error: `el puerto ${port} no está permitido para túneles (CAPTURE_CONNECT_PORTS)` }),
      );
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }

    let address: string;
    try {
      ({ address } = await resolveTarget(`${url}/`, this.options.policy));
    } catch (error) {
      const why = error instanceof BlockedTargetError ? error.message : "no se pudo resolver el destino";
      this.record(session, tunnel({ error: why }));
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }

    const started = Date.now();
    const upstream = netConnect({ host: address, port });
    this.track(session, upstream);
    let open = false;
    upstream.setTimeout(this.options.policy.timeoutMs);
    upstream.once("connect", () => {
      open = true;
      upstream.setTimeout(this.options.tunnelIdleMs);
      client.setTimeout(this.options.tunnelIdleMs);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      this.record(session, tunnel({ durationMs: Date.now() - started }));
    });
    const cut = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("timeout", () => {
      if (!open) {
        this.record(session, tunnel({ error: "el destino no contestó a tiempo" }));
        client.end("HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      }
      cut();
    });
    client.on("timeout", cut);
    client.on("close", () => upstream.destroy());
    upstream.on("error", (error) => {
      if (!open) {
        this.record(session, tunnel({ error: `el destino no contestó: ${error.message}` }));
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      } else client.destroy();
    });
  }
}

/* ------------------------------------------------------------------ *
 * Piezas
 * ------------------------------------------------------------------ */

/** El token de una `Proxy-Authorization: Basic`, que va en la contraseña. */
export function tokenFrom(header: string | undefined): string | null {
  const match = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  const token = colon === -1 ? decoded : decoded.slice(colon + 1);
  return token.trim() || null;
}

function challenge(response: ServerResponse, message: string): void {
  response.writeHead(407, {
    "Proxy-Authenticate": `Basic realm="${PROXY_REALM}", charset="UTF-8"`,
    "Content-Type": "text/plain; charset=utf-8",
    Connection: "close",
  });
  response.end(message);
}

function plain(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) return void response.destroy();
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "X-Capture-Proxy": "refused" });
  response.end(message);
}

/** Pares de `rawHeaders`, con el nombre como lo escribió el cliente. Uno repetido, unido por comas. */
function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) out.push([raw[index], raw[index + 1]]);
  return out;
}

/** Lo que se graba de la petición: todo menos lo que es del salto. El token del proxy, el primero. */
function recordableHeaders(raw: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of pairs(raw)) {
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP.has(lowered) && lowered !== "host") continue;
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return headers;
}

/**
 * Lo que se reenvía.
 *
 * `Accept-Encoding: identity`, siempre. Lo que se viene a buscar es el cuerpo, y un cuerpo en gzip
 * cortado por el tope no se puede descomprimir: pidiendo la respuesta sin comprimir se guarda algo
 * legible. Cuesta ancho de banda y no cambia la respuesta, porque la cabecera `Content-Encoding` que
 * llega al cliente es la que mandó el servidor.
 */
function forwardHeaders(raw: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const named = new Set(
    pairs(raw)
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase())),
  );
  for (const [name, value] of pairs(raw)) {
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP.has(lowered) || named.has(lowered) || lowered === "accept-encoding") continue;
    headers[lowered] = headers[lowered] === undefined ? value : `${headers[lowered]}, ${value}`;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

/** Las cabeceras de la respuesta: las que se devuelven al cliente y las que se graban. */
function responseHeaders(source: Record<string, string | string[] | undefined>): {
  forward: Record<string, string | string[]>;
  recorded: Record<string, string>;
} {
  const forward: Record<string, string | string[]> = {};
  const recorded: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    forward[name] = value;
    recorded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { forward, recorded };
}

/** El cuerpo entero de la petición, o un error si pasa del tope. */
async function readAll(request: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > max) {
      request.resume();
      throw new Error("demasiado grande");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * El cuerpo sin comprimir, cuando el servidor lo comprimió igualmente.
 *
 * Con tope de salida: un cuerpo de 1 kB puede inflarse hasta llenar la memoria, y lo que se guarda
 * tiene un máximo de todos modos.
 */
function decoded(body: Buffer, encoding: string, max: number): Buffer {
  const kind = encoding.trim().toLowerCase();
  if (!body.length || !kind || kind === "identity") return body;
  try {
    if (kind === "gzip" || kind === "x-gzip") return gunzipSync(body, { maxOutputLength: max });
    if (kind === "deflate") return inflateSync(body, { maxOutputLength: max });
    if (kind === "br") return brotliDecompressSync(body, { maxOutputLength: max });
  } catch {
    return Buffer.alloc(0);
  }
  return Buffer.alloc(0);
}
