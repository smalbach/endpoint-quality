import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import type { MockCall } from "./mock-call";
import type { MockServer } from "./model";

export const MOCK_REPOSITORY = Symbol("MOCK_REPOSITORY");

/**
 * `findByPublicId` es la única lectura sin `projectId`, y no puede ser de otra manera: la petición
 * que llega al mock trae la URL y nada más, y de ahí sale a qué proyecto pertenece. Por eso el
 * `publicId` es aleatorio y no un número: **es la única cosa que hay entre la URL y los datos.**
 */
export interface MockRepositoryPort {
  /** Los de ese estado. Sin estado, los activos: la pantalla no se abre por la papelera. */
  listByProject(projectId: string, state?: LifecycleState): Promise<MockServer[]>;
  /** Por id **en cualquier estado**: restaurar algo borrado empieza por encontrarlo. */
  findById(projectId: string, id: string): Promise<MockServer | null>;
  /**
   * El que sirve esa URL, y **solo si está vivo**. Un mock archivado o eliminado cuyo `publicId`
   * siguiera contestando estaría fuera de la lista y dentro del front de otro equipo, que es la
   * peor mitad de las dos.
   */
  findByPublicId(publicId: string): Promise<MockServer | null>;
  save(mock: MockServer): Promise<void>;
  /** El borrado de verdad. Solo lo llama «eliminar para siempre». */
  remove(projectId: string, id: string): Promise<boolean>;

  /** Una llamada servida. Quien lo llama traga el fallo: el mock contesta aunque esto no escriba. */
  saveCall(call: MockCall): Promise<void>;
  listCalls(mockServerId: string, limit: number): Promise<MockCall[]>;
  /** Deja solo las `keep` últimas de ese mock. La bitácora de una URL pública la llena un tercero. */
  trimCalls(mockServerId: string, keep: number): Promise<void>;
}
