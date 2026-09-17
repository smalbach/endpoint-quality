/**
 * Lanzar la corrida de un monitor: una vez, el mismo camino para el turno y para el botón.
 *
 * Que el planificador y «Correr ahora» pasen por aquí no es aseo: si fueran dos caminos, el del
 * botón se probaría a mano todos los días y el del turno —el que corre a las tres de la mañana— no
 * se probaría nunca, que es exactamente el que tiene que funcionar.
 *
 * Lo que decide esta función, en orden:
 *
 * 1. **¿Sigue viva la anterior?** Si sí, el turno se salta y se anota por qué. Un monitor cada
 *    cinco minutos contra una API que tarda seis no es vigilancia: es una cola que crece hasta que
 *    alguien la ve. Y no se pregunta a la fila de la vuelta anterior sino **a la corrida**: si un
 *    proceso se murió con una corrida a medias, su vuelta se quedó en «running» para siempre y el
 *    monitor no volvería a disparar nunca. Se cierra al pasar y se sigue.
 * 2. **¿Se puede lanzar?** El plan se valida en `StartRunCommand`, que es donde se valida el de
 *    todo el mundo. Si el flujo que apuntaba ya no existe, esto no revienta el planificador: la
 *    vuelta queda en «error» con el motivo, que es lo que hay que leer en la pantalla.
 */
import { Inject, Logger } from "@nestjs/common";
import { CommandBus } from "@nestjs/cqrs";

import { isFinished } from "@/modules/runs/domain/model";
import { RUN_REPOSITORY, type RunRepositoryPort } from "@/modules/runs/domain/ports";
import { StartRunCommand } from "@/modules/runs/application/commands/start-run";
import {
  MONITOR_HISTORY,
  afterExecution,
  blankExecution,
  outcomeOf,
  type Monitor,
  type MonitorExecution,
} from "../../domain/model";
import { MONITOR_REPOSITORY, type MonitorRepositoryPort } from "../../domain/ports";

export type FireResult = { execution: MonitorExecution; runId: string | null };

export class MonitorFirer {
  private readonly logger = new Logger("Monitors");

  constructor(
    private readonly commandBus: CommandBus,
    @Inject(MONITOR_REPOSITORY) private readonly monitors: MonitorRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
  ) {}

  async fire(monitor: Monitor, organizationId: string, now: Date): Promise<FireResult> {
    const overlapping = await this.stillRunning(monitor, now);
    if (overlapping) {
      const execution = blankExecution({
        monitorId: monitor.id,
        projectId: monitor.projectId,
        runId: null,
        outcome: "skipped",
        now,
        note: "La corrida anterior de este monitor seguía en marcha",
      });
      await this.record(monitor, execution, now);
      return { execution, runId: null };
    }

    try {
      const { runId } = await this.commandBus.execute<StartRunCommand, { runId: string }>(
        new StartRunCommand(
          organizationId,
          monitor.projectId,
          { ...monitor.plan },
          {
            kind: "monitor",
            id: monitor.id,
          },
        ),
      );
      const execution = blankExecution({
        monitorId: monitor.id,
        projectId: monitor.projectId,
        runId,
        outcome: "running",
        now,
      });
      await this.record(monitor, execution, now);
      return { execution, runId };
    } catch (error) {
      // Un plan que dejó de ser válido —el flujo borrado, el entorno borrado— es un error del
      // monitor y no del planificador: se anota y el resto de los monitores siguen su turno.
      const note = error instanceof Error ? error.message : String(error);
      this.logger.warn(`El monitor «${monitor.name}» no pudo lanzar su corrida: ${note}`);
      const execution = blankExecution({
        monitorId: monitor.id,
        projectId: monitor.projectId,
        runId: null,
        outcome: "error",
        now,
        note,
      });
      await this.record(monitor, execution, now);
      return { execution, runId: null };
    }
  }

  /**
   * Si la vuelta anterior sigue de verdad en marcha.
   *
   * La fila dice «running»; la corrida dice la verdad. Una vuelta abierta cuya corrida ya terminó
   * se cierra aquí —con el estado que tuvo— en vez de bloquear el monitor para siempre.
   */
  private async stillRunning(monitor: Monitor, now: Date): Promise<boolean> {
    const [last] = await this.monitors.listExecutions(monitor.id, 1);
    if (!last || last.outcome !== "running") return false;
    if (!last.runId) {
      // Sin corrida no hay nada que esperar: la vuelta se quedó abierta por un fallo al escribir.
      await this.monitors.saveExecution({ ...last, outcome: "error", finishedAt: now, note: "Quedó sin cerrar" });
      return false;
    }
    const run = await this.runs.findById(last.runId);
    if (run && !isFinished(run.status)) return true;
    await this.monitors.saveExecution({
      ...last,
      outcome: run ? outcomeOf(run.status) : "error",
      finishedAt: run?.finishedAt ?? now,
      // Una corrida que la retención ya borró: la vuelta se cierra igual, porque dejarla abierta
      // dejaría el monitor mudo para siempre.
      note: run ? "" : "La corrida ya no existe",
    });
    return false;
  }

  private async record(monitor: Monitor, execution: MonitorExecution, now: Date): Promise<void> {
    await this.monitors.saveExecution(execution);
    // Una vuelta saltada no toca el estado del monitor: no se midió nada, así que no es ni un
    // fallo ni un acierto. `afterExecution` lo sabe.
    if (execution.outcome !== "running") await this.monitors.save(afterExecution(monitor, execution.outcome, now));
    await this.monitors.trimExecutions(monitor.id, MONITOR_HISTORY);
  }
}
