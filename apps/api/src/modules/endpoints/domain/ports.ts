import type { EndpointExample } from "./examples";
import type { Endpoint, EndpointStatus } from "./model";

export const ENDPOINT_REPOSITORY = Symbol("ENDPOINT_REPOSITORY");

export type EndpointFilter = {
  status: EndpointStatus | "all";
  /** Case-insensitive, over the path and the description. */
  search: string;
  /**
   * Si se piden los eliminados en vez de los vivos.
   *
   * Un booleano y no el `LifecycleState` de los demás recursos porque un endpoint dice «archivado»
   * con su `status`, que ya viaja en este mismo filtro: un segundo campo capaz de decir lo mismo
   * dejaría dos formas de pedir los archivados y una de ellas ganaría sin que se vea cuál.
   */
  deleted: boolean;
  offset: number;
  limit: number;
};

/**
 * Every read takes `projectId`, including the ones with a primary key: an id from another tenant's
 * project must find nothing, and holding that here is holding it once. Deleted rows are invisible
 * to every method.
 */
export interface EndpointRepositoryPort {
  list(projectId: string, filter: EndpointFilter): Promise<{ rows: Endpoint[]; total: number }>;
  counts(projectId: string): Promise<Record<EndpointStatus, number>>;
  /** Cuántos hay en la papelera del proyecto: lo que el filtro «Eliminados» enseña al lado. */
  countDeleted(projectId: string): Promise<number>;
  /** Every live endpoint of the project, whatever its status. */
  listAll(projectId: string): Promise<Endpoint[]>;
  findById(projectId: string, id: string): Promise<Endpoint | null>;
  save(endpoint: Endpoint): Promise<void>;
  saveMany(endpoints: Endpoint[]): Promise<void>;
  setStatus(projectId: string, ids: string[], status: EndpointStatus, at: Date, actorId: string): Promise<number>;
  softDelete(projectId: string, ids: string[], at: Date): Promise<number>;
  /**
   * Devuelve a la vida los que estuvieran eliminados. Cuántos volvieron.
   *
   * Puede fallar por el índice único parcial de método y ruta: mientras el endpoint estaba en la
   * papelera alguien pudo crear otro `GET /users`, y entonces restaurarlo es un 409 y no una
   * segunda fila indistinguible.
   */
  restore(projectId: string, ids: string[], at: Date): Promise<number>;
  /** El borrado de verdad, con sus ejemplos por cascada. Solo «eliminar para siempre». */
  purge(projectId: string, ids: string[]): Promise<number>;
  nextOrderIndex(projectId: string): Promise<number>;
}

export const EXAMPLE_REPOSITORY = Symbol("EXAMPLE_REPOSITORY");

/**
 * Los ejemplos guardados de un endpoint.
 *
 * Como el de endpoints: **toda** lectura lleva `projectId`, incluidas las que ya tienen la clave
 * primaria. Un id de otro inquilino tiene que no encontrar nada, y sostener esa regla aquí es
 * sostenerla una vez en vez de en cada manejador.
 */
export interface ExampleRepositoryPort {
  listByEndpoint(projectId: string, endpointId: string): Promise<EndpointExample[]>;
  /** Todos los del proyecto, para exportar sin una consulta por endpoint. */
  listByProject(projectId: string): Promise<EndpointExample[]>;
  findById(projectId: string, id: string): Promise<EndpointExample | null>;
  save(example: EndpointExample): Promise<void>;
  saveMany(examples: EndpointExample[]): Promise<void>;
  remove(projectId: string, id: string): Promise<boolean>;
  countByEndpoint(projectId: string, endpointId: string): Promise<number>;
}
