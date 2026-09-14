import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { SecurityRunEntity } from "@/shared/database/entities";
import type { SecurityRun } from "../../domain/model";
import type { SecurityRunRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmSecurityRunRepository implements SecurityRunRepositoryPort {
  constructor(@InjectRepository(SecurityRunEntity) private readonly runs: Repository<SecurityRunEntity>) {}

  async listForProject(projectId: string, limit: number): Promise<SecurityRun[]> {
    return (await this.runs.find({ where: { projectId }, order: { startedAt: "DESC" }, take: limit })).map(toDomain);
  }
  async findById(id: string): Promise<SecurityRun | null> {
    const row = await this.runs.findOne({ where: { id } });
    return row ? toDomain(row) : null;
  }
  async findByShareToken(shareToken: string): Promise<SecurityRun | null> {
    const row = await this.runs.findOne({ where: { shareToken } });
    return row ? toDomain(row) : null;
  }
  async save(run: SecurityRun): Promise<void> {
    await this.runs.save(run);
  }
  async remove(id: string): Promise<void> {
    await this.runs.delete({ id });
  }
}

const toDomain = (row: SecurityRunEntity): SecurityRun => ({ ...row }) as unknown as SecurityRun;
