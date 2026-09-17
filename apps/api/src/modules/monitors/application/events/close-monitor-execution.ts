/**
 * La corrida de un monitor terminó: cerrar su vuelta, contar la racha y avisar si toca.
 *
 * Escucha `RunFinishedEvent` y no consulta nada en bucle, que es la diferencia entre saber el
 * resultado en el mismo segundo y descubrirlo en el turno siguiente. La primera cosa que hace es
 * mirar si esa corrida era de un monitor: la gran mayoría no lo son, y para ésas esto es una
 * lectura por `runId` y nada más.
 *
 * El aviso sale **aquí** y no en el turno, porque lo que se avisa es un resultado y el resultado
 * llega minutos después de lanzarse la corrida.
 */
import { Inject } from "@nestjs/common";
import { EventsHandler, type IEventHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { RunFinishedEvent } from "@/modules/runs/application/events/run.events";
import { afterExecution, outcomeOf, shouldAlert } from "../../domain/model";
import { MONITOR_REPOSITORY, type MonitorRepositoryPort } from "../../domain/ports";
import { MonitorAlerter } from "../../infrastructure/monitor-alert";

@EventsHandler(RunFinishedEvent)
export class CloseMonitorExecutionHandler implements IEventHandler<RunFinishedEvent> {
  constructor(
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    private readonly alerter: MonitorAlerter,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async handle(event: RunFinishedEvent): Promise<void> {
    const execution = await this.monitors.findExecutionByRun(event.runId);
    if (!execution || execution.outcome !== "running") return;

    const monitor = await this.monitors.findById(execution.projectId, execution.monitorId);
    const now = this.clock.now();
    const outcome = outcomeOf(event.status);
    const totals = { cases: event.totals.cases, passed: event.totals.passed, failed: event.totals.failed };

    if (!monitor) {
      // El monitor se borró mientras su corrida andaba. La vuelta se cierra igual: es el historial
      // de algo que de verdad pasó.
      await this.monitors.saveExecution({ ...execution, outcome, finishedAt: now, totals });
      return;
    }

    // La racha **de antes** de esta vuelta, que es la que decide si este fallo es el que avisa.
    const previousFailures = monitor.consecutiveFailures;
    const updated = afterExecution(monitor, outcome, now);
    await this.monitors.save(updated);

    const kind = shouldAlert(monitor, outcome, previousFailures);
    let note = "";
    if (kind) {
      const project = await this.projects.findById(monitor.projectId);
      note = await this.alerter.send(monitor, project?.name ?? "", kind, {
        runId: event.runId,
        outcome,
        failures: kind === "down" ? previousFailures + 1 : previousFailures,
        totals,
        note: execution.note,
      });
    }

    await this.monitors.saveExecution({ ...execution, outcome, finishedAt: now, totals, note: note || execution.note });
  }
}
