import type { CaptureItem, CaptureSession } from "./model";

export const CAPTURE_REPOSITORY = Symbol("CAPTURE_REPOSITORY");

/**
 * Las sesiones de captura y lo que grabaron.
 *
 * **Toda lectura lleva `projectId`**, como en los endpoints y en los canales: un id de sesión o de
 * petición que alguien adivine no alcanza la captura de otro proyecto, porque la consulta nunca
 * pregunta solo por el id.
 *
 * Las peticiones se añaden de una en una y no se reescriben nunca: la sesión lleva la cuenta, y una
 * captura de quinientas no puede volver a escribir las quinientas cada vez que llega una.
 */
export interface CaptureRepositoryPort {
  saveSession(session: CaptureSession): Promise<void>;
  findSession(projectId: string, id: string): Promise<CaptureSession | null>;
  /** Las más recientes primero. */
  listSessions(projectId: string, limit: number): Promise<CaptureSession[]>;
  /** Las `active` de **cualquier** proyecto: al arrancar, las que quedaron abiertas sin proceso. */
  listActive(): Promise<CaptureSession[]>;
  removeSession(projectId: string, id: string): Promise<boolean>;
  appendItem(item: CaptureItem): Promise<void>;
  /** En orden de llegada, las que vienen después de `afterSeq`. */
  listItems(projectId: string, sessionId: string, afterSeq: number, limit: number): Promise<CaptureItem[]>;
  findItems(projectId: string, sessionId: string, ids: string[]): Promise<CaptureItem[]>;
}
