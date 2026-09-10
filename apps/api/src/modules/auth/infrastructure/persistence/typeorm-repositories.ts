/**
 * Postgres behind the auth ports.
 *
 * Nothing here has a policy: the decision that a reused refresh token closes its whole session
 * lives in the handler, and `revokeSession` only has to close it in **one statement**. Doing it
 * row by row leaves a window in which the party that stole the token refreshes again and gets a
 * fresh chain out of the one being revoked.
 */
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { ApiTokenEntity, RefreshTokenEntity, UserEntity } from "@/shared/database/entities";
import type { ApiToken, RefreshToken, User, UserStatus } from "../../domain/model";
import type { ApiTokenRepositoryPort, RefreshTokenRepositoryPort, UserRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmUserRepository implements UserRepositoryPort {
  constructor(@InjectRepository(UserEntity) private readonly repository: Repository<UserEntity>) {}

  async findById(id: string): Promise<User | null> {
    return toUser(await this.repository.findOne({ where: { id } }));
  }
  async findByEmail(email: string): Promise<User | null> {
    return toUser(await this.repository.findOne({ where: { email: email.toLowerCase() } }));
  }
  async save(user: User): Promise<void> {
    await this.repository.save({ ...user, email: user.email.toLowerCase() });
  }
}

@Injectable()
export class TypeOrmRefreshTokenRepository implements RefreshTokenRepositoryPort {
  constructor(@InjectRepository(RefreshTokenEntity) private readonly repository: Repository<RefreshTokenEntity>) {}

  async findByHash(hash: string): Promise<RefreshToken | null> {
    const row = await this.repository.findOne({ where: { tokenHash: hash } });
    return row ? { ...row } : null;
  }
  async save(token: RefreshToken): Promise<void> {
    await this.repository.save(token);
  }
  async markUsed(id: string, at: Date, replacedByHash: string): Promise<void> {
    await this.repository.update({ id }, { usedAt: at, replacedByHash });
  }
  async revokeSession(sessionId: string, at: Date): Promise<void> {
    await this.repository.update({ sessionId, revokedAt: IsNull() }, { revokedAt: at });
  }
  async revokeAllForUser(userId: string, at: Date): Promise<void> {
    await this.repository.update({ userId, revokedAt: IsNull() }, { revokedAt: at });
  }
}

@Injectable()
export class TypeOrmApiTokenRepository implements ApiTokenRepositoryPort {
  constructor(@InjectRepository(ApiTokenEntity) private readonly repository: Repository<ApiTokenEntity>) {}

  async findByHash(hash: string): Promise<ApiToken | null> {
    const row = await this.repository.findOne({ where: { tokenHash: hash } });
    return row ? { ...row } : null;
  }
  async findById(id: string): Promise<ApiToken | null> {
    const row = await this.repository.findOne({ where: { id } });
    return row ? { ...row } : null;
  }
  async listForOrganization(organizationId: string): Promise<ApiToken[]> {
    return (await this.repository.find({ where: { organizationId }, order: { createdAt: "DESC" } })).map((row) => ({
      ...row,
    }));
  }
  async save(token: ApiToken): Promise<void> {
    await this.repository.save(token);
  }
  async touch(id: string, at: Date): Promise<void> {
    await this.repository.update({ id }, { lastUsedAt: at });
  }
}

function toUser(row: UserEntity | null): User | null {
  return row ? { ...row, status: row.status as UserStatus } : null;
}
