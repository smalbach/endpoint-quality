import { Logger } from "@nestjs/common";

import type { InstanceBusPort } from "../bus/instance-bus";
import type { ExecutionTurnStorePort, TurnKind } from "./execution-turns";

/** Se difunde al dejar un turno, para que quien espera en otra instancia no aguarde a su sondeo. */
const TURN_FREED_TOPIC = "execution-turn.freed";

export type TurnTiming = {
  /** Cada cuánto se vuelve a mirar si toca, si el aviso por el bus no llega. */
  pollMs: number;
  /** Cada cuánto dice una instancia que sigue viva, por todas sus filas. */
  heartbeatMs: number;
  /** Cuánto sin latir hace falta para dar una fila por muerta. Varios latidos: uno perdido no basta. */
  staleMs: number;
};

export const DEFAULT_TURN_TIMING: TurnTiming = { pollMs: 1_000, heartbeatMs: 5_000, staleMs: 30_000 };

/**
 * El turno de una cola en memoria, visto desde una instancia: apuntarse al encolar, esperar a que
 * toque antes de ejecutar y dejarlo al terminar. La cola sigue siendo suya —sus corridas las ejecuta
 * ella, en su orden—; lo que se comparte es solo cuándo puede empezar la siguiente.
 *
 * **Esperar es sondear, con un atajo.** Quien deja un turno lo dice por el bus y las demás miran en
 * el acto; sin bus, o si el aviso se pierde, miran cada `pollMs`. El bus es el camino rápido y la
 * base el correcto: un aviso que no llega retrasa un segundo, no rompe el orden.
 *
 * **La base caída no se salta el turno.** Si no se puede preguntar, no se empieza: esperar de más es
 * mejor que dos cargas a la vez contra el mismo objetivo. Se avisa una vez, no en cada intento.
 *
 * Lo que no cubre: una instancia viva que no consigue latir durante `staleMs` —la base caída para
 * ella y no para las demás— pierde su fila y otra puede empezar mientras la suya sigue. Se dice en el
 * registro; parar una carga a medias por eso sería peor que el solape.
 */
export class ExecutionTurnGate {
  private readonly logger: Logger;
  /** Las corridas de esta instancia con fila: esperando o corriendo. Es lo que late. */
  private readonly held = new Set<string>();
  private readonly running = new Set<string>();
  private readonly wakers = new Set<() => void>();
  /** Un aviso que llegó mientras nadie dormía —estaba preguntando—: la próxima espera no espera. */
  private nudged = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private failing = false;
  private closed = false;

  constructor(
    private readonly store: ExecutionTurnStorePort,
    private readonly bus: InstanceBusPort,
    private readonly kind: TurnKind,
    private readonly timing: TurnTiming = DEFAULT_TURN_TIMING,
  ) {
    this.logger = new Logger(`ExecutionTurn:${kind}`);
    this.bus.subscribe<{ kind: TurnKind }>(TURN_FREED_TOPIC, (message) => {
      if (message.kind === this.kind) this.nudge();
    });
  }

  /** Al encolar: el sitio en la fila es el de ahora, aunque la instancia tarde en llegar a ella. */
  async join(runId: string): Promise<void> {
    this.hold(runId);
    try {
      await this.store.join(this.kind, runId, this.bus.instanceId);
    } catch (error) {
      // `take` se vuelve a apuntar antes de pedir turno: fallar aquí solo cuesta el sitio.
      this.fail(error);
    }
  }

  /**
   * Espera a que toque `runId`. `false` si mientras esperaba dejó de quererse —la cancelaron y la
   * cola la sacó—, y entonces ya no está en la fila.
   */
  async take(runId: string, wanted: () => boolean = () => true): Promise<boolean> {
    this.hold(runId);
    for (;;) {
      if (this.closed) return false;
      if (!wanted()) {
        await this.leave(runId);
        return false;
      }
      try {
        // Otra vez, por si la fila se perdió: la base no contestaba al encolar, o no se pudo latir y
        // otra instancia la dio por muerta. Si sigue ahí, no cambia nada.
        await this.store.join(this.kind, runId, this.bus.instanceId);
        if (await this.store.tryStart(this.kind, runId, this.bus.instanceId, this.timing.staleMs)) {
          this.running.add(runId);
          this.recovered();
          return true;
        }
        this.recovered();
      } catch (error) {
        this.fail(error);
      }
      await this.sleep(this.timing.pollMs);
    }
  }

  /** Terminó, o no llegó a empezar: fuera de la fila, y quien espera en otra instancia se entera. */
  async leave(runId: string): Promise<void> {
    this.held.delete(runId);
    this.running.delete(runId);
    if (this.held.size === 0) this.stopHeartbeat();
    try {
      await this.store.leave(runId, this.bus.instanceId);
    } catch (error) {
      // Sin borrar, la fila deja de latir y caduca sola en `staleMs`: la siguiente espera eso.
      this.fail(error);
    }
    this.bus.publish(TURN_FREED_TOPIC, { kind: this.kind });
  }

  /** Deja de latir y de esperar (al apagar). Las filas que queden caducan solas. */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.nudge();
  }

  private hold(runId: string): void {
    this.held.add(runId);
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.beat(), this.timing.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async beat(): Promise<void> {
    let beaten: string[];
    try {
      beaten = await this.store.heartbeat(this.bus.instanceId);
      this.recovered();
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const runId of [...this.running])
      if (!beaten.includes(runId)) {
        // Una vez por corrida: sigue ejecutándose, y repetirlo en cada latido no añade nada.
        this.running.delete(runId);
        this.logger.warn(
          `La corrida ${runId} sigue aquí pero perdió su turno (sin latido a tiempo): otra puede haber empezado`,
        );
      }
  }

  private sleep(ms: number): Promise<void> {
    if (this.nudged) {
      this.nudged = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private nudge(): void {
    if (this.wakers.size === 0) this.nudged = true;
    for (const wake of [...this.wakers]) wake();
  }

  private fail(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    this.logger.warn(
      `No se pudo consultar el turno: ${error instanceof Error ? error.message : String(error)}. No se empieza nada hasta que conteste`,
    );
  }

  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.logger.log("El turno vuelve a responder");
  }
}
