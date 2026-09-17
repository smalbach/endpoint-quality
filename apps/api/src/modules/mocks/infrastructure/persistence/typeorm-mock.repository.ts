import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MockServerEntity } from "@/shared/database/entities";
import type { MockServer } from "../../domain/model";
import type { MockRepositoryPort } from "../../domain/ports";

const toMock = (row: MockServerEntity): MockServer => row as unknown as MockServer;

@Injectable()
export class TypeOrmMockRepository implements MockRepositoryPort {
  constructor(@InjectRepository(MockServerEntity) private readonly mocks: Repository<MockServerEntity>) {}

  async listByProject(projectId: string): Promise<MockServer[]> {
    const rows = await this.mocks.find({ where: { projectId }, order: { createdAt: "ASC" } });
    return rows.map(toMock);
  }

  async findById(projectId: string, id: string): Promise<MockServer | null> {
    const row = await this.mocks.findOne({ where: { id, projectId } });
    return row ? toMock(row) : null;
  }

  async findByPublicId(publicId: string): Promise<MockServer | null> {
    const row = await this.mocks.findOne({ where: { publicId } });
    return row ? toMock(row) : null;
  }

  async save(mock: MockServer): Promise<void> {
    await this.mocks.save(this.mocks.create(mock as unknown as MockServerEntity));
  }

  async remove(projectId: string, id: string): Promise<boolean> {
    const result = await this.mocks.delete({ id, projectId });
    return (result.affected ?? 0) > 0;
  }
}
