import type { Monitor, MonitorExecution } from "@/modules/monitors/domain/model";
import type { MonitorRepositoryPort } from "@/modules/monitors/domain/ports";
import { inLifecycleState, type LifecycleState } from "@/shared/lifecycle/lifecycle";

/**
 * El almacén de monitores en memoria.
 *
 * `claimDue` hace lo mismo que el de Postgres **menos lo único que importa de él**: la exclusión
 * entre procesos, que es del `FOR UPDATE SKIP LOCKED` y no se puede imitar en un `Map`. Aquí sirve
 * para probar lo demás —qué se considera vencido, que el turno se adelanta, que un monitor apagado
 * no entra— y que dos instancias no se pisen se comprueba contra la base de datos de verdad.
 */
export class InMemoryMonitorRepository implements MonitorRepositoryPort {
  readonly rows = new Map<string, Monitor>();
  readonly executions = new Map<string, MonitorExecution>();

  async listByProject(projectId: string, state: LifecycleState = "active") {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId && inLifecycleState(row, state))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findById(projectId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.projectId === projectId ? row : null;
  }

  async save(monitor: Monitor) {
    this.rows.set(monitor.id, structuredClone(monitor));
  }

  async remove(projectId: string, id: string) {
    const row = await this.findById(projectId, id);
    if (!row) return false;
    this.rows.delete(id);
    for (const [key, execution] of this.executions) if (execution.monitorId === id) this.executions.delete(key);
    return true;
  }

  async claimDue(now: Date, limit: number, nextRunAt: (monitor: Monitor) => Date | null) {
    const due = [...this.rows.values()]
      .filter(
        (row) =>
          row.enabled &&
          inLifecycleState(row, "active") &&
          row.nextRunAt !== null &&
          row.nextRunAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => (a.nextRunAt?.getTime() ?? 0) - (b.nextRunAt?.getTime() ?? 0))
      .slice(0, limit);
    // Devueltos con el turno ya adelantado, igual que el de Postgres: si aquí se devolviera el
    // viejo, el guardado que cierra la vuelta lo restauraría y ninguna prueba lo vería.
    return due.map((monitor) => {
      const claimed = { ...structuredClone(monitor), nextRunAt: nextRunAt(monitor) };
      this.rows.set(monitor.id, structuredClone(claimed));
      return claimed;
    });
  }

  async saveExecution(execution: MonitorExecution) {
    this.executions.set(execution.id, structuredClone(execution));
  }

  async findExecutionByRun(runId: string) {
    return [...this.executions.values()].find((execution) => execution.runId === runId) ?? null;
  }

  async listExecutions(monitorId: string, limit: number) {
    return [...this.executions.values()]
      .filter((execution) => execution.monitorId === monitorId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async trimExecutions(monitorId: string, keep: number) {
    const mine = [...this.executions.values()]
      .filter((execution) => execution.monitorId === monitorId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    for (const extra of mine.slice(keep)) this.executions.delete(extra.id);
  }
}
