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
 * 7. **Intentos con tope.** Más de 20 credenciales malas por minuto desde una IP es un 429 sin mirar
 *    la credencial (`auth-failure-limiter.ts`). El token probado no se guarda ni se registra.
 * 8. **Túneles, solo a puertos web.** Un `CONNECT` va a 443, 80 u 8443 salvo que el despliegue diga
 *    otra lista (`CAPTURE_CONNECT_PORTS`). Otro puerto es un 403, grabado como rechazado.
 *
 * ## HTTPS: el túnel, y descifrarlo solo si se pide
 *
 * Por omisión un `CONNECT` abre un túnel TCP y el proxy no ve más que `host:puerto`. Se graba así,
 * marcado «cifrado, sin detalle».
 *
 * Con `CAPTURE_MITM=true` en el despliegue **y** «Descifrar HTTPS» en la sesión, el proxy hace de
 * intermediario (`intercept`): contesta al dispositivo con un certificado para el nombre pedido,
 * firmado por la CA de la instalación (`capture-authority.ts`, con su clave guardada solo cifrada),
 * y cada petición de dentro sigue el camino de una en claro —`forward`—: la guarda, la conexión a
 * la IP comprobada, **la validación normal del certificado del servidor de verdad**, la redacción y
 * el import. El destino es siempre el del `CONNECT`. Una app que fija su certificado no acepta el
 * de la CA: su túnel falla y se graba con el motivo.
 *
 * ## Varias instancias
 *
 * El proxy no tiene registro propio: la credencial se busca por su hash en la tabla
 * (`CaptureProxyStore.lookup`), así que el puerto del proxy puede caer en cualquier instancia de la
 * API, no solo en la que abrió la sesión. Una credencial buena se recuerda un segundo, y la
 * caducidad se mira en cada petición: lo único que puede llegar con ese retraso es un «Parar» de
 * otra instancia, y la sincronización del servicio corta además las conexiones abiertas de la sesión
 * parada. La cuenta de lo grabado y el tope se llevan en la tabla con un incremento atómico
 * (`store.record`), no aquí: dos instancias no pueden pasarse del tope entre las dos.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { TLSSocket, type SecureContext } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { BlockedTargetError, pinnedAgent, resolveTarget, type SafeFetchPolicy } from "@/shared/http/safe-fetch";
import { hashOpaqueToken } from "@/shared/crypto/opaque-token";
import { InMemoryRateLimitStore, type RateLimitStorePort } from "@/shared/rate-limit/rate-limit-store";
import type { CaptureLimits, CaptureStopReason, RawExchange } from "../domain/model";
import { AuthFailureLimiter, DEFAULT_AUTH_FAILURE_LIMIT, type AuthFailureLimit } from "./auth-failure-limiter";

/** Una sesión abierta, como la ve el proxy. El token no está: se busca por su hash. */
export type ProxySession = {
  id: string;
  projectId: string;
  expiresAt: Date;
  limits: CaptureLimits;
  /** Si sus túneles se descifran. Sin `mitm` en las opciones, no cambia nada. */
  decryptHttps: boolean;
};

/** Lo que la tabla dice de un hash: la sesión abierta, que terminó y por qué, o que no existe. */
export type SessionLookup = { session: ProxySession } | { ended: CaptureStopReason } | null;

/** Por qué no se atiende una petición: sin credencial que valga (407) o con demasiados intentos (429). */
type Refusal = { status: 407; refused: string } | { status: 429; refused: string; retryAfter: number };

/**
 * Donde viven las sesiones y lo grabado. El proxy no guarda nada propio: lo que sabe de una sesión
 * lo pregunta aquí, y así cualquier instancia de la API atiende el token de cualquier otra.
 */
export type CaptureProxyStore = {
  lookup: (tokenHash: string) => Promise<SessionLookup>;
  /**
   * Graba una petición o un túnel, en bruto: quien lo recibe lo tapa antes de guardarlo. `open`
   * dice si la sesión admite más; `false` es que con esta llegó al tope, o que ya estaba cerrada.
   */
  record: (session: ProxySession, exchange: RawExchange) => Promise<{ open: boolean }>;
  /** Se usó una sesión pasada su hora: se apunta que terminó. */
  expire: (session: ProxySession) => Promise<void>;
};

