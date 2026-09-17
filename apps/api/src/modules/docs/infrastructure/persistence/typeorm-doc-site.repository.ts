import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { DocSiteEntity } from "@/shared/database/entities";
import type { DocSite } from "../../domain/model";
import type { DocSiteRepositoryPort } from "../../domain/ports";

const toSite = (row: DocSiteEntity): DocSite => row as unknown as DocSite;

@Injectable()
export class TypeOrmDocSiteRepository implements DocSiteRepositoryPort {
  constructor(@InjectRepository(DocSiteEntity) private readonly sites: Repository<DocSiteEntity>) {}

  async listByProject(projectId: string): Promise<DocSite[]> {
    const rows = await this.sites.find({ where: { projectId }, order: { createdAt: "ASC" } });
    return rows.map(toSite);
  }

  async findById(projectId: string, id: string): Promise<DocSite | null> {
    const row = await this.sites.findOne({ where: { id, projectId } });
    return row ? toSite(row) : null;
  }

  async findByPublicId(publicId: string): Promise<DocSite | null> {
    const row = await this.sites.findOne({ where: { publicId } });
    return row ? toSite(row) : null;
  }

  async save(site: DocSite): Promise<void> {
    await this.sites.save(this.sites.create(site as unknown as DocSiteEntity));
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const result = await this.sites.delete({ id, projectId });
    return (result.affected ?? 0) > 0;
  }
}
