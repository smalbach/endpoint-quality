/**
 * El proxy de captura atado a la aplicación: cuándo escucha, y dónde acaba lo que graba.
 *
 * **Escucha solo mientras hay sesiones.** Se abre con la primera y se cierra con la última: sin
 * ninguna sesión abierta el puerto no está escuchando, así que un proxy configurado y sin usar no es
 * una superficie. Y solo si el despliegue definió `CAPTURE_PROXY_PORT`.
 *
 * **Lo grabado se escribe en orden, sesión a sesión.** El proxy entrega cada petición según termina
 * y la escritura es asíncrona; sin una cola por sesión, la fila 7 podría llegar a la tabla antes que
 * la 6 y la cuenta de la sesión quedaría por detrás de lo que hay. Parar una sesión espera a que se
 * vacíe su cola, para que lo último que se capturó esté en la lista cuando se lee.
 */
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";

import { ENV, type Env } from "@/shared/config/env";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ConflictError } from "@/shared/errors/domain-error";
import { policyFromEnv } from "@/shared/http/safe-fetch.provider";
import { captureItemFrom, type CaptureLimits, type CaptureSession, type CaptureStopReason } from "../domain/model";
import { CAPTURE_REPOSITORY, type CaptureRepositoryPort } from "../domain/ports";
import { CaptureProxy, type ProxySession } from "./capture-proxy";

/** El usuario del `Basic`. Da igual cuál: lo que autentica es la contraseña, que es el token. */
export const CAPTURE_PROXY_USERNAME = "captura";

/** Cuánto aguanta un túnel HTTPS sin tráfico antes de cortarse. */
const TUNNEL_IDLE_MS = 120_000;

@Injectable()
export class CaptureProxyService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly proxy: CaptureProxy;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CAPTURE_REPOSITORY) private readonly captures: CaptureRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    this.proxy = new CaptureProxy({
      // La misma política que `SAFE_FETCH` y los sockets, leída del mismo sitio: es lo que impide
      // que el proxy se deje `allowPrivateTargets` encendido por su cuenta.
      policy: policyFromEnv(env),
      now: () => clock.now(),
      maxForwardBodyBytes: env.MAX_RESPONSE_BYTES,
      tunnelIdleMs: TUNNEL_IDLE_MS,
      connectPorts: new Set(env.CAPTURE_CONNECT_PORTS),
      hooks: {
        onExchange: (session, exchange) =>
          this.enqueue(session.id, async () => {
            const item = captureItemFrom(exchange, {
              sessionId: session.id,
              projectId: session.projectId,
              seq: session.recorded,
            });
            await this.captures.appendItem(item);
            const row = await this.captures.findSession(session.projectId, session.id);
            if (row) await this.captures.saveSession({ ...row, itemCount: Math.max(row.itemCount, item.seq) });
          }),
        onStop: (session, reason) => void this.closed(session, reason),
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

  isLive(sessionId: string): boolean {
    return this.proxy.isLive(sessionId);
  }

  /** Da de alta la sesión en el proxy, y lo pone a escuchar si no lo estaba. Devuelve el puerto. */
  async open(session: CaptureSession): Promise<number> {
    if (!this.enabled) throw disabled();
    let port: number;
    try {
      port = await this.proxy.listen(this.env.CAPTURE_PROXY_PORT!, this.env.CAPTURE_PROXY_HOST);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ConflictError(
        code === "EADDRINUSE"
          ? `El puerto ${this.env.CAPTURE_PROXY_PORT} del proxy de captura está ocupado por otro proceso`
          : "No se pudo abrir el proxy de captura",
        "capture-proxy-unavailable",
      );
    }
    const handle: ProxySession = {
      id: session.id,
      projectId: session.projectId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      limits: session.limits,
      recorded: session.itemCount,
    };
    this.proxy.open(handle);
    return port;
  }

  /** Cierra una sesión desde fuera. Espera a que lo ya capturado esté escrito. */
  async stop(sessionId: string, reason: CaptureStopReason): Promise<void> {
    this.proxy.stop(sessionId, reason);
    await this.flush(sessionId);
    await this.closeIfIdle();
  }

  /** Lo que queda por escribir de una sesión. */
  async flush(sessionId: string): Promise<void> {
    await this.queues.get(sessionId);
  }

  /**
   * Al arrancar: las sesiones que la tabla da por abiertas no lo están.
   *
   * Su token vivía en la memoria de un proceso que ya no existe, así que el proxy no las reconoce.
   * Se cierran con su motivo en vez de dejarlas «activas» para siempre en la pantalla.
   */
  async onApplicationBootstrap(): Promise<void> {
    const orphans = await this.captures.listActive();
    const now = this.clock.now();
    for (const session of orphans) {
      if (this.proxy.isLive(session.id)) continue;
      await this.captures.saveSession({ ...session, status: "stopped", stopReason: "restart", stoppedAt: now });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.proxy.close();
  }

  /** El proxy cerró la sesión por su cuenta —caducó o llegó al tope—: se apunta en la tabla. */
  private async closed(session: ProxySession, reason: CaptureStopReason): Promise<void> {
    await this.enqueue(session.id, async () => {
      const row = await this.captures.findSession(session.projectId, session.id);
      if (row && row.status === "active") {
        await this.captures.saveSession({ ...row, status: "stopped", stopReason: reason, stoppedAt: this.clock.now() });
      }
    });
    await this.closeIfIdle();
  }

  private async closeIfIdle(): Promise<void> {
    if (this.proxy.listening && this.proxy.liveCount() === 0) await this.proxy.close();
  }

  private enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve())
      .then(work)
      // Una escritura que falla no puede parar la cola: la siguiente petición también se graba.
      .catch(() => undefined);
    this.queues.set(sessionId, next);
    return next;
  }
}

export function disabled(): ConflictError {
  return new ConflictError(
    "La captura de tráfico no está activada en este despliegue: hace falta definir CAPTURE_PROXY_PORT",
    "capture-disabled",
  );
}
