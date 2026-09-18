/**
 * Las sesiones vivas de **este** proceso: el único sitio donde hay un socket abierto.
 *
 * Todo lo que se decide sobre una sesión se decide en `domain/session.ts`, que es puro. Esto es lo
 * que no puede ser puro: tener el socket, llevar el reloj, guardar cada mensaje según llega, emitir
 * la trama en vivo y cerrar cuando algo lo pide. Y las tres cosas que hacen que una sesión que
 * sobrevive a la pestaña no se convierta en una fuga:
 *
 * 1. **El tope por proceso** (`CHANNEL_MAX_OPEN`). Un socket es un descriptor, y sin tope el
 *    botón «Conectar» sería una forma de clavar quinientos en la API.
 * 2. **El reloj**, cada segundo, para lo que no llega: la inactividad y la duración. Un servidor
 *    que acepta y calla se corta aunque nadie esté mirando la pestaña; que el tope dependiera de
 *    una pestaña abierta sería no tener tope.
 * 3. **El latido y el segador.** Cada instancia late por sus sesiones, y cualquiera cierra las que
 *    llevan tres latidos sin dueño. La dueña es justo la que no puede cerrarlas: se murió.
 *
 * Una sesión que pertenece a otra instancia no se puede usar desde esta, y se dice con un 409 que
 * la nombra. Relevar un socket entre procesos no existe; fingirlo sería una vista en vivo que no
 * vuelve a emitir y un «Enviar» que falla la mitad de las veces.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { ChannelExpectation, ChannelLimits, RawFrame, RedactionRules, StopReason } from "@eq/runner-core";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
import { ConflictError } from "@/shared/errors/domain-error";
import { BlockedTargetError } from "@/shared/http/safe-fetch";
import { HandshakeRejectedError } from "@/shared/http/safe-socket";
import { CHANNEL_SESSION_REPOSITORY, type ChannelSessionRepositoryPort } from "../domain/ports";
import { closeSession, isFinished, isStale, onFrame, onTick, type ChannelSession } from "../domain/session";
import { ChannelProgressStream } from "./channel-progress.stream";
import { CHANNEL_TRANSPORT, type ChannelTransportPort, type OpenChannel } from "./ws-transport";

/** Cada cuánto se mira el reloj de las sesiones vivas. Decide la precisión de los topes de tiempo. */
export const TICK_MS = 1_000;
/** Cada cuánto late una instancia por sus sesiones. El segador espera tres de estos. */
export const BEAT_MS = 5_000;

/** Lo que hace falta para abrir: ya resuelto contra el entorno por quien llama. */
export type SessionPlan = {
  url: string;
  headers: Record<string, string>;
  subprotocols: string[];
  limits: ChannelLimits;
  rules: RedactionRules;
  expect: ChannelExpectation;
  /**
   * El entorno no permite escrituras: se escucha y no se manda.
   *
   * Es la misma protección que para un `POST` contra un entorno de solo lectura, adaptada a lo que
   * un socket es. Abrirlo y oír es leer; mandar un mensaje puede cambiar lo que sea al otro lado, y
   * el interruptor del entorno existe precisamente para que eso no pase contra producción.
   */
  readOnly: boolean;
  /** Para decirlo con su nombre cuando alguien intente mandar. */
  environmentName: string;
};

type Live = {
  session: ChannelSession;
  plan: SessionPlan;
  channel: OpenChannel | null;
  /** El origen de `atMs`: monótono, porque un reloj de pared que salta haría mentir a los huecos. */
  startedAt: number;
  /** Las escrituras de esta sesión, en fila: los mensajes se guardan en el orden en que llegaron. */
  writes: Promise<void>;
};

