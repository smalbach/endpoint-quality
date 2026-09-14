import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { CodeConnectorEntity, CodeScanEntity } from "@/shared/database/entities";
import type { CodeConnector, CodeScan } from "../../domain/model";
import type { CodeConnectorRepositoryPort, CodeScanRepositoryPort } from "../../domain/ports";

const toConnector = (row: CodeConnectorEntity): CodeConnector => ({ ...row, provider: "github" });

@Injectable()
export class TypeOrmCodeConnectorRepository implements CodeConnectorRepositoryPort {
  constructor(@InjectRepository(CodeConnectorEntity) private readonly connectors: Repository<CodeConnectorEntity>) {}

  async find(projectId: string): Promise<CodeConnector | null> {
    const row = await this.connectors.findOne({ where: { projectId } });
    return row ? toConnector(row) : null;
  }
  async save(connector: CodeConnector): Promise<void> {
    await this.connectors.save(this.connectors.create(connector));
  }
  async delete(projectId: string): Promise<void> {
    await this.connectors.delete({ projectId });
  }
}

const toScan = (row: CodeScanEntity): CodeScan => ({
  ...row,
  source: row.source as CodeScan["source"],
  status: row.status as CodeScan["status"],
  result: row.result as CodeScan["result"],
  diff: row.diff as CodeScan["diff"],
  impact: row.impact as CodeScan["impact"],
});

@Injectable()
export class TypeOrmCodeScanRepository implements CodeScanRepositoryPort {
  constructor(@InjectRepository(CodeScanEntity) private readonly scans: Repository<CodeScanEntity>) {}

  async list(projectId: string): Promise<CodeScan[]> {
    return (await this.scans.find({ where: { projectId }, order: { createdAt: "DESC" } })).map(toScan);
  }
  async find(projectId: string, scanId: string): Promise<CodeScan | null> {
    const row = await this.scans.findOne({ where: { id: scanId, projectId } });
    return row ? toScan(row) : null;
  }
  async save(scan: CodeScan): Promise<void> {
    await this.scans.save(this.scans.create(scan));
  }
  async delete(projectId: string, scanId: string): Promise<void> {
    await this.scans.delete({ id: scanId, projectId });
  }
}
