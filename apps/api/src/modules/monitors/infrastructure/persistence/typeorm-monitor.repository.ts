import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";

import { MonitorEntity, MonitorExecutionEntity } from "@/shared/database/entities";
import type { Monitor, MonitorExecution } from "../../domain/model";
import type { MonitorRepositoryPort } from "../../domain/ports";

const toMonitor = (row: MonitorEntity): Monitor => row as unknown as Monitor;
const toExecution = (row: MonitorExecutionEntity): MonitorExecution => row as unknown as MonitorExecution;

@Injectable()
export class TypeOrmMonitorRepository implements MonitorRepositoryPort {
  constructor(
    @InjectRepository(MonitorEntity) private readonly monitors: Repository<MonitorEntity>,
    @InjectRepository(MonitorExecutionEntity) private readonly executions: Repository<MonitorExecutionEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async listByProject(projectId: string): Promise<Monitor[]> {
    const rows = await this.monitors.find({ where: { projectId }, order: { createdAt: "ASC" } });
    return rows.map(toMonitor);
  }

  async findById(projectId: string, id: string): Promise<Monitor | null> {
    const row = await this.monitors.findOne({ where: { id, projectId } });
    return row ? toMonitor(row) : null;
  }

  async save(monitor: Monitor): Promise<void> {
    await this.monitors.save(this.monitors.create(monitor as unknown as MonitorEntity));
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const result = await this.monitors.delete({ id, projectId });
    return Boolean(result.affected);
  }

  /**
   * El reclamo. Ver el comentario del puerto: esto es lo que impide que dos instancias lancen la
   * misma corrida, y lo que lo impide es `FOR UPDATE SKIP LOCKED`, no un candado nuestro.
   *
   * El `UPDATE` de `nextRunAt` va **en la misma transacción** que el `SELECT` que bloqueó la fila.
   * Si se hiciera después, entre el commit y el update habría una ventana en la que el monitor
   * sigue vencido y la otra instancia lo toma.
   */
  async claimDue(now: Date, limit: number, nextRunAt: (monitor: Monitor) => Date | null): Promise<Monitor[]> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(MonitorEntity);
      const rows = await repository
        .createQueryBuilder("monitor")
        .setLock("pessimistic_write")
        // Sin esto, la segunda instancia **espera** a que la primera suelte la fila y después la
        // procesa igual: la corrida saldría dos veces, una detrás de otra.
        .setOnLocked("skip_locked")
        .where("monitor.enabled = true")
        .andWhere('monitor."nextRunAt" IS NOT NULL')
        .andWhere('monitor."nextRunAt" <= :now', { now })
        .orderBy('monitor."nextRunAt"', "ASC")
        .limit(limit)
        .getMany();

      const claimed: Monitor[] = [];
      for (const row of rows.map(toMonitor)) {
        const next = nextRunAt(row);
        await repository.update({ id: row.id }, { nextRunAt: next });
        // Devuelto **con el turno ya adelantado**, y esto no es cosmética: quien recibe el monitor
        // lo va a guardar entero después (la racha, el último resultado), y si el objeto llevara el
        // turno viejo ese guardado lo restauraría. El monitor volvería a estar vencido y dispararía
        // en cada tic. Pasó de verdad, y solo se vio contra la base de datos.
        claimed.push({ ...row, nextRunAt: next });
      }
      return claimed;
    });
  }

  async saveExecution(execution: MonitorExecution): Promise<void> {
    await this.executions.save(this.executions.create(execution as unknown as MonitorExecutionEntity));
  }

  async findExecutionByRun(runId: string): Promise<MonitorExecution | null> {
    const row = await this.executions.findOne({ where: { runId } });
    return row ? toExecution(row) : null;
  }

  async listExecutions(monitorId: string, limit: number): Promise<MonitorExecution[]> {
    const rows = await this.executions.find({ where: { monitorId }, order: { startedAt: "DESC" }, take: limit });
    return rows.map(toExecution);
  }

  /** Por `startedAt` y no por `id`: lo que sobra son las viejas, y el id no dice cuál es vieja. */
  async trimExecutions(monitorId: string, keep: number): Promise<void> {
    const rows = await this.executions.find({
      where: { monitorId },
      order: { startedAt: "DESC" },
      select: ["id"],
      skip: keep,
      take: 1_000,
    });
    if (rows.length) await this.executions.delete(rows.map((row) => row.id));
  }
}
