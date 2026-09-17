import type { MockServer } from "@/modules/mocks/domain/model";
import type { MockRepositoryPort } from "@/modules/mocks/domain/ports";

export class InMemoryMockRepository implements MockRepositoryPort {
  readonly rows = new Map<string, MockServer>();

  async listByProject(projectId: string) {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findById(projectId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.projectId === projectId ? row : null;
  }

  async findByPublicId(publicId: string) {
    return [...this.rows.values()].find((row) => row.publicId === publicId) ?? null;
  }

  async save(mock: MockServer) {
    this.rows.set(mock.id, structuredClone(mock));
  }

  async remove(projectId: string, id: string) {
    const row = await this.findById(projectId, id);
    if (!row) return false;
    this.rows.delete(id);
    return true;
  }
}
