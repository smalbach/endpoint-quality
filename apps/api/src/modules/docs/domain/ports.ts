import type { DocSite } from "./model";

export const DOC_SITE_REPOSITORY = Symbol("DOC_SITE_REPOSITORY");

/**
 * `findByPublicId` es la única lectura sin `projectId`, y no puede ser de otra manera: de la URL
 * pública solo llega ese segmento, y de ahí sale de qué proyecto es la documentación. Por eso el
 * `publicId` es aleatorio y no un número: **es lo único que hay entre la URL y los datos.**
 */
export interface DocSiteRepositoryPort {
  listByProject(projectId: string): Promise<DocSite[]>;
  findById(projectId: string, id: string): Promise<DocSite | null>;
  findByPublicId(publicId: string): Promise<DocSite | null>;
  save(site: DocSite): Promise<void>;
  remove(projectId: string, id: string): Promise<boolean>;
}
