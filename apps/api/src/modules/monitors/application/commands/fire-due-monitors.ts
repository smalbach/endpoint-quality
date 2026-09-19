/**
 * El turno: tomar los monitores vencidos y lanzar sus corridas.
 *
 * Lo llama un intervalo, como el barrido de retención, y por la misma razón: no hace falta cron
 * para esto. Lo que **sí** hace falta, y el barrido no necesitaba, es que dos instancias no
 * disparen el mismo monitor — el barrido es idempotente y esto lanza corridas contra la API de
 * alguien. Eso lo resuelve `claimDue` en la base de datos; ver el puerto.
 *
 * El turno siguiente se calcula **desde ahora** y no sumando al turno perdido. Un proceso que
 * estuvo ocho horas caído no debe ocho corridas: debe una, la de ahora.
 */
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { nextOccurrence } from "../../domain/schedule";
import { MONITOR_REPOSITORY, type MonitorRepositoryPort } from "../../domain/ports";
import { MonitorFirer } from "./fire-monitor";

/** Cuántos se toman por turno. Un tope, para que una tabla entera vencida no sea una avalancha. */
export const CLAIM_LIMIT = 20;

export class FireDueMonitorsCommand implements ICommand {}

export type FireDueResult = { claimed: number; started: number; skipped: number; failed: number };

@CommandHandler(FireDueMonitorsCommand)
export class FireDueMonitorsHandler implements ICommandHandler<FireDueMonitorsCommand, FireDueResult> {
  constructor(
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    private readonly firer: MonitorFirer,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<FireDueResult> {
    const now = this.clock.now();
    const claimed = await this.monitors.claimDue(now, CLAIM_LIMIT, (monitor) => nextOccurrence(monitor.schedule, now));

    const result: FireDueResult = { claimed: claimed.length, started: 0, skipped: 0, failed: 0 };
    for (const monitor of claimed) {
      const project = await this.projects.findById(monitor.projectId);
      // `findById` no devuelve un proyecto borrado.
      if (!project) {
        // El proyecto se borró y la cascada aún no se ha llevado la fila, o el monitor quedó
        // huérfano: se apaga en vez de intentar una corrida contra nada.
        await this.monitors.save({ ...monitor, enabled: false, nextRunAt: null, updatedAt: now });
        continue;
      }
      const fired = await this.firer.fire(monitor, project.organizationId, now);
      if (fired.runId) result.started += 1;
      else if (fired.execution.outcome === "skipped") result.skipped += 1;
      else result.failed += 1;
    }
    return result;
  }
}
