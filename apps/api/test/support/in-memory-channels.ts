import type { ChannelMessage } from "@eq/runner-core";

import type { Channel } from "@/modules/channels/domain/model";
import type { ChannelRepositoryPort, ChannelSessionRepositoryPort } from "@/modules/channels/domain/ports";
import type { ChannelSession } from "@/modules/channels/domain/session";

export class InMemoryChannelRepository implements ChannelRepositoryPort {
  readonly rows = new Map<string, Channel>();

  async listByProject(projectId: string): Promise<Channel[]> {
    return [...this.rows.values()]
      .filter((channel) => channel.projectId === projectId && !channel.deletedAt)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findById(projectId: string, id: string): Promise<Channel | null> {
    const channel = this.rows.get(id);
    return channel && channel.projectId === projectId && !channel.deletedAt ? channel : null;
  }

  async countByProject(projectId: string): Promise<number> {
    return (await this.listByProject(projectId)).length;
  }

  async save(channel: Channel): Promise<void> {
    this.rows.set(channel.id, structuredClone(channel));
  }
}

/**
 * Como la de TypeORM: la fila sin mensajes, y los mensajes aparte.
 *
 * Guarda la sesión **con la conversación vaciada de mensajes**, que es lo que hace la tabla. Si esto
 * guardara el objeto entero, una prueba podría leer de la fila unos mensajes que en Postgres solo
 * viven en `channel_messages`, y pasaría en memoria lo que en la base falla.
 */
export class InMemoryChannelSessionRepository implements ChannelSessionRepositoryPort {
  readonly rows = new Map<string, ChannelSession>();
  readonly messages = new Map<string, ChannelMessage[]>();

  async save(session: ChannelSession): Promise<void> {
    this.rows.set(session.id, structuredClone({ ...session, conversation: { ...session.conversation, messages: [] } }));
  }

  async findById(projectId: string, id: string): Promise<ChannelSession | null> {
    const session = this.rows.get(id);
    return session && session.projectId === projectId ? structuredClone(session) : null;
  }

  async listByChannel(projectId: string, channelId: string, limit: number): Promise<ChannelSession[]> {
    return [...this.rows.values()]
      .filter((session) => session.projectId === projectId && session.channelId === channelId)
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
      .slice(0, limit)
      .map((session) => structuredClone(session));
  }

  async appendMessages(sessionId: string, messages: ChannelMessage[]): Promise<void> {
    const current = this.messages.get(sessionId) ?? [];
    for (const message of messages) {
      // La clave compuesta de la tabla, aquí también: un seq repetido es un error, no una sobrescritura.
      if (current.some((existing) => existing.seq === message.seq)) throw new Error(`seq ${message.seq} repetido`);
      current.push(structuredClone(message));
    }
    this.messages.set(sessionId, current);
  }

  async listMessages(sessionId: string): Promise<ChannelMessage[]> {
    return [...(this.messages.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async countLive(ownerInstance: string): Promise<number> {
    return [...this.rows.values()].filter(
      (session) =>
        session.ownerInstance === ownerInstance && (session.status === "open" || session.status === "connecting"),
    ).length;
  }

  async findStale(before: Date): Promise<ChannelSession[]> {
    return [...this.rows.values()]
      .filter(
        (session) =>
          (session.status === "open" || session.status === "connecting") &&
          session.heartbeatAt.getTime() < before.getTime(),
      )
      .map((session) => structuredClone(session));
  }

  async beat(ownerInstance: string, now: Date): Promise<void> {
    for (const session of this.rows.values()) {
      if (session.ownerInstance === ownerInstance && (session.status === "open" || session.status === "connecting"))
        session.heartbeatAt = now;
    }
  }
}
