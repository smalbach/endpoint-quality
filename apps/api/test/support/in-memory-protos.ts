import type { ChannelProtoRepositoryPort, ProtoFile } from "@/modules/channels/domain/grpc";

/** Como la tabla: los `.proto` de cada canal, reemplazados enteros. */
export class InMemoryChannelProtoRepository implements ChannelProtoRepositoryPort {
  readonly rows = new Map<string, ProtoFile[]>();

  async list(channelId: string): Promise<ProtoFile[]> {
    return [...(this.rows.get(channelId) ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  }

  async replace(channelId: string, files: ProtoFile[]): Promise<void> {
    this.rows.set(channelId, structuredClone(files));
  }
}
