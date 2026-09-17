import type { MockServer } from "./model";

export const MOCK_REPOSITORY = Symbol("MOCK_REPOSITORY");

/**
 * `findByPublicId` es la única lectura sin `projectId`, y no puede ser de otra manera: la petición
 * que llega al mock trae la URL y nada más, y de ahí sale a qué proyecto pertenece. Por eso el
 * `publicId` es aleatorio y no un número: **es la única cosa que hay entre la URL y los datos.**
 */
export interface MockRepositoryPort {
  listByProject(projectId: string): Promise<MockServer[]>;
  findById(projectId: string, id: string): Promise<MockServer | null>;
  findByPublicId(publicId: string): Promise<MockServer | null>;
  save(mock: MockServer): Promise<void>;
  remove(projectId: string, id: string): Promise<boolean>;
}
