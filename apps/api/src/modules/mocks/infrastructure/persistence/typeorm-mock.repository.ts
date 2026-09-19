import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { MockCallEntity, MockServerEntity } from "@/shared/database/entities";
import type { MockCall } from "../../domain/mock-call";
import type { MockServer } from "../../domain/model";
import type { MockRepositoryPort } from "../../domain/ports";

const toMock = (row: MockServerEntity): MockServer => row as unknown as MockServer;
const toCall = (row: MockCallEntity): MockCall => row as unknown as MockCall;

@Injectable()
export class TypeOrmMockRepository implements MockRepositoryPort {
  constructor(
    @InjectRepository(MockServerEntity) private readonly mocks: Repository<MockServerEntity>,
    @InjectRepository(MockCallEntity) private readonly calls: Repository<MockCallEntity>,
  ) {}

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
    return Boolean(result.affected);
  }

  /** Un `insert` y no un `save`: la fila nace y no se vuelve a tocar nunca. */
  async saveCall(call: MockCall): Promise<void> {
    await this.calls.insert(this.calls.create(call as unknown as MockCallEntity));
  }

  async listCalls(mockServerId: string, limit: number): Promise<MockCall[]> {
    const rows = await this.calls.find({ where: { mockServerId }, order: { at: "DESC" }, take: limit });
    return rows.map(toCall);
  }

  /** Por `at` y no por `id`: lo que sobra son las viejas, y un uuid no dice cuál es vieja. */
  async trimCalls(mockServerId: string, keep: number): Promise<void> {
    const rows = await this.calls.find({
      where: { mockServerId },
      order: { at: "DESC" },
      select: ["id"],
      skip: keep,
      take: 1_000,
    });
    if (rows.length) await this.calls.delete(rows.map((row) => row.id));
  }
}
