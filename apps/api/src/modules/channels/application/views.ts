/**
 * Lo que sale por la API de un canal y de una sesión.
 *
 * La sesión sale **sin** `ownerInstance`: es un nombre de máquina y un pid, y no le sirve a nadie en
 * la pantalla. Lo que sí sale es `live` —si esta instancia tiene el socket—, que es lo único que la
 * pantalla necesita para saber si puede mandar y escuchar o solo leer.
 */
import type { ChannelMessage } from "@eq/runner-core";

import type { Channel } from "../domain/model";
import type { ChannelSession } from "../domain/session";

export type ChannelView = Omit<Channel, "projectId" | "createdAt" | "updatedAt" | "deletedAt" | "updatedBy"> & {
  createdAt: string;
  updatedAt: string;
};

export function viewChannel(channel: Channel): ChannelView {
  const { projectId: _projectId, deletedAt: _deletedAt, updatedBy: _updatedBy, ...rest } = channel;
  return { ...rest, createdAt: channel.createdAt.toISOString(), updatedAt: channel.updatedAt.toISOString() };
}

export type ChannelSessionView = {
  id: string;
  channelId: string;
  environmentId: string | null;
  status: ChannelSession["status"];
  handshake: ChannelSession["conversation"]["handshake"];
  counters: ChannelSession["conversation"]["counters"];
  closeCode: number | null;
  closeReason: string;
  /** Los trailers de una llamada gRPC, ya tapados. `null` en un WebSocket. */
  trailers: Record<string, string> | null;
  stopReason: ChannelSession["stopReason"];
  verdict: ChannelSession["verdict"];
  openedAt: string;
  closedAt: string | null;
  /** Si el socket lo tiene esta instancia. Sin eso, la sesión se puede leer y no usar. */
  live: boolean;
  messages?: ChannelMessage[];
};

export function viewSession(session: ChannelSession, live: boolean, messages?: ChannelMessage[]): ChannelSessionView {
  return {
    id: session.id,
    channelId: session.channelId,
    environmentId: session.environmentId,
    status: session.status,
    handshake: session.conversation.handshake,
    counters: session.conversation.counters,
    closeCode: session.conversation.closeCode,
    closeReason: session.conversation.closeReason,
    trailers: session.conversation.trailers,
    stopReason: session.stopReason,
    verdict: session.verdict,
    openedAt: session.openedAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
    live,
    ...(messages ? { messages } : {}),
  };
}
