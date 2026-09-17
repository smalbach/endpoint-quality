/**
 * El reloj: llama al turno cada tanto, y nada más.
 *
 * Igual que el barrido de retención —un `setInterval` con `unref`, sin cron y sin candado— con una
 * diferencia que importa: **el barrido es idempotente y esto lanza corridas**. Lo que impide que dos
 * instancias disparen el mismo monitor no está aquí sino en `claimDue`, que lo cierra en la base de
 * datos. Este fichero puede correr en las dos instancias a la vez sin consecuencias, y de hecho
 * tiene que poder: si hiciera falta elegir una instancia «líder», un despliegue sin la elegida
 * dejaría de vigilar en silencio.
 *
 * El intervalo es corto (un minuto por defecto) y eso decide la precisión del horario: un monitor a
 * las 9:00 dispara entre las 9:00 y las 9:01. Afinarlo más sería consultar la tabla sesenta veces
 * por minuto para adelantar un turno unos segundos.
 *
 * `unref` para que un contenedor al que se le dice que pare, pare — y no espere al turno siguiente.
 */
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";

import { ENV, type Env } from "@/shared/config/env";
import { FireDueMonitorsCommand, type FireDueResult } from "../application/commands/fire-due-monitors";

@Injectable()
export class MonitorScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Monitors");
  private timer?: NodeJS.Timeout;
  /** Un turno a la vez en este proceso: si una vuelta tarda más que el intervalo, no se apilan. */
  private running = false;

  constructor(
    private readonly commandBus: CommandBus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.env.MONITOR_TICK_SECONDS;
    if (!seconds) {
      this.logger.log("Monitores desactivados: MONITOR_TICK_SECONDS=0");
      return;
    }
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
    // Nada al arrancar, al contrario que la retención. Un despliegue que reinicia varias veces
    // seguidas dispararía una corrida por reinicio, y lo que se pidió fue un horario.
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.commandBus.execute<FireDueMonitorsCommand, FireDueResult>(new FireDueMonitorsCommand());
      if (result.claimed)
        this.logger.log(
          `Turno: ${result.claimed} vencidos · ${result.started} lanzados · ${result.skipped} saltados · ${result.failed} con error`,
        );
    } catch (error) {
      // Un fallo del turno se anota y se reintenta en el siguiente. Un hipo de la base de datos
      // mientras se vigila no puede tumbar la API.
      this.logger.warn(
        `El turno de monitores falló y se reintentará: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
