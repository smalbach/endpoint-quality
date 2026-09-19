import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, LessThanOrEqual, MoreThan, Repository } from "typeorm";

import { CaptureItemEntity, CaptureSessionEntity } from "@/shared/database/entities";
import type { CaptureItem, CaptureSession, CaptureStopReason } from "../../domain/model";
import type { CaptureRepositoryPort } from "../../domain/ports";

const toSession = (row: CaptureSessionEntity): CaptureSession => row as unknown as CaptureSession;
const toItem = (row: CaptureItemEntity): CaptureItem => row as unknown as CaptureItem;

@Injectable()
export class TypeOrmCaptureRepository implements CaptureRepositoryPort {
  constructor(
    @InjectRepository(CaptureSessionEntity) private readonly sessions: Repository<CaptureSessionEntity>,
    @InjectRepository(CaptureItemEntity) private readonly items: Repository<CaptureItemEntity>,
  ) {}

  async saveSession(session: CaptureSession): Promise<void> {
    await this.sessions.save(this.sessions.create(session as unknown as CaptureSessionEntity));
  }

  async findSession(projectId: string, id: string): Promise<CaptureSession | null> {
    const row = await this.sessions.findOne({ where: { id, projectId } });
    return row ? toSession(row) : null;
  }

  async listSessions(projectId: string, limit: number): Promise<CaptureSession[]> {
    const rows = await this.sessions.find({ where: { projectId }, order: { startedAt: "DESC" }, take: limit });
    return rows.map(toSession);
  }

  async listActive(): Promise<CaptureSession[]> {
    const rows = await this.sessions.find({ where: { status: "active" } });
    return rows.map(toSession);
  }

  async removeSession(projectId: string, id: string): Promise<boolean> {
    const result = await this.sessions.delete({ id, projectId });
    return Boolean(result.affected);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<CaptureSession | null> {
    const row = await this.sessions.findOne({ where: { tokenHash } });
    return row ? toSession(row) : null;
  }

  async stopSession(projectId: string, id: string, reason: CaptureStopReason, at: Date): Promise<boolean> {
    const result = await this.sessions.update(
      { id, projectId, status: "active" },
      { status: "stopped", stopReason: reason, stoppedAt: at },
    );
    return Boolean(result.affected);
  }

  async expireDue(now: Date): Promise<number> {
    const result = await this.sessions.update(
      { status: "active", expiresAt: LessThanOrEqual(now) },
      { status: "stopped", stopReason: "expired", stoppedAt: now },
    );
    // Postgres always reports affected rows for UPDATE/DELETE; the fallback only satisfies TypeORM's type.
    /* node:coverage ignore next */
    return result.affected ?? 0;
  }

  async appendNext(item: Omit<CaptureItem, "seq">, maxRequests: number): Promise<number | null> {
    return this.sessions.manager.transaction(async (manager) => {
      // El `UPDATE` bloquea la fila de la sesión hasta el final de la transacción: la siguiente
      // petición, venga de la instancia que venga, espera aquí a que esta esté escrita.
      const bumped = await manager
        .createQueryBuilder()
        .update(CaptureSessionEntity)
        .set({ itemCount: () => `"itemCount" + 1` })
        .where(`"id" = :id AND "projectId" = :projectId AND "status" = 'active' AND "itemCount" < :max`, {
          id: item.sessionId,
          projectId: item.projectId,
          max: maxRequests,
        })
        .returning(`"itemCount"`)
        .execute();
      const seq = (bumped.raw as { itemCount: number }[])[0]?.itemCount;
      if (seq === undefined) return null;
      await manager.insert(CaptureItemEntity, { ...item, seq } as unknown as CaptureItemEntity);
      return seq;
    });
  }

  /** Un `insert` y no un `save`: la fila nace y no se vuelve a tocar nunca. */
  async appendItem(item: CaptureItem): Promise<void> {
    await this.items.insert(this.items.create(item as unknown as CaptureItemEntity));
  }

  async listItems(projectId: string, sessionId: string, afterSeq: number, limit: number): Promise<CaptureItem[]> {
    const rows = await this.items.find({
      where: { projectId, sessionId, seq: MoreThan(afterSeq) },
      order: { seq: "ASC" },
      take: limit,
    });
    return rows.map(toItem);
  }

  async findItems(projectId: string, sessionId: string, ids: string[]): Promise<CaptureItem[]> {
    if (!ids.length) return [];
    const rows = await this.items.find({ where: { projectId, sessionId, id: In(ids) }, order: { seq: "ASC" } });
    return rows.map(toItem);
  }
}
