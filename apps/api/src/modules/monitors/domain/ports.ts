import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import type { Monitor, MonitorExecution } from "./model";

export const MONITOR_REPOSITORY = Symbol("MONITOR_REPOSITORY");

/**
 * El almacén de monitores, con una operación que no es un `find` ni un `save`: **el reclamo**.
 *
 * `claimDue` existe porque dos instancias de la API con el mismo Postgres detrás verían los mismos
 * monitores vencidos en el mismo segundo, y sin reclamo los dos lanzarían la corrida. No es una
 * carrera rara que pase de vez en cuando: con dos instancias y un turno en punto, pasa **siempre**.
 *
 * Lo que lo cierra es la base de datos y no un candado en memoria: `SELECT … FOR UPDATE SKIP
 * LOCKED` dentro de una transacción entrega cada fila a una sola instancia y hace que la otra la
 * salte en vez de esperarla. En la misma transacción se adelanta `nextRunAt`, así que cuando la
 * transacción cierra el monitor ya no está vencido para nadie.
 *
 * `nextRunAt` lo calcula el dominio y no el SQL, y por eso `claimDue` recibe una función: el
 * horario tiene zona, días de la semana y dos días raros al año, y eso no se escribe en una
 * expresión de Postgres sin duplicar las reglas en un sitio donde no se pueden probar.
 */
export interface MonitorRepositoryPort {
  /**
   * Los monitores de un proyecto en ese estado. Sin estado, los activos: la pantalla que se abre
   * sin filtros enseña lo que está vigilando, no lo archivado ni lo borrado.
   */
  listByProject(projectId: string, state?: LifecycleState): Promise<Monitor[]>;
  /** Por id **en cualquier estado**: restaurar algo borrado empieza por encontrarlo. */
  findById(projectId: string, id: string): Promise<Monitor | null>;
  save(monitor: Monitor): Promise<void>;
  /** El borrado de verdad, el que no se deshace. Solo lo llama «eliminar para siempre». */
  remove(projectId: string, id: string): Promise<boolean>;

  /**
   * Toma hasta `limit` monitores vencidos, adelanta su turno y los devuelve. Otra instancia que
   * corra esto a la vez no verá ninguno de los que esta se ha llevado.
   *
   * Los devuelve **con el turno ya adelantado**. Quien los recibe guarda el monitor entero al
   * cerrar la vuelta, y un objeto con el turno viejo restauraría el vencimiento: el monitor
   * dispararía en cada tic para siempre.
   */
  claimDue(now: Date, limit: number, nextRunAt: (monitor: Monitor) => Date | null): Promise<Monitor[]>;

  saveExecution(execution: MonitorExecution): Promise<void>;
  /** La vuelta abierta de esa corrida, para cerrarla cuando la corrida termine. */
  findExecutionByRun(runId: string): Promise<MonitorExecution | null>;
  listExecutions(monitorId: string, limit: number): Promise<MonitorExecution[]>;
  /** Deja solo las `keep` últimas de ese monitor. El historial no crece sin fin. */
  trimExecutions(monitorId: string, keep: number): Promise<void>;
}
