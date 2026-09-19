/**
 * El proxy de captura atado a la aplicación: cuándo escucha, y dónde acaba lo que graba.
 *
 * **Escucha solo mientras hay sesiones, y lo decide la tabla.** Cada instancia de la API mira cada
 * segundo si hay alguna sesión abierta (`sync`): con alguna, su proxy escucha; sin ninguna, cierra el
 * puerto. Así un proxy configurado y sin usar no es una superficie, y una sesión abierta desde una
 * instancia se atiende en cualquier otra: el balanceador puede mandar el puerto del proxy a la que
 * quiera. Solo si el despliegue definió `CAPTURE_PROXY_PORT`.
 *
 * **La tabla es la única verdad.** El token se busca por su hash (`findSessionByTokenHash`), la
 * cuenta de lo grabado sube con un incremento atómico que respeta el tope (`appendNext`), y parar o
 * caducar es un `UPDATE` condicional. No hay registro en memoria que se pierda al reiniciar: una
 * sesión abierta sigue sirviendo después de un despliegue.
 *
 * Es deliberadamente sondeo contra la base y no un bus de mensajes: son unas pocas filas, un índice
 * parcial, y una consulta por segundo e instancia. Lo que llega con ese retraso es que otra
 * instancia corte las conexiones abiertas de una sesión parada; el token deja de valer antes, al
 * caducar su caché (ver `capture-proxy.ts`).
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";

import { ENV, type Env } from "@/shared/config/env";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError } from "@/shared/errors/domain-error";
import { policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { RATE_LIMIT_STORE, type RateLimitStorePort } from "@/shared/rate-limit/rate-limit-store";
import { captureItemFrom, type CaptureLimits, type CaptureSession, type CaptureStopReason } from "../domain/model";
import { CAPTURE_REPOSITORY, type CaptureRepositoryPort } from "../domain/ports";
import { CaptureAuthority } from "./capture-authority";
import { CaptureProxy, type ProxySession, type SessionLookup } from "./capture-proxy";

/** El usuario del `Basic`. Da igual cuál: lo que autentica es la contraseña, que es el token. */
export const CAPTURE_PROXY_USERNAME = "captura";

/** Cuánto aguanta un túnel HTTPS sin tráfico antes de cortarse. */
const TUNNEL_IDLE_MS = 120_000;
/** Cada cuánto mira cada instancia si hay sesiones abiertas, y cuáles se pararon en otra. */
export const CAPTURE_SYNC_MS = 1_000;

