import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { PasswordResetTokenEntity } from "@/shared/database/entities";
import type { PasswordResetRepositoryPort, PasswordResetToken } from "../../domain/password-reset";

@Injectable()
export class TypeOrmPasswordResetRepository implements PasswordResetRepositoryPort {
  constructor(
    @InjectRepository(PasswordResetTokenEntity) private readonly repository: Repository<PasswordResetTokenEntity>,
  ) {}

  async save(token: PasswordResetToken): Promise<void> {
    await this.repository.save(token);
  }
  async findByHash(hash: string): Promise<PasswordResetToken | null> {
    const row = await this.repository.findOne({ where: { tokenHash: hash } });
    return row ? { ...row } : null;
  }
  async spendAllForUser(userId: string, at: Date): Promise<void> {
    // One statement, for the same reason the refresh chain is revoked in one: two links used a
    // moment apart must not both get through.
    await this.repository.update({ userId, usedAt: IsNull() }, { usedAt: at });
  }
}