export type CaptureProxyOptions = {
  policy: SafeFetchPolicy;
  store: CaptureProxyStore;
  now: () => Date;
  /** El cuerpo más grande que se **reenvía**. Uno mayor es un 413: el proxy lo tiene entero en memoria. */
  maxForwardBodyBytes: number;
  /** Cuánto aguanta un túnel callado antes de cortarse. */
  tunnelIdleMs: number;
  /** Los puertos a los que se abre túnel. Otro puerto es un 403, grabado como rechazado. */
  connectPorts: ReadonlySet<number>;
  /** Cuántas credenciales malas se aguantan por IP. Por omisión, 20 por minuto. */
  authFailureLimit?: AuthFailureLimit;
  /**
   * Dónde se cuentan esos intentos. El de la aplicación los comparte entre instancias; sin él, un
   * contador de este proxy con su reloj, que es lo que usan sus pruebas.
   */
  rateLimits?: RateLimitStorePort;
  /** Cuánto se recuerda una credencial buena sin volver a la tabla. Como mucho 2 s; por omisión, 1 s. */
  authCacheMs?: number;
  /**
   * Descifrar HTTPS: el contexto TLS para contestar a un nombre, firmado por la CA de la
   * instalación. Sin esto, ninguna sesión descifra, pida lo que pida.
   */
  mitm?: { contextFor: (hostname: string) => Promise<SecureContext> };
};

