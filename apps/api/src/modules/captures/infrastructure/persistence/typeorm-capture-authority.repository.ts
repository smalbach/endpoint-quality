import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { CaptureAuthorityEntity } from "@/shared/database/entities";
import type { CaptureAuthorityRepositoryPort, StoredCaptureAuthority } from "../../domain/ports";

/** Solo hay una CA por instalación: la fila se llama así. */
const ID = "default";

@Injectable()
export class TypeOrmCaptureAuthorityRepository implements CaptureAuthorityRepositoryPort {
  constructor(
    @InjectRepository(CaptureAuthorityEntity) private readonly authorities: Repository<CaptureAuthorityEntity>,
  ) {}

  async find(): Promise<StoredCaptureAuthority | null> {
    const row = await this.authorities.findOne({ where: { id: ID } });
    return row
      ? { certificatePem: row.certificatePem, privateKeyCiphertext: row.privateKeyCiphertext, createdAt: row.createdAt }
      : null;
  }

  /** `ON CONFLICT DO NOTHING`: si otra instancia llegó antes, se queda la suya. */
  async insertIfAbsent(authority: StoredCaptureAuthority): Promise<void> {
    await this.authorities
      .createQueryBuilder()
      .insert()
      .into(CaptureAuthorityEntity)
      .values({ id: ID, ...authority })
      .orIgnore()
      .execute();
  }
}