@Injectable()
export class ChannelSessionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Channels");
  private readonly live = new Map<string, Live>();
  /**
   * Los cierres que están en marcha. Un servidor que abre y cierra en el mismo paquete termina la
   * sesión **dentro** de la apertura; sin esperar ese cierre, `start` devolvía la fila de antes —en
   * `connecting`— porque el cierre todavía no la había guardado.
   */
  private readonly closing = new Map<string, Promise<ChannelSession | null>>();
  private timers: NodeJS.Timeout[] = [];

  /** Quién soy, para la fila. Con un trozo aleatorio: dos procesos con el mismo pid tras reiniciar no son el mismo. */
  readonly instance = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    @Inject(CHANNEL_TRANSPORT) private readonly transport: ChannelTransportPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
    private readonly stream: ChannelProgressStream,
  ) {}

  onModuleInit(): void {
    // `unref`: un reloj de sesiones no puede ser lo que mantiene vivo un proceso que se está yendo.
    this.timers = [
      setInterval(() => void this.tick(), TICK_MS).unref(),
      setInterval(() => void this.beat(), BEAT_MS).unref(),
    ];
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    // Un apagado ordenado cierra lo suyo con 1001 («me voy») y deja las filas cerradas: sin esto,
    // cada despliegue dejaría sus sesiones esperando al segador.
    await Promise.all([...this.live.keys()].map((id) => this.close(id, "cancelled", 1001)));
  }

  owns(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  /**
   * Abrir. Devuelve la sesión **ya guardada**, abierta o con el motivo de que no lo esté.
   *
   * Se guarda en `connecting` antes de conectar: si el proceso muere en mitad del handshake, la
   * fila existe y el segador la cierra. Una conexión sin fila sería una sesión que nadie puede ver
   * ni cerrar.
   */
  async start(session: ChannelSession, plan: SessionPlan): Promise<ChannelSession> {
    if (this.live.size >= this.env.CHANNEL_MAX_OPEN) {
      throw new ConflictError(
        `Esta instancia ya tiene ${this.live.size} sesiones abiertas, que es su tope: cierra alguna antes de abrir otra`,
        "channel-sessions-full",
      );
    }
    const entry: Live = { session, plan, channel: null, startedAt: performance.now(), writes: Promise.resolve() };
    this.live.set(session.id, entry);
    await this.sessions.save(session);

    try {
      entry.channel = await this.transport.open(
        plan.url,
        {
          headers: plan.headers,
          subprotocols: plan.subprotocols,
          maxPayload: plan.limits.maxMessageBytes,
          handshakeTimeoutMs: Math.min(plan.limits.maxDurationMs, this.env.REQUEST_TIMEOUT_MS),
        },
        {
          onOpen: (handshake) => this.frame(session.id, { direction: "open", atMs: this.at(entry), handshake }),
          onMessage: (data, binary) =>
            this.frame(session.id, {
              direction: "in",
              atMs: this.at(entry),
              kind: binary ? "binary" : "text",
              // Lo binario entra como hexadecimal de lo que quepa: guardar la trama entera es el
              // mismo motivo por el que un ejemplo tiene tope de cuerpo.
              body: binary ? data.subarray(0, 256).toString("hex") : data.toString("utf8"),
              bytes: data.byteLength,
            }),
          onClose: (code, reason) =>
            this.frame(session.id, { direction: "close", atMs: this.at(entry), closeCode: code, closeReason: reason }),
          onError: (error) => this.frame(session.id, { direction: "error", atMs: this.at(entry), body: error.message }),
        },
      );
    } catch (error) {
      // No llegó a abrir. Lo que pasó decide de quién es el rojo: la guarda o una URL que no es de
      // socket son `config` —nadie llegó a llamar—, y el resto es `network`, con el estado del
      // upgrade dentro cuando lo hubo.
      const blocked = error instanceof BlockedTargetError;
      const detail =
        error instanceof HandshakeRejectedError || blocked
          ? error.message
          : `no se pudo conectar: ${error instanceof Error ? error.message : String(error)}`;
      return (
        (await this.finish(session.id, "handshake-failed", { kind: blocked ? "config" : "network", detail })) ?? session
      );
    }
    // Puede que ya no esté viva: un servidor que abre y cierra en el mismo paquete termina la sesión
    // antes de que esta función vuelva. Entonces se espera a ese cierre y se devuelve lo que dejó.
    const finishing = this.closing.get(session.id);
    if (finishing) return (await finishing) ?? session;
    return (
      this.live.get(session.id)?.session ?? (await this.sessions.findById(session.projectId, session.id)) ?? session
    );
  }

  /**
   * Mandar un mensaje. Se anota **antes** de mandarlo, y anotado ya tapado: lo que sale en vivo y lo
   * que se guarda es el mensaje redactado; el texto crudo solo lo ve el socket.
   */
  async send(sessionId: string, text: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (!entry?.channel) throw this.notHere(sessionId);
    if (entry.plan.readOnly) {
      throw new ConflictError(
        `El entorno «${entry.plan.environmentName}» no permite escrituras: en él se escucha, pero no se manda. Actívalas en sus ajustes para mandar mensajes`,
        "writes-not-allowed",
      );
    }
    this.frame(sessionId, { direction: "out", atMs: this.at(entry), body: text });
    entry.channel.send(text);
    await entry.writes;
  }

  async close(sessionId: string, reason: StopReason = "closed-by-us", code = 1000): Promise<ChannelSession> {
    const closed = await this.finish(sessionId, reason, null, code);
    if (!closed) throw this.notHere(sessionId);
    return closed;
  }

  /** El reloj de las sesiones vivas. Público para que las pruebas lo muevan sin esperar un segundo. */
  async tick(): Promise<void> {
    for (const [id, entry] of this.live) {
      const stop = onTick(entry.session, this.at(entry), entry.plan.limits);
      if (stop) await this.finish(id, stop, null);
    }
  }

  /**
   * El latido por las mías, y el segador por las de todos.
   *
   * Cierra una sesión ajena solo cuando `isStale` lo dice —tres latidos sin llegar—, y nunca una de
   * las suyas: si está en `live`, su dueña soy yo y estoy viva.
   */
  async beat(): Promise<void> {
    const now = this.clock.now();
    try {
      if (this.live.size) await this.sessions.beat(this.instance, now);
      const stale = await this.sessions.findStale(new Date(now.getTime() - 3 * BEAT_MS));
      for (const session of stale) {
        if (this.live.has(session.id) || !isStale(session, now, BEAT_MS)) continue;
        // En rojo y con el motivo, no en verde: la conversación de la fila no trae mensajes y su
        // apertura sí consta, así que sin decirlo el veredicto sería «Conexión: abierta» y pasaría.
        // Una sesión cuyo proceso murió no puede salir como una que fue bien.
        const closed = closeSession(session, "transport-error", {}, now, {
          kind: "network",
          detail: `el proceso que tenía el socket (${session.ownerInstance}) dejó de latir`,
        });
        await this.sessions.save({ ...closed, stopReason: "transport-error" });
        this.logger.warn(`Sesión ${session.id} de ${session.ownerInstance} cerrada: su proceso dejó de latir`);
      }
    } catch (error) {
      // Un latido que falla no puede tumbar el proceso: el siguiente lo intenta otra vez.
      this.logger.error(`El latido de las sesiones falló: ${error instanceof Error ? error.message : error}`);
    }
  }

  private at(entry: Live): number {
    return Math.round(performance.now() - entry.startedAt);
  }

  /** Una trama, dentro de la sesión: estado, fila, emisión en vivo, y parada si toca. */
  private frame(sessionId: string, frame: RawFrame): void {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    const before = entry.session.conversation.messages.length;
    const { session, stop } = onFrame(entry.session, frame, entry.plan.limits, entry.plan.rules);
    entry.session = session;

    const added = session.conversation.messages.slice(before);
    entry.writes = entry.writes
      .then(() => (added.length ? this.sessions.appendMessages(sessionId, added) : undefined))
      .catch((error: unknown) =>
        this.logger.error(
          `No se pudo guardar un mensaje de ${sessionId}: ${error instanceof Error ? error.message : error}`,
        ),
      );

    if (frame.direction === "open" && frame.handshake) {
      this.stream.publish({ sessionId, type: "open", handshake: frame.handshake });
      entry.writes = entry.writes.then(() => this.sessions.save(entry.session));
    }
    for (const message of added) this.stream.publish({ sessionId, type: "message", message });

    // Un cierre del otro lado ya no tiene socket que cerrar; un tope sí.
    if (stop) void this.finish(sessionId, stop, null, frame.direction === "close" ? null : 1000);
  }

  private async finish(
    sessionId: string,
    reason: StopReason,
    openFailure: { kind: "network" | "config"; detail: string } | null,
    code: number | null = 1000,
  ): Promise<ChannelSession | null> {
    // Dos cierres que se cruzan —un tope y el cierre del otro lado en la misma trama— terminan una
    // sola vez: el segundo ya no encuentra la sesión viva y no hace nada.
    const entry = this.live.get(sessionId);
    if (!entry) return (await this.closing.get(sessionId)) ?? null;
    this.live.delete(sessionId);
    const done = this.settle(sessionId, entry, reason, openFailure, code);
    this.closing.set(sessionId, done);
    try {
      return await done;
    } finally {
      this.closing.delete(sessionId);
    }
  }

  private async settle(
    sessionId: string,
    entry: Live,
    reason: StopReason,
    openFailure: { kind: "network" | "config"; detail: string } | null,
    code: number | null,
  ): Promise<ChannelSession> {
    if (code !== null && entry.channel) {
      try {
        entry.channel.close(code, reason);
      } catch {
        // Ya estaba cerrado: lo que importa es la fila, no el socket.
      }
    }
    await entry.writes;
    const closed = closeSession(entry.session, reason, entry.plan.expect, this.clock.now(), openFailure);
    await this.sessions.save(closed);
    this.stream.publish({ sessionId, type: "finished", status: closed.status, stopReason: closed.stopReason });
    return closed;
  }

  private notHere(sessionId: string): ConflictError {
    return new ConflictError(
      `La sesión ${sessionId} no está abierta en esta instancia (${this.instance}): o ya terminó, o su socket lo tiene otra`,
      "channel-session-not-here",
    );
  }

  /** Para las pruebas y el cierre ordenado: cuántas tengo. */
  get size(): number {
    return this.live.size;
  }

  /** La sesión viva tal como la ve este proceso, con sus mensajes en memoria. */
  current(sessionId: string): ChannelSession | null {
    const entry = this.live.get(sessionId);
    return entry && !isFinished(entry.session) ? entry.session : null;
  }
}