/** Cuánto se recuerda una credencial buena, por omisión. Es lo que tarda en llegar un «Parar» de otra instancia. */
export const AUTH_CACHE_MS = 1_000;
/** Cuántas credenciales se recuerdan a la vez. */
const MAX_CACHED_SESSIONS = 1_000;

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
  /** Las credenciales buenas recordadas, por hash, con cuándo se leyeron de la tabla. */
  private readonly cache = new Map<string, { session: ProxySession; at: number }>();
  /** Las conexiones abiertas de cada sesión en este proceso, para cortarlas al pararla. */
  private readonly sockets = new Map<string, Set<Socket>>();
  private readonly failures: AuthFailureLimiter;
  private readonly authCacheMs: number;
  private starting: Promise<number> | null = null;
  /**
   * Donde se lee el HTTP que llega descifrado de un túnel. No escucha en ningún puerto: recibe los
   * sockets TLS a mano, y cada uno trae su sesión y su destino en `decrypted`.
   */
  private readonly inner: Server;
  private readonly decrypted = new WeakMap<object, { session: ProxySession; origin: string }>();

  constructor(private readonly options: CaptureProxyOptions) {
    this.failures = new AuthFailureLimiter(
      options.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT,
      options.rateLimits ?? new InMemoryRateLimitStore(() => options.now().getTime()),
    );
    this.authCacheMs = Math.min(2_000, Math.max(0, options.authCacheMs ?? AUTH_CACHE_MS));
    this.inner = createServer({ requestTimeout: options.policy.timeoutMs * 2 });
    this.inner.on("request", (request, response) => this.onDecrypted(request, response));
    this.inner.on("upgrade", (_request, socket: Socket) => {
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    this.inner.on("clientError", (_error, socket: Socket) => socket.destroy());
  }

  get listening(): boolean {
    return this.server !== null;
  }

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : null;
  }

  /** Empieza a escuchar. Devuelve el puerto de verdad, que es otro cuando se pidió el 0. */
  listen(port: number, host: string): Promise<number> {
    if (this.server) return Promise.resolve(this.port!);
    // Dos llamadas seguidas —la sincronización y una sesión nueva— abren un solo servidor.
    this.starting ??= this.start(port, host).finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(port: number, host: string): Promise<number> {
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
    for (const id of [...this.sockets.keys()]) this.cut(id);
    this.cache.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Las sesiones que tienen algo en este proceso: conexiones abiertas o una credencial recordada.
   * Es lo que la sincronización compara con la tabla para cortar lo que otra instancia paró.
   */
  knownSessions(): string[] {
    return [...new Set([...this.sockets.keys(), ...[...this.cache.values()].map((entry) => entry.session.id)])];
  }

  /**
   * Cierra una sesión en este proceso: olvida su credencial y corta sus conexiones. Lo que dice la
   * tabla lo escribe quien la paró; aquí solo se deja de atenderla ya, sin esperar a la caché.
   */
  stop(sessionId: string): void {
    for (const [hash, entry] of this.cache) if (entry.session.id === sessionId) this.cache.delete(hash);
    this.cut(sessionId);
  }

  private cut(sessionId: string): void {
    const open = this.sockets.get(sessionId);
    this.sockets.delete(sessionId);
    for (const socket of open ?? []) socket.destroy();
  }

  /**
   * La sesión a la que pertenece una petición, o por qué no hay ninguna.
   *
   * Se busca por el hash del token —en la tabla, a través de `store.lookup`— y no comparando uno a
   * uno: una búsqueda por el hash de 256 bits no filtra por tiempo cuánto se parecía el token a uno
   * bueno. La respuesta se recuerda `authCacheMs` como mucho, y la caducidad se mira en **cada**
   * petición con la fecha recordada: lo único que puede llegar tarde es un «Parar» de otra
   * instancia, y llega tarde como mucho eso.
   */
  private async authenticate(request: IncomingMessage): Promise<ProxySession | Refusal> {
    const ip = request.socket.remoteAddress ?? "desconocida";
    // Antes de mirar la credencial: pasado el tope, ni hash ni búsqueda (ver `auth-failure-limiter.ts`).
    const retryAfter = await this.failures.blocked(ip);
    if (retryAfter !== null) {
      return {
        status: 429,
        refused: "Demasiados intentos con una credencial que no vale: espera un minuto",
        retryAfter,
      };
    }
    const token = tokenFrom(request.headers["proxy-authorization"]);
    if (!token) return { status: 407, refused: "Falta la credencial de la sesión de captura" };
    const hash = hashOpaqueToken(token);

    let session: ProxySession;
    const cached = this.cache.get(hash);
    if (cached && Date.now() - cached.at < this.authCacheMs) session = cached.session;
    else {
      this.cache.delete(hash);
      let found: SessionLookup;
      try {
        found = await this.options.store.lookup(hash);
      } catch {
        return { status: 407, refused: "No se pudo comprobar la credencial: vuelve a intentarlo" };
      }
      if (!found || "ended" in found) {
        // El token de una sesión ya cerrada no es adivinar: es un móvil que sigue mandando lo de
        // antes. Contarlo dejaría esa IP sin poder usar la sesión nueva durante un minuto.
        if (!found) await this.failures.failed(ip);
        return {
          status: 407,
          refused: found
            ? `La sesión de captura terminó (${found.ended})`
            : "La credencial no es de ninguna sesión abierta",
        };
      }
      session = found.session;
      // Acotado: una caché que crece con cada sesión distinta no puede crecer sin fin.
      if (this.cache.size >= MAX_CACHED_SESSIONS) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(hash, { session, at: Date.now() });
    }

    if (session.expiresAt.getTime() <= this.options.now().getTime()) {
      this.stop(session.id);
      await this.options.store.expire(session).catch(() => undefined);
      return { status: 407, refused: "La sesión de captura terminó (expired)" };
    }
    return session;
  }

  /**
   * Graba lo visto. Se espera a que esté escrito antes de dar la respuesta por terminada, para que
   * lo que el cliente ya recibió esté en la lista. Si con esto la sesión llegó al tope —o ya estaba
   * cerrada—, se corta al terminar de contestar.
   */
  private async record(session: ProxySession, exchange: RawExchange): Promise<boolean> {
    try {
      const { open } = await this.options.store.record(session, exchange);
      if (!open) {
        for (const [hash, entry] of this.cache) if (entry.session.id === session.id) this.cache.delete(hash);
      }
      return open;
    } catch {
      // Una escritura que falla no puede tumbar la petición de quien está usando su aplicación.
      return true;
    }
  }

  private track(session: ProxySession, socket: Socket): void {
    let open = this.sockets.get(session.id);
    if (!open) this.sockets.set(session.id, (open = new Set()));
    if (open.has(socket)) return;
    open.add(socket);
    socket.once("close", () => {
      const current = this.sockets.get(session.id);
      current?.delete(socket);
      if (current && !current.size) this.sockets.delete(session.id);
    });
  }

  /* ---------------------------------------------------------------- *
   * HTTP en claro
   * ---------------------------------------------------------------- */

  private async onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.on("error", () => undefined);
    const session = await this.authenticate(request);
    if ("refused" in session) {
      request.resume();
      return challenge(response, session);
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
    return this.forward(session, request, response, target);
  }

  /**
   * Reenvía una petición ya autenticada a `target` y la graba. Es el mismo camino para HTTP en
   * claro y para lo que llega descifrado de un túnel: la misma guarda, el mismo `pinnedAgent` —que
   * en `https://` valida el certificado del servidor de verdad contra su nombre— y la misma
   * redacción al grabar.
   */
  private async forward(
    session: ProxySession,
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
  ): Promise<void> {
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
      const open = await this.record(session, exchange({ error: why }));
      return plain(response, 403, why, open ? undefined : () => this.stop(session.id));
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

      const truncated = total > cap;
      const encoding = String(upstream.headers["content-encoding"] ?? "");
      // Se graba antes de cerrar la respuesta: lo que el cliente ya tiene está en la lista.
      const open = await this.record(
        session,
        exchange({
          status: upstream.statusCode,
          responseHeaders: headers.recorded,
          responseBody: truncated ? Buffer.alloc(0) : decoded(Buffer.concat(kept), encoding, cap),
          responseBodyTruncated: truncated,
          durationMs: Date.now() - started,
        }),
      );
      // Con esta llegó al tope: la sesión se corta, pero después de terminar de contestar esta.
      response.end(open ? undefined : () => this.stop(session.id));
    } catch (error) {
      const why = error instanceof Error ? error.message : "el destino no contestó";
      const open = await this.record(
        session,
        exchange({ error: `el destino no contestó: ${why}`, durationMs: Date.now() - started }),
      );
      const then = open ? undefined : () => this.stop(session.id);
      if (!response.headersSent) plain(response, 502, `El destino no contestó: ${why}`, then);
      else {
        response.destroy();
        then?.();
      }
    } finally {
      agent.destroy().catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTPS: el túnel
   * ---------------------------------------------------------------- */

  private async onConnect(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => undefined);
    const session = await this.authenticate(request);
    if ("refused" in session) {
      client.end(
        session.status === 429
          ? `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${session.retryAfter}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
          : `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_REALM}", charset="UTF-8"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
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
      const open = await this.record(
        session,
        tunnel({ error: `el puerto ${port} no está permitido para túneles (CAPTURE_CONNECT_PORTS)` }),
      );
      return refuse(client, "403 Forbidden", open ? undefined : () => this.stop(session.id));
    }

    let address: string;
    try {
      ({ address } = await resolveTarget(`${url}/`, this.options.policy));
    } catch (error) {
      const why = error instanceof BlockedTargetError ? error.message : "no se pudo resolver el destino";
      const open = await this.record(session, tunnel({ error: why }));
      return refuse(client, "403 Forbidden", open ? undefined : () => this.stop(session.id));
    }

    if (session.decryptHttps && this.options.mitm) return this.intercept(session, client, head, hostname, port, tunnel);

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
      void this.record(session, tunnel({ durationMs: Date.now() - started })).then((more) => {
        if (!more) this.stop(session.id);
      });
    });
    const cut = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("timeout", () => {
      if (!open) {
        void this.record(session, tunnel({ error: "el destino no contestó a tiempo" }));
        client.end("HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      }
      cut();
    });
    client.on("timeout", cut);
    client.on("close", () => upstream.destroy());
    upstream.on("error", (error) => {
      if (!open) {
        void this.record(session, tunnel({ error: `el destino no contestó: ${error.message}` }));
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      } else client.destroy();
    });
  }

  /* ---------------------------------------------------------------- *
   * HTTPS descifrado: el proxy como intermediario
   * ---------------------------------------------------------------- */

  /**
   * Abre el túnel hacia **el propio proxy**: al dispositivo se le contesta con un certificado para
   * `hostname` firmado por la CA de la instalación, y lo que manda dentro se lee como HTTP y se
   * reenvía con `forward`, que abre su propia conexión TLS con el servidor de verdad y valida su
   * certificado con normalidad. El destino de cada petición es **el del `CONNECT`**, ya comprobado
   * por la guarda, y no el `Host` de dentro: cambiarlo no sirve para llegar a otro sitio.
   *
   * Si el dispositivo no acepta el certificado —la CA no está instalada, o la app fija el de su
   * servidor—, el apretón de manos falla y se graba el túnel con el motivo. No hay vuelta atrás a un
   * túnel sin descifrar: la sesión pidió ver dentro, y un túnel opaco escondería el fallo.
   */
  private async intercept(
    session: ProxySession,
    client: Socket,
    head: Buffer,
    hostname: string,
    port: number,
    tunnel: (patch: Partial<RawExchange>) => RawExchange,
  ): Promise<void> {
    let context: SecureContext;
    try {
      context = await this.options.mitm!.contextFor(hostname);
    } catch (error) {
      const why = error instanceof Error ? error.message : "no se pudo firmar el certificado";
      const open = await this.record(session, tunnel({ error: `no se pudo descifrar: ${why}` }));
      return refuse(client, "502 Bad Gateway", open ? undefined : () => this.stop(session.id));
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) client.unshift(head);
    const secure = new TLSSocket(client, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
    this.track(session, secure);
    this.decrypted.set(secure, { session, origin: new URL(`https://${hostname}:${port}`).origin });
    client.setTimeout(this.options.tunnelIdleMs);
    client.on("timeout", () => secure.destroy());

    let handshaken = false;
    let reported = false;
    const refused = (why: string) => {
      if (handshaken || reported) return;
      reported = true;
      void this.record(session, tunnel({ error: why }));
    };
    // Un navegador que no se fía del certificado manda una alerta y llega como `error`. Otros
    // clientes validan después del apretón de manos y cuelgan sin decir nada, y ese cierre no se ve
    // mientras nadie lee del socket: el plazo es lo que acaba grabando esos túneles.
    const handshake = setTimeout(
      () => {
        refused(
          "el dispositivo no terminó el apretón de manos con el certificado de la CA de captura: ¿está instalada y " +
            "marcada de confianza? Una app que fija el certificado de su servidor no se puede descifrar",
        );
        secure.destroy();
      },
      Math.min(this.options.policy.timeoutMs, 10_000),
    );
    handshake.unref();
    secure.once("secure", () => {
      handshaken = true;
      clearTimeout(handshake);
      this.inner.emit("connection", secure);
    });
    secure.once("close", () => clearTimeout(handshake));
    secure.on("error", (error: Error) => {
      refused(
        `el dispositivo no aceptó el certificado de la CA de captura (${error.message}): ¿está instalada y marcada ` +
          "de confianza? Una app que fija el certificado de su servidor no se puede descifrar",
      );
      secure.destroy();
    });
    secure.once("close", () => refused("el dispositivo cerró el túnel sin aceptar el certificado de la CA de captura"));
  }

  /** Una petición que llegó descifrada de un túnel: a su destino, con la sesión del túnel. */
  private onDecrypted(request: IncomingMessage, response: ServerResponse): void {
    response.on("error", () => undefined);
    const context = this.decrypted.get(request.socket);
    if (!context) {
      request.resume();
      return void response.destroy();
    }
    // La sesión pudo caducar con el túnel abierto: lo que viene después ya no se atiende.
    if (context.session.expiresAt.getTime() <= this.options.now().getTime()) {
      request.resume();
      this.stop(context.session.id);
      return;
    }
    const raw = request.url ?? "/";
    // Solo la ruta: una URL absoluta dentro del túnel no cambia a dónde va.
    let path = raw;
    if (!raw.startsWith("/")) {
      try {
        const parsed = new URL(raw);
        path = `${parsed.pathname}${parsed.search}`;
      } catch {
        path = "/";
      }
    }
    void this.forward(context.session, request, response, `${context.origin}${path}`);
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

/** Por qué no se atiende: sin credencial buena, un 407 que la pide; con demasiados intentos, un 429 que no. */
function challenge(response: ServerResponse, refusal: Refusal): void {
  response.writeHead(
    refusal.status,
    refusal.status === 429
      ? { "Retry-After": String(refusal.retryAfter), "Content-Type": "text/plain; charset=utf-8", Connection: "close" }
      : {
          "Proxy-Authenticate": `Basic realm="${PROXY_REALM}", charset="UTF-8"`,
          "Content-Type": "text/plain; charset=utf-8",
          Connection: "close",
        },
  );
  response.end(refusal.refused);
}

function plain(response: ServerResponse, status: number, message: string, then?: () => void): void {
  if (response.headersSent) {
    response.destroy();
    return then?.();
  }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "X-Capture-Proxy": "refused" });
  response.end(message, then);
}

/** Un túnel que no se abre: la línea de estado y se cierra. */
function refuse(client: Socket, status: string, then?: () => void): void {
  client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, then);
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
