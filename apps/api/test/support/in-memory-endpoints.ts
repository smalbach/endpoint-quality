import type { Endpoint, EndpointStatus } from "@/modules/endpoints/domain/model";
import type { EndpointExample } from "@/modules/endpoints/domain/examples";
import type {
  EndpointFilter,
  EndpointRepositoryPort,
  ExampleRepositoryPort,
} from "@/modules/endpoints/domain/ports";

export class InMemoryEndpointRepository implements EndpointRepositoryPort {
  readonly rows = new Map<string, Endpoint>();

  private live(projectId: string): Endpoint[] {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId && !row.deletedAt)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.path.localeCompare(b.path));
  }

  async list(projectId: string, filter: EndpointFilter) {
    const search = filter.search.toLowerCase();
    const scope = filter.deleted ? this.trashed(projectId) : this.live(projectId);
    const matching = scope.filter(
      (row) =>
        (filter.status === "all" || row.status === filter.status) &&
        (!search || row.path.toLowerCase().includes(search) || row.description.toLowerCase().includes(search)),
    );
    return { rows: matching.slice(filter.offset, filter.offset + filter.limit), total: matching.length };
  }

  /** Los eliminados, en el mismo orden que los vivos: es la misma lista, en otro estado. */
  private trashed(projectId: string): Endpoint[] {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId && row.deletedAt)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.path.localeCompare(b.path));
  }

  async countDeleted(projectId: string): Promise<number> {
    return this.trashed(projectId).length;
  }

  async counts(projectId: string): Promise<Record<EndpointStatus, number>> {
    const counts: Record<EndpointStatus, number> = { active: 0, archived: 0, inactive: 0 };
    for (const row of this.live(projectId)) counts[row.status] += 1;
    return counts;
  }

  async listAll(projectId: string) {
    return this.live(projectId);
  }

  async findById(projectId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.projectId === projectId && !row.deletedAt ? row : null;
  }

  async save(endpoint: Endpoint) {
    this.rows.set(endpoint.id, structuredClone(endpoint));
  }

  async saveMany(endpoints: Endpoint[]) {
    for (const endpoint of endpoints) await this.save(endpoint);
  }

  async setStatus(projectId: string, ids: string[], status: EndpointStatus, at: Date, actorId: string) {
    let updated = 0;
    for (const id of ids) {
      const row = await this.findById(projectId, id);
      if (!row) continue;
      this.rows.set(id, { ...row, status, updatedAt: at, updatedBy: actorId });
      updated += 1;
    }
    return updated;
  }

  async restore(projectId: string, ids: string[], at: Date) {
    let restored = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || row.projectId !== projectId || !row.deletedAt) continue;
      // El índice único parcial de la migración, respetado aquí: si mientras estaba fuera se creó
      // otro con el mismo método y ruta, restaurarlo choca en Postgres y tiene que chocar aquí.
      if (this.live(projectId).some((other) => other.method === row.method && other.path === row.path))
        throw new Error("duplicate key value violates unique constraint UQ_endpoints_live_method_path");
      this.rows.set(id, { ...row, deletedAt: null, updatedAt: at });
      restored += 1;
    }
    return restored;
  }

  async purge(projectId: string, ids: string[]) {
    let purged = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || row.projectId !== projectId || !row.deletedAt) continue;
      this.rows.delete(id);
      purged += 1;
    }
    return purged;
  }

  async softDelete(projectId: string, ids: string[], at: Date) {
    let deleted = 0;
    for (const id of ids) {
      const row = await this.findById(projectId, id);
      if (!row) continue;
      this.rows.set(id, { ...row, deletedAt: at });
      deleted += 1;
    }
    return deleted;
  }

  async nextOrderIndex(projectId: string) {
    const all = [...this.rows.values()].filter((row) => row.projectId === projectId);
    return all.length ? Math.max(...all.map((row) => row.orderIndex)) + 1 : 0;
  }
}

/**
 * Los ejemplos guardados, en memoria.
 *
 * Ordenados igual que la tabla —`orderIndex` y luego la fecha— y con `projectId` en cada lectura
 * aunque haya un id: si aquí se ignorara, una prueba de aislamiento entre inquilinos pasaría
 * mintiendo.
 */
export class InMemoryExampleRepository implements ExampleRepositoryPort {
  readonly rows = new Map<string, EndpointExample>();

  private sorted(examples: EndpointExample[]): EndpointExample[] {
    return examples.sort(
      (a, b) => a.orderIndex - b.orderIndex || a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  async listByEndpoint(projectId: string, endpointId: string) {
    return this.sorted(
      [...this.rows.values()].filter((row) => row.projectId === projectId && row.endpointId === endpointId),
    );
  }

  async listByProject(projectId: string) {
    return this.sorted([...this.rows.values()].filter((row) => row.projectId === projectId));
  }

  async findById(projectId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.projectId === projectId ? row : null;
  }

  async save(example: EndpointExample) {
    this.rows.set(example.id, structuredClone(example));
  }

  async saveMany(examples: EndpointExample[]) {
    for (const example of examples) await this.save(example);
  }

  async remove(projectId: string, id: string) {
    const row = await this.findById(projectId, id);
    if (!row) return false;
    this.rows.delete(id);
    return true;
  }

  async countByEndpoint(projectId: string, endpointId: string) {
    return (await this.listByEndpoint(projectId, endpointId)).length;
  }
}
