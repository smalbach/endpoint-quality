import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, In, IsNull, Repository } from "typeorm";

import { EndpointEntity } from "@/shared/database/entities";
import type { Endpoint, EndpointStatus } from "../../domain/model";
import type { EndpointFilter, EndpointRepositoryPort } from "../../domain/ports";

/** The `jsonb` columns become typed here, once. What they hold was validated on the way in. */
const toEndpoint = (row: EndpointEntity): Endpoint => row as unknown as Endpoint;

@Injectable()
export class TypeOrmEndpointRepository implements EndpointRepositoryPort {
  constructor(@InjectRepository(EndpointEntity) private readonly endpoints: Repository<EndpointEntity>) {}

  async list(projectId: string, filter: EndpointFilter): Promise<{ rows: Endpoint[]; total: number }> {
    const query = this.endpoints
      .createQueryBuilder("endpoint")
      .where(`endpoint."projectId" = :projectId`, { projectId })
      .andWhere(`endpoint."deletedAt" IS NULL`);
    if (filter.status !== "all") query.andWhere(`endpoint."status" = :status`, { status: filter.status });
    if (filter.search) {
      // Escaped, unlike the analyzer's: a `_` in a search is a character, not a wildcard.
      const pattern = `%${filter.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      query.andWhere(
        new Brackets((where) => {
          where
            .where(`endpoint."path" ILIKE :pattern`, { pattern })
            .orWhere(`endpoint."description" ILIKE :pattern`, { pattern });
        }),
      );
    }
    const [rows, total] = await query
      .orderBy(`endpoint."orderIndex"`, "ASC")
      .addOrderBy(`endpoint."createdAt"`, "ASC")
      .addOrderBy(`endpoint."path"`, "ASC")
      .skip(filter.offset)
      .take(filter.limit)
      .getManyAndCount();
    return { rows: rows.map(toEndpoint), total };
  }

  async counts(projectId: string): Promise<Record<EndpointStatus, number>> {
    const rows = await this.endpoints
      .createQueryBuilder("endpoint")
      .select(`endpoint."status"`, "status")
      .addSelect("COUNT(*)::int", "count")
      .where(`endpoint."projectId" = :projectId`, { projectId })
      .andWhere(`endpoint."deletedAt" IS NULL`)
      .groupBy(`endpoint."status"`)
      .getRawMany<{ status: EndpointStatus; count: number }>();
    const counts: Record<EndpointStatus, number> = { active: 0, archived: 0, inactive: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  async listAll(projectId: string): Promise<Endpoint[]> {
    return (
      await this.endpoints.find({
        where: { projectId, deletedAt: IsNull() },
        order: { orderIndex: "ASC", path: "ASC" },
      })
    ).map(toEndpoint);
  }

  async findById(projectId: string, id: string): Promise<Endpoint | null> {
    const row = await this.endpoints.findOne({ where: { id, projectId, deletedAt: IsNull() } });
    return row ? toEndpoint(row) : null;
  }

  async save(endpoint: Endpoint): Promise<void> {
    await this.endpoints.save(this.endpoints.create(endpoint as unknown as EndpointEntity));
  }

  async saveMany(endpoints: Endpoint[]): Promise<void> {
    if (!endpoints.length) return;
    await this.endpoints.manager.transaction(async (manager) => {
      await manager.save(
        endpoints.map((endpoint) => manager.create(EndpointEntity, endpoint as unknown as EndpointEntity)),
      );
    });
  }

  async setStatus(
    projectId: string,
    ids: string[],
    status: EndpointStatus,
    at: Date,
    actorId: string,
  ): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.endpoints.update(
      { projectId, id: In(ids), deletedAt: IsNull() },
      { status, updatedAt: at, updatedBy: actorId },
    );
    return result.affected ?? 0;
  }

  async softDelete(projectId: string, ids: string[], at: Date): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.endpoints.update({ projectId, id: In(ids), deletedAt: IsNull() }, { deletedAt: at });
    return result.affected ?? 0;
  }

  async nextOrderIndex(projectId: string): Promise<number> {
    const row = await this.endpoints
      .createQueryBuilder("endpoint")
      .select(`COALESCE(MAX(endpoint."orderIndex"), -1) + 1`, "next")
      .where(`endpoint."projectId" = :projectId`, { projectId })
      .getRawOne<{ next: number }>();
    return Number(row?.next ?? 0);
  }
}
