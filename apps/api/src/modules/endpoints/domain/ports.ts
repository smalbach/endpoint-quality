import type { Endpoint, EndpointStatus } from "./model";

export const ENDPOINT_REPOSITORY = Symbol("ENDPOINT_REPOSITORY");

export type EndpointFilter = {
  status: EndpointStatus | "all";
  /** Case-insensitive, over the path and the description. */
  search: string;
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
  /** Every live endpoint of the project, whatever its status. */
  listAll(projectId: string): Promise<Endpoint[]>;
  findById(projectId: string, id: string): Promise<Endpoint | null>;
  save(endpoint: Endpoint): Promise<void>;
  saveMany(endpoints: Endpoint[]): Promise<void>;
  setStatus(projectId: string, ids: string[], status: EndpointStatus, at: Date, actorId: string): Promise<number>;
  softDelete(projectId: string, ids: string[], at: Date): Promise<number>;
  nextOrderIndex(projectId: string): Promise<number>;
}