@Injectable()
export class CaptureProxyService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly proxy: CaptureProxy;
  /** Las escrituras de este proceso que aún no han terminado, por sesión: parar las espera. */
  private readonly pending = new Map<string, Set<Promise<unknown>>>();
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly authority: CaptureAuthority,
    @Optional() @Inject(RATE_LIMIT_STORE) rateLimits: RateLimitStorePort | null = null,
  ) {
    this.proxy = new CaptureProxy({
      // La misma política que `SAFE_FETCH` y los sockets, leída del mismo sitio: es lo que impide
      // que el proxy se deje `allowPrivateTargets` encendido por su cuenta.
      policy: policyFromEnv(env),
      now: () => clock.now(),
      maxForwardBodyBytes: env.MAX_RESPONSE_BYTES,
      tunnelIdleMs: TUNNEL_IDLE_MS,
      connectPorts: new Set(env.CAPTURE_CONNECT_PORTS),
      // Los intentos fallidos, contados donde los cuentan todas las instancias.
      ...(rateLimits ? { rateLimits } : {}),
      // Solo con `CAPTURE_MITM=true`: sin esto, una sesión que pidiera descifrar no descifra.
      ...(env.CAPTURE_MITM ? { mitm: { contextFor: (hostname: string) => authority.contextFor(hostname) } } : {}),
      store: {
        lookup: (tokenHash) => this.lookup(tokenHash),
        record: (session, exchange) =>
          this.track(session.id, async () => {
            const item = captureItemFrom(exchange, { sessionId: session.id, projectId: session.projectId, seq: 0 });
            const { seq: _unused, ...rest } = item;
            const seq = await this.captures.appendNext(rest, session.limits.maxRequests);
            if (seq !== null && seq < session.limits.maxRequests) return { open: true };
            // Con esta llegó al tope, o ya no estaba abierta: se apunta, y el proxy corta.
            if (seq !== null)
              await this.captures.stopSession(session.projectId, session.id, "request-limit", clock.now());
            return { open: false };
          }),
        expire: async (session) => {
          await this.captures.stopSession(session.projectId, session.id, "expired", clock.now());
        },
      },
    });
  }

  get enabled(): boolean {
    return this.env.CAPTURE_PROXY_PORT !== undefined;
  }

  /** El puerto en el que escucha, o el configurado cuando todavía no escucha. */
  get port(): number | null {
    return this.proxy.port ?? this.env.CAPTURE_PROXY_PORT ?? null;
  }

  get publicHost(): string | null {
    return this.env.CAPTURE_PROXY_PUBLIC_HOST ?? null;
  }

  limits(): CaptureLimits {
    return {
      durationMs: this.env.CAPTURE_SESSION_MINUTES * 60_000,
      maxRequests: this.env.CAPTURE_MAX_REQUESTS,
      maxBodyBytes: this.env.CAPTURE_MAX_BODY_BYTES,
    };
  }

  /** Pone el proxy a escuchar para una sesión recién escrita en la tabla. Devuelve el puerto. */
  async open(_session: CaptureSession): Promise<number> {
    if (!this.enabled) throw disabled();
    // Una vuelta de sincronización en marcha pudo leer la tabla antes de que la sesión estuviera:
    // se espera a que acabe, o cerraría el puerto que se abre aquí.
    await this.syncing?.catch(() => undefined);
    return this.listen();
  }

  /**
   * Cierra una sesión desde fuera —«Parar», borrarla, o que se abrió otra—.
   *
   * En este proceso deja de atenderla ya (su credencial y sus conexiones) y espera a que lo
   * capturado aquí esté escrito; luego la cierra en la tabla, que es por donde se enteran las demás
   * instancias, y cierra el puerto si era la última. Devuelve si la cerró esta llamada.
   */
  async stop(session: Pick<CaptureSession, "id" | "projectId">, reason: CaptureStopReason): Promise<boolean> {
    this.proxy.stop(session.id);
    await this.flush(session.id);
    const closed = await this.captures.stopSession(session.projectId, session.id, reason, this.clock.now());
    await this.sync().catch(() => undefined);
    return closed;
  }

  /** Lo que queda por escribir de una sesión en este proceso. */
  async flush(sessionId: string): Promise<void> {
    const writes = this.pending.get(sessionId);
    if (writes) await Promise.allSettled([...writes]);
  }

  /**
   * Una vuelta de sincronización con la tabla: caduca lo vencido, corta lo que otra instancia
   * paró, y abre o cierra el puerto según haya sesiones abiertas. Nunca dos a la vez.
   */
  sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => (this.syncing = null));
    return this.syncing;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    if (this.authority.enabled) {
      // Al arrancar y no a la primera sesión: quien despliega ve en el registro por qué no hay
      // descifrado —sin `SECRETS_KEY`, por ejemplo— sin esperar a que alguien lo pida. El motivo no
      // lleva nada secreto; la clave no pasa nunca por aquí.
      await this.authority.ensure().catch((error: unknown) => {
        new Logger("CaptureProxy").error(error instanceof Error ? error.message : "Descifrar HTTPS no pudo arrancar");
      });
    }
    await this.sync().catch(() => undefined);
    this.timer = setInterval(() => void this.sync().catch(() => undefined), CAPTURE_SYNC_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.syncing?.catch(() => undefined);
    await this.proxy.close();
  }

  private async syncOnce(): Promise<void> {
    await this.captures.expireDue(this.clock.now());
    const active = await this.captures.listActive();
    const open = new Set(active.map((session) => session.id));
    for (const id of this.proxy.knownSessions()) if (!open.has(id)) this.proxy.stop(id);
    if (!active.length) {
      if (this.proxy.listening) await this.proxy.close();
    } else if (!this.proxy.listening) {
      await this.listen().catch(() => undefined);
    }
  }

  private async listen(): Promise<number> {
    try {
      return await this.proxy.listen(this.env.CAPTURE_PROXY_PORT!, this.env.CAPTURE_PROXY_HOST);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ConflictError(
        code === "EADDRINUSE"
          ? `El puerto ${this.env.CAPTURE_PROXY_PORT} del proxy de captura está ocupado por otro proceso`
          : "No se pudo abrir el proxy de captura",
        "capture-proxy-unavailable",
      );
    }
  }

  private async lookup(tokenHash: string): Promise<SessionLookup> {
    const row = await this.captures.findSessionByTokenHash(tokenHash);
    if (!row) return null;
    if (row.status !== "active") return { ended: row.stopReason ?? "manual" };
    const session: ProxySession = {
      id: row.id,
      projectId: row.projectId,
      expiresAt: row.expiresAt,
      limits: row.limits,
      decryptHttps: row.decryptHttps ?? false,
    };
    return { session };
  }

  private track<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const promise = work();
    let writes = this.pending.get(sessionId);
    if (!writes) this.pending.set(sessionId, (writes = new Set()));
    writes.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => {
        writes.delete(promise);
        if (!writes.size && this.pending.get(sessionId) === writes) this.pending.delete(sessionId);
      });
    return promise;
  }
}

export function disabled(): ConflictError {
  return new ConflictError(
    "La captura de tráfico no está activada en este despliegue: hace falta definir CAPTURE_PROXY_PORT",
    "capture-disabled",
  );
}
