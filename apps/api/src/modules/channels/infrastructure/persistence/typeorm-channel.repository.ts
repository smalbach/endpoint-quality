import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, LessThan, Repository } from "typeorm";
import {
  blankConversation,
  type ChannelMessage,
  type Conversation,
  type MessageDirection,
  type MessageKind,
} from "@eq/runner-core";

import { ChannelEndpointEntity, ChannelMessageEntity, ChannelSessionEntity } from "@/shared/database/entities";
import type { Channel } from "../../domain/model";
import type { ChannelRepositoryPort, ChannelSessionRepositoryPort } from "../../domain/ports";
import type { ChannelSession, SessionStatus } from "../../domain/session";

// `grpc` con su `null` explícito: una fila de antes de la columna no la trae, y `undefined` no es un canal.
const toChannel = (row: ChannelEndpointEntity): Channel => ({
  ...(row as unknown as Channel),
  grpc: (row.grpc as Channel["grpc"]) ?? null,
});

@Injectable()
export class TypeOrmChannelRepository implements ChannelRepositoryPort {
  constructor(@InjectRepository(ChannelEndpointEntity) private readonly channels: Repository<ChannelEndpointEntity>) {}

  async listByProject(projectId: string): Promise<Channel[]> {
    const rows = await this.channels.find({
      where: { projectId, deletedAt: IsNull() },
      order: { orderIndex: "ASC", createdAt: "ASC" },
    });
    return rows.map(toChannel);
  }

  async findById(projectId: string, id: string): Promise<Channel | null> {
    const row = await this.channels.findOne({ where: { id, projectId, deletedAt: IsNull() } });
    return row ? toChannel(row) : null;
  }

  countByProject(projectId: string): Promise<number> {
    return this.channels.count({ where: { projectId, deletedAt: IsNull() } });
  }

  async save(channel: Channel): Promise<void> {
    await this.channels.save(this.channels.create(channel as unknown as ChannelEndpointEntity));
  }
}

/**
 * La conversación de una sesión vive partida en dos tablas, y aquí se junta.
 *
 * La fila guarda el estado —apertura, cierre, contadores, veredicto— y los mensajes van aparte: una
 * sesión de doscientos mensajes no reescribe los doscientos cada vez que llega uno. Al leer, la
 * conversación se reconstruye con `blankConversation()` como base, para que un campo nuevo del tipo
 * tenga su valor por omisión en vez de `undefined` en las filas viejas.
 */
@Injectable()
export class TypeOrmChannelSessionRepository implements ChannelSessionRepositoryPort {
  constructor(
    @InjectRepository(ChannelSessionEntity) private readonly sessions: Repository<ChannelSessionEntity>,
    @InjectRepository(ChannelMessageEntity) private readonly messages: Repository<ChannelMessageEntity>,
  ) {}

  async save(session: ChannelSession): Promise<void> {
    const { conversation } = session;
    await this.sessions.save(
      this.sessions.create({
        id: session.id,
        channelId: session.channelId,
        projectId: session.projectId,
        environmentId: session.environmentId,
        status: session.status,
        handshake: conversation.handshake,
        counters: {
          ...conversation.counters,
          openedAtMs: conversation.openedAtMs,
          closedAtMs: conversation.closedAtMs,
          closeReason: conversation.closeReason,
          trailers: conversation.trailers,
        },
        verdict: session.verdict,
        stopReason: session.stopReason,
        closeCode: conversation.closeCode,
        ownerInstance: session.ownerInstance,
        heartbeatAt: session.heartbeatAt,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        startedBy: session.startedBy,
        prunedAt: null,
      }),
    );
  }

  async findById(projectId: string, id: string): Promise<ChannelSession | null> {
    const row = await this.sessions.findOne({ where: { id, projectId } });
    return row ? toSession(row) : null;
  }

  async listByChannel(projectId: string, channelId: string, limit: number): Promise<ChannelSession[]> {
    const rows = await this.sessions.find({
      where: { projectId, channelId },
      order: { openedAt: "DESC" },
      take: limit,
    });
    return rows.map(toSession);
  }

  async appendMessages(sessionId: string, messages: ChannelMessage[]): Promise<void> {
    if (!messages.length) return;
    await this.messages.insert(messages.map((message) => ({ sessionId, ...message })));
  }

  async listMessages(sessionId: string): Promise<ChannelMessage[]> {
    const rows = await this.messages.find({ where: { sessionId }, order: { seq: "ASC" } });
    return rows.map((row) => ({
      seq: row.seq,
      direction: row.direction as MessageDirection,
      kind: row.kind as MessageKind,
      atMs: row.atMs,
      bytes: row.bytes,
      truncated: row.truncated,
      body: row.body,
    }));
  }

  countLive(ownerInstance: string): Promise<number> {
    return this.sessions.count({ where: { ownerInstance, status: In(["connecting", "open"]) } });
  }

  async findStale(before: Date): Promise<ChannelSession[]> {
    // Por el índice parcial de la migración: solo las abiertas, que son pocas siempre.
    const rows = await this.sessions.find({
      where: { status: In(["connecting", "open"]), heartbeatAt: LessThan(before) },
      take: 100,
    });
    return rows.map(toSession);
  }

  async beat(ownerInstance: string, now: Date): Promise<void> {
    await this.sessions.update({ ownerInstance, status: In(["connecting", "open"]) }, { heartbeatAt: now });
  }
}

type StoredCounters = Conversation["counters"] & {
  openedAtMs?: number | null;
  closedAtMs?: number | null;
  closeReason?: string;
  trailers?: Record<string, string> | null;
};

function toSession(row: ChannelSessionEntity): ChannelSession {
  const counters = (row.counters ?? {}) as StoredCounters;
  const blank = blankConversation();
  return {
    id: row.id,
    channelId: row.channelId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    status: row.status as SessionStatus,
    conversation: {
      ...blank,
      handshake: (row.handshake as Conversation["handshake"]) ?? null,
      openedAtMs: counters.openedAtMs ?? null,
      closedAtMs: counters.closedAtMs ?? null,
      closeCode: row.closeCode,
      closeReason: counters.closeReason ?? "",
      trailers: counters.trailers ?? null,
      stopped: (row.stopReason as Conversation["stopped"]) ?? null,
      counters: {
        sent: counters.sent ?? 0,
        received: counters.received ?? 0,
        bytesIn: counters.bytesIn ?? 0,
        bytesOut: counters.bytesOut ?? 0,
      },
    },
    verdict: (row.verdict as ChannelSession["verdict"]) ?? null,
    stopReason: (row.stopReason as ChannelSession["stopReason"]) ?? null,
    ownerInstance: row.ownerInstance,
    heartbeatAt: row.heartbeatAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    startedBy: row.startedBy,
  };
}
