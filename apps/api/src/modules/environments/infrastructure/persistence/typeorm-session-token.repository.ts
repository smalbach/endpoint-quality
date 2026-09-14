import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { SessionTokenEntity } from "@/shared/database/entities";
import type { SessionToken, SessionTokenSource } from "../../domain/session-token";
import type { SessionTokenRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmSessionTokenRepository implements SessionTokenRepositoryPort {
  constructor(@InjectRepository(SessionTokenEntity) private readonly tokens: Repository<SessionTokenEntity>) {}

  async find(actorId: string, projectId: string): Promise<SessionToken | null> {
    const row = await this.tokens.findOne({ where: { actorId, projectId } });
    return row ? { ...row, source: row.source as SessionTokenSource } : null;
  }
  async save(token: SessionToken): Promise<void> {
    await this.tokens.save(token);
  }
  async remove(actorId: string, projectId: string): Promise<void> {
    await this.tokens.delete({ actorId, projectId });
  }
}
