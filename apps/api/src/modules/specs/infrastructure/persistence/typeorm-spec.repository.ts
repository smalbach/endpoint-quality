import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import type { ImportProblem, HttpMethod } from "@eq/spec-import";

import { SpecOperationEntity, SpecSourceEntity, SpecVersionEntity } from "@/shared/database/entities";
import type { SpecOperation, SpecSource, SpecVersion, SpecVersionSummary } from "../../domain/model";
import type { SpecRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmSpecRepository implements SpecRepositoryPort {
  constructor(
    @InjectRepository(SpecVersionEntity) private readonly versions: Repository<SpecVersionEntity>,
    @InjectRepository(SpecOperationEntity) private readonly operations: Repository<SpecOperationEntity>,
    @InjectRepository(SpecSourceEntity) private readonly sources: Repository<SpecSourceEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async findVersionById(id: string): Promise<SpecVersion | null> {
    return toVersion(await this.versions.findOne({ where: { id } }));
  }
  async findVersionByHash(projectId: string, hash: string): Promise<SpecVersion | null> {
    return toVersion(await this.versions.findOne({ where: { projectId, hash } }));
  }
  async listVersions(projectId: string): Promise<SpecVersionSummary[]> {
    // `select` without `raw`: listing versions must not ship a copy of every contract document
    // to a browser that renders dates and counts.
    const rows = await this.versions.find({
      where: { projectId },
      order: { importedAt: "DESC" },
      select: ["id", "projectId", "sourceId", "hash", "format", "openapiVersion", "title", "contractVersion", "operationCount", "problems", "importedBy", "importedAt"],
    });
    return rows.map((row) => ({ ...row, problems: (row.problems ?? []) as ImportProblem[] }));
  }

  /**
   * The version and its operations are written in **one transaction**.
   *
   * A version row with no operations is a contract the engine reads as empty — and an empty
   * matrix looks like full coverage of nothing rather than like a failed write.
   */
  async saveVersion(version: SpecVersion, operations: SpecOperation[]): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(SpecVersionEntity).save(version as unknown as SpecVersionEntity);
      if (operations.length) {
        const rows = operations.map((operation) => ({
          id: operation.rowId,
          specVersionId: operation.specVersionId,
          position: operation.position,
          operationId: operation.id,
          method: operation.method,
          path: operation.path,
          summary: operation.summary,
          tag: operation.tag,
          statuses: operation.statuses,
          parameters: operation.parameters,
          security: operation.security,
          derivedId: operation.derivedId,
        }));
        // Chunked: a contract with thousands of operations would otherwise build one statement
        // past what the driver will accept.
        await manager.getRepository(SpecOperationEntity).save(rows, { chunk: 200 });
      }
    });
  }

  async listOperations(specVersionId: string): Promise<SpecOperation[]> {
    // Ordered by the stored position, not by whatever order Postgres returns rows in: the
    // document order is the "contrato" ordering an operator can pick for a run.
    const rows = await this.operations.find({ where: { specVersionId }, order: { position: "ASC" } });
    return rows.map((row) => ({
      // `id` is the contract's operationId, `rowId` the primary key. Handing the engine the row
      // id would key every piece of configuration to one import and break it on the next.
      id: row.operationId,
      rowId: row.id,
      specVersionId: row.specVersionId,
      position: row.position,
      method: row.method as HttpMethod,
      path: row.path,
      summary: row.summary,
      tag: row.tag,
      statuses: row.statuses,
      parameters: row.parameters,
      security: row.security,
      derivedId: row.derivedId,
    }));
  }

  async saveSource(source: SpecSource): Promise<void> {
    await this.sources.save(source);
  }
  async deleteVersion(id: string): Promise<void> {
    await this.versions.delete({ id });
  }
}

function toVersion(row: SpecVersionEntity | null): SpecVersion | null {
  return row ? { ...row, problems: (row.problems ?? []) as ImportProblem[] } : null;
}
