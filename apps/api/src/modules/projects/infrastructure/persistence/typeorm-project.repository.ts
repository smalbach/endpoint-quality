import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { ProjectEntity } from "@/shared/database/entities";
import type { Project } from "../../domain/model";
import type { ProjectAuthSettings, ProjectAuthType } from "../../domain/project-auth";
import type { ProjectRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmProjectRepository implements ProjectRepositoryPort {
  constructor(@InjectRepository(ProjectEntity) private readonly repository: Repository<ProjectEntity>) {}

  async findById(id: string): Promise<Project | null> {
    // A deleted project is not found, by anyone, through any route: this is the one place that
    // has to remember it.
    const row = await this.repository.findOne({ where: { id, deletedAt: IsNull() } });
    return row ? toProject(row) : null;
  }
  async findBySlug(organizationId: string, slug: string): Promise<Project | null> {
    // Deleted ones included on purpose: their slug stays taken, so a CI job still pointing at it
    // cannot start launching runs against a new project that happens to share the name.
    const row = await this.repository.findOne({ where: { organizationId, slug } });
    return row ? toProject(row) : null;
  }
  async listForOrganization(organizationId: string, includeArchived: boolean): Promise<Project[]> {
    // The archived filter is a `where`, not a post-filter: an organization with hundreds of
    // archived projects would otherwise pull all of them across to drop them.
    const where = includeArchived
      ? { organizationId, deletedAt: IsNull() }
      : { organizationId, archivedAt: IsNull(), deletedAt: IsNull() };
    return (await this.repository.find({ where, order: { createdAt: "DESC" } })).map(toProject);
  }
  async save(project: Project): Promise<void> {
    const { auth, ...rest } = project;
    await this.repository.save({
      ...rest,
      authType: auth.type,
      authSettings: auth.settings,
      authSecretCiphertext: auth.secretCiphertext,
    });
  }
}

function toProject(row: ProjectEntity): Project {
  const { authType, authSettings, authSecretCiphertext, ...rest } = row;
  return {
    ...rest,
    auth: {
      type: authType as ProjectAuthType,
      settings: authSettings as ProjectAuthSettings,
      secretCiphertext: authSecretCiphertext,
    },
  };
}
