import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { ConflictError } from "@/shared/errors/domain-error";
import { ForkMergeRequestEntity, ForkMergeRequestEventEntity } from "@/shared/database/entities";
import type { DiffEntry } from "../../domain/fork-merge";
import type {
  ForkMergeRequest,
  MergeRequestEvent,
  MergeRequestEventKind,
  MergeRequestStatus,
} from "../../domain/merge-request";
import type { MergeRequestRepositoryPort } from "../../domain/ports";

/** El código de Postgres para una clave única repetida. */
const UNIQUE_VIOLATION = "23505";

@Injectable()
export class TypeOrmMergeRequestRepository implements MergeRequestRepositoryPort {
  constructor(
    @InjectRepository(ForkMergeRequestEntity) private readonly requests: Repository<ForkMergeRequestEntity>,
    @InjectRepository(ForkMergeRequestEventEntity) private readonly events: Repository<ForkMergeRequestEventEntity>,
  ) {}

  async findById(organizationId: string, id: string): Promise<ForkMergeRequest | null> {
    const row = await this.requests.findOne({ where: { organizationId, id } });
    return row ? toRequest(row) : null;
  }

  async listForProject(organizationId: string, projectId: string): Promise<ForkMergeRequest[]> {
    const rows = await this.requests.find({
      where: [
        { organizationId, parentProjectId: projectId },
        { organizationId, forkProjectId: projectId },
      ],
      order: { createdAt: "DESC" },
    });
    return rows.map(toRequest);
  }

  /**
   * Una segunda pendiente para la misma bifurcación choca con el índice único parcial: es la
   * carrera de dos clics que el comando no ve, y se contesta igual que si la hubiera visto.
   */
  async save(request: ForkMergeRequest): Promise<void> {
    try {
      await this.requests.save(toRequestRow(request));
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION)
        throw new ConflictError("Esta bifurcación ya tiene una solicitud pendiente", "merge-request-pending");
      throw error;
    }
  }

  async listEvents(requestId: string): Promise<MergeRequestEvent[]> {
    const rows = await this.events.find({ where: { requestId }, order: { createdAt: "ASC" } });
    return rows.map((row) => ({ ...row, kind: row.kind as MergeRequestEventKind }));
  }

  async addEvent(event: MergeRequestEvent): Promise<void> {
    await this.events.insert(event);
  }
}

export const toRequestRow = (request: ForkMergeRequest): ForkMergeRequestEntity => ({
  ...request,
  diff: request.diff as unknown[],
});

const toRequest = (row: ForkMergeRequestEntity): ForkMergeRequest => ({
  ...row,
  status: row.status as MergeRequestStatus,
  diff: row.diff as DiffEntry[],
});
