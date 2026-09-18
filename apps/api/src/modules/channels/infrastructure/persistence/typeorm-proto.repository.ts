import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { ChannelProtoFileEntity } from "@/shared/database/entities";
import type { ChannelProtoRepositoryPort, ProtoFile } from "../../domain/grpc";

/**
 * Los `.proto` de un canal. Reemplazar es borrar y escribir en una transacción: un conjunto a medias
 * —el fichero nuevo sin el que importa— es un conjunto que no se puede leer.
 */
@Injectable()
export class TypeOrmChannelProtoRepository implements ChannelProtoRepositoryPort {
  constructor(@InjectRepository(ChannelProtoFileEntity) private readonly files: Repository<ChannelProtoFileEntity>) {}

  async list(channelId: string): Promise<ProtoFile[]> {
    const rows = await this.files.find({ where: { channelId }, order: { path: "ASC" } });
    return rows.map((row) => ({ path: row.path, content: row.content }));
  }

  async replace(channelId: string, files: ProtoFile[]): Promise<void> {
    await this.files.manager.transaction(async (manager) => {
      await manager.delete(ChannelProtoFileEntity, { channelId });
      if (!files.length) return;
      await manager.insert(
        ChannelProtoFileEntity,
        files.map((file) => ({
          channelId,
          path: file.path,
          content: file.content,
          bytes: Buffer.byteLength(file.content, "utf8"),
        })),
      );
    });
  }
}
