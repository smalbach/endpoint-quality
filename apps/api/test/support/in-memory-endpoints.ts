import type { Endpoint, EndpointStatus } from "@/modules/endpoints/domain/model";
import type { EndpointFilter, EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";

export class InMemoryEndpointRepository implements EndpointRepositoryPort {
  readonly rows = new Map<string, Endpoint>();

  private live(projectId: string): Endpoint[] {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId && !row.deletedAt)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.path.localeCompare(b.path));
  }

  async list(projectId: string, filter: EndpointFilter) {
    const search = filter.search.toLowerCase();
    const matching = this.live(projectId).filter(
      (row) =>
        (filter.status === "all" || row.status === filter.status) &&
        (!search || row.path.toLowerCase().includes(search) || row.description.toLowerCase().includes(search)),
    );
    return { rows: matching.slice(filter.offset, filter.offset + filter.limit), total: matching.length };
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
