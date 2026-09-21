import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import { CollectionEntity, CollectionRunEntity } from "@/shared/database/entities";
import type {
  CollectionDocument,
  CollectionRow,
  CollectionRun,
  CollectionRunResult,
  CollectionRunStatus,
  CollectionRunTotals,
} from "../../domain/model";
import type { CollectionRepositoryPort, CollectionRunRepositoryPort } from "../../domain/ports";

const toRow = (row: CollectionEntity): CollectionRow => ({ ...row, document: row.document as CollectionDocument });

@Injectable()
export class TypeOrmCollectionRepository implements CollectionRepositoryPort {
  constructor(@InjectRepository(CollectionEntity) private readonly collections: Repository<CollectionEntity>) {}

  async list(projectId: string): Promise<CollectionRow[]> {
    const rows = await this.collections.find({ where: { projectId }, order: { name: "ASC" } });
    return rows.map(toRow);
  }

  async find(projectId: string, collectionId: string): Promise<CollectionRow | null> {
    const row = await this.collections.findOne({ where: { id: collectionId, projectId } });
    return row ? toRow(row) : null;
  }

  async findByName(projectId: string, name: string): Promise<CollectionRow | null> {
    const row = await this.collections.findOne({ where: { projectId, name } });
    return row ? toRow(row) : null;
  }

  async save(row: CollectionRow): Promise<void> {
    await this.collections.save(this.collections.create(row));
  }

  async delete(projectId: string, collectionId: string): Promise<void> {
    await this.collections.delete({ id: collectionId, projectId });
  }
}

const toRun = (row: CollectionRunEntity): CollectionRun => ({
  ...row,
  status: row.status as CollectionRunStatus,
  totals: row.totals as CollectionRunTotals,
  results: row.results as CollectionRunResult[],
});

@Injectable()
export class TypeOrmCollectionRunRepository implements CollectionRunRepositoryPort {
  constructor(@InjectRepository(CollectionRunEntity) private readonly runs: Repository<CollectionRunEntity>) {}

  async list(projectId: string, collectionId?: string): Promise<CollectionRun[]> {
    const rows = await this.runs.find({
      where: collectionId ? { projectId, collectionId } : { projectId },
      order: { startedAt: "DESC" },
      take: 100,
    });
    return rows.map(toRun);
  }

  async find(projectId: string, runId: string): Promise<CollectionRun | null> {
    const row = await this.runs.findOne({ where: { id: runId, projectId } });
    return row ? toRun(row) : null;
  }

  async findById(runId: string): Promise<CollectionRun | null> {
    const row = await this.runs.findOne({ where: { id: runId } });
    return row ? toRun(row) : null;
  }

  /**
   * La última corrida de cada colección, en una consulta.
   *
   * La lista enseña el veredicto de la última al lado de cada tarjeta, y pedirla por tarjeta sería
   * una consulta por colección. Los resultados no hacen falta aquí —solo el veredicto y la fecha—,
   * así que la proyección los deja fuera: una corrida de 81 peticiones son cientos de kilobytes que
   * la lista no enseña.
   */
  async latestByCollection(projectId: string): Promise<Map<string, CollectionRun>> {
    const latest = await this.runs
      .createQueryBuilder("run")
      .select("run.collectionId", "collectionId")
      .addSelect("MAX(run.startedAt)", "startedAt")
      .where("run.projectId = :projectId", { projectId })
      .groupBy("run.collectionId")
      .getRawMany<{ collectionId: string; startedAt: Date }>();
    if (!latest.length) return new Map();

    const rows = await this.runs.find({
      where: { projectId, startedAt: In(latest.map((entry) => entry.startedAt)) },
      order: { startedAt: "DESC" },
    });
    const byCollection = new Map<string, CollectionRun>();
    for (const row of rows) if (!byCollection.has(row.collectionId)) byCollection.set(row.collectionId, toRun(row));
    return byCollection;
  }

  async save(run: CollectionRun): Promise<void> {
    await this.runs.save(this.runs.create(run));
  }

  async delete(projectId: string, runId: string): Promise<void> {
    await this.runs.delete({ id: runId, projectId });
  }
}
