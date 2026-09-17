import type { DocSite } from "@/modules/docs/domain/model";
import type { DocSiteRepositoryPort } from "@/modules/docs/domain/ports";

export class InMemoryDocSiteRepository implements DocSiteRepositoryPort {
  readonly rows = new Map<string, DocSite>();

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

  async save(site: DocSite) {
    this.rows.set(site.id, structuredClone(site));
  }

  async remove(projectId: string, id: string) {
    const row = await this.findById(projectId, id);
    if (!row) return false;
    this.rows.delete(id);
    return true;
  }
}
