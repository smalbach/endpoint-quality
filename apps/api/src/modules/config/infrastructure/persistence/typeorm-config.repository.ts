import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { ConfigSection } from "@eq/runner-core";

import { ProjectConfigEntity } from "@/shared/database/entities";
import type { ConfigRepositoryPort, ConfigRow } from "../../domain/ports";

@Injectable()
export class TypeOrmConfigRepository implements ConfigRepositoryPort {
  constructor(@InjectRepository(ProjectConfigEntity) private readonly repository: Repository<ProjectConfigEntity>) {}

  async listSections(projectId: string): Promise<ConfigRow[]> {
    // Ordered by section so the assembled configuration does not depend on row order. It should
    // not matter — the sections do not overlap — but a merge whose result depends on the order
    // rows come back in is a bug waiting for the day two sections do share a key.
    const rows = await this.repository.find({ where: { projectId }, order: { section: "ASC" } });
    return rows.map(toRow);
  }
  async findSection(projectId: string, section: ConfigSection): Promise<ConfigRow | null> {
    const row = await this.repository.findOne({ where: { projectId, section } });
    return row ? toRow(row) : null;
  }
  async saveSection(row: ConfigRow): Promise<void> {
    await this.repository.save(row as unknown as ProjectConfigEntity);
  }
  async deleteSection(projectId: string, section: ConfigSection): Promise<void> {
    await this.repository.delete({ projectId, section });
  }
}

const toRow = (row: ProjectConfigEntity): ConfigRow => ({ ...row, section: row.section as ConfigSection });
