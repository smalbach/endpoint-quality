import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import type { DocSite } from "./model";

export const DOC_SITE_REPOSITORY = Symbol("DOC_SITE_REPOSITORY");

/**
 * `findByPublicId` es la única lectura sin `projectId`, y no puede ser de otra manera: de la URL
 * pública solo llega ese segmento, y de ahí sale de qué proyecto es la documentación. Por eso el
 * `publicId` es aleatorio y no un número: **es lo único que hay entre la URL y los datos.**
 */
export interface DocSiteRepositoryPort {
  /** Las de ese estado. Sin estado, las activas. */
  listByProject(projectId: string, state?: LifecycleState): Promise<DocSite[]>;
  /** Por id **en cualquier estado**: restaurar una borrada empieza por encontrarla. */
  findById(projectId: string, id: string): Promise<DocSite | null>;
  /**
   * La que sirve esa URL, y **solo si está viva**. Una documentación archivada o eliminada cuya URL
   * siguiera publicando sería una página fuera de la lista y dentro del correo de otro equipo.
   */
  findByPublicId(publicId: string): Promise<DocSite | null>;
  save(site: DocSite): Promise<void>;
  /** El borrado de verdad. Solo lo llama «eliminar para siempre». */
  remove(projectId: string, id: string): Promise<boolean>;
}
