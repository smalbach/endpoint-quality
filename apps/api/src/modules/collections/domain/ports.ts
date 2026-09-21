import type { CollectionRow, CollectionRun } from "./model";

export const COLLECTION_REPOSITORY = Symbol("COLLECTION_REPOSITORY");
export const COLLECTION_RUN_REPOSITORY = Symbol("COLLECTION_RUN_REPOSITORY");
export const COLLECTION_RUN_QUEUE = Symbol("COLLECTION_RUN_QUEUE");

/**
 * Toda lectura lleva `projectId`, también las que ya tienen la clave primaria: la misma regla que
 * siguen flujos y planes, para que «corre la colección X» no pueda alcanzar la de otro inquilino
 * sabiendo solo un id.
 */
export interface CollectionRepositoryPort {
  list(projectId: string): Promise<CollectionRow[]>;
  find(projectId: string, collectionId: string): Promise<CollectionRow | null>;
  /** Por nombre: importar la misma colección dos veces la actualiza en vez de duplicarla. */
  findByName(projectId: string, name: string): Promise<CollectionRow | null>;
  save(row: CollectionRow): Promise<void>;
  delete(projectId: string, collectionId: string): Promise<void>;
}

export interface CollectionRunRepositoryPort {
  list(projectId: string, collectionId?: string): Promise<CollectionRun[]>;
  find(projectId: string, runId: string): Promise<CollectionRun | null>;
  /** La última de cada colección, para la lista. Una consulta y no una por tarjeta. */
  latestByCollection(projectId: string): Promise<Map<string, CollectionRun>>;
  /** Por id a secas, para el ejecutor: la cola lleva un id de corrida y ningún inquilino. */
  findById(runId: string): Promise<CollectionRun | null>;
  save(run: CollectionRun): Promise<void>;
  delete(projectId: string, runId: string): Promise<void>;
}

/**
 * Una corrida de colección a la vez, y cancelable en el hueco entre dos peticiones.
 *
 * La misma forma que la cola de rendimiento y la de seguridad, por lo mismo: una colección corriendo
 * está escribiendo en el API de alguien —crea filas, las borra— y dos a la vez sobre el mismo
 * entorno se pisan los datos que cada una creó para sí. Cancelar es una marca que el ejecutor mira
 * antes de mandar la siguiente petición; la que está en vuelo no se interrumpe.
 */
export interface CollectionRunQueuePort {
  enqueue(runId: string): Promise<void>;
  process(handler: (runId: string) => Promise<void>): void;
  cancel(runId: string): Promise<void>;
  isCancelled(runId: string): boolean;
}
