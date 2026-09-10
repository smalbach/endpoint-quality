import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { ProjectEntity } from "@/shared/database/entities";
import type { Project } from "../../domain/model";
import type { ProjectRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmProjectRepository implements ProjectRepositoryPort {
  constructor(@InjectRepository(ProjectEntity) private readonly repository: Repository<ProjectEntity>) {}

  async findById(id: string): Promise<Project | null> {
    const row = await this.repository.findOne({ where: { id } });
    return row ? { ...row } : null;
  }
  async findBySlug(organizationId: string, slug: string): Promise<Project | null> {
    const row = await this.repository.findOne({ where: { organizationId, slug } });
    return row ? { ...row } : null;
  }
  async listForOrganization(organizationId: string, includeArchived: boolean): Promise<Project[]> {
    // The archived filter is a `where`, not a post-filter: an organization with hundreds of
    // archived projects would otherwise pull all of them across to drop them.
    const where = includeArchived ? { organizationId } : { organizationId, archivedAt: IsNull() };
    return (await this.repository.find({ where, order: { createdAt: "DESC" } })).map((row) => ({ ...row }));
  }
  async save(project: Project): Promise<void> {
    await this.repository.save(project);
  }
}
