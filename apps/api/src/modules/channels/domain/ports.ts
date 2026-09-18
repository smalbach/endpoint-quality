import type { ChannelMessage } from "@eq/runner-core";

import type { Channel } from "./model";
import type { ChannelSession } from "./session";

export const CHANNEL_REPOSITORY = Symbol("CHANNEL_REPOSITORY");
export const CHANNEL_SESSION_REPOSITORY = Symbol("CHANNEL_SESSION_REPOSITORY");

/**
 * Los canales de un proyecto.
 *
 * **Toda lectura lleva `projectId`**, como en `endpoints`: un id suelto que alguien adivine no
 * alcanza el canal de otro proyecto, porque la consulta nunca pregunta solo por el id. Y las
 * lecturas no ven los borrados: los canales borran en blando, y un lector que se olvida del filtro
 * es cómo un canal borrado vuelve a aparecer en una lista.
 */
export interface ChannelRepositoryPort {
  listByProject(projectId: string): Promise<Channel[]>;
  findById(projectId: string, id: string): Promise<Channel | null>;
  countByProject(projectId: string): Promise<number>;
  save(channel: Channel): Promise<void>;
}

/**
 * Las sesiones y sus mensajes.
 *
 * La sesión se guarda sin sus mensajes (`conversation.messages` va vacío en la fila) y los mensajes
 * se añaden aparte, en orden: una sesión de doscientos mensajes no puede reescribir los doscientos
 * cada vez que llega uno.
 */
export interface ChannelSessionRepositoryPort {
  save(session: ChannelSession): Promise<void>;
  findById(projectId: string, id: string): Promise<ChannelSession | null>;
  listByChannel(projectId: string, channelId: string, limit: number): Promise<ChannelSession[]>;
  appendMessages(sessionId: string, messages: ChannelMessage[]): Promise<void>;
  listMessages(sessionId: string): Promise<ChannelMessage[]>;
  /** Las abiertas de una instancia, para el tope por proceso. */
  countLive(ownerInstance: string): Promise<number>;
  /** Las abiertas de **cualquier** instancia cuyo latido es más viejo que `before`. */
  findStale(before: Date): Promise<ChannelSession[]>;
  /** El latido de todas las abiertas de esta instancia, en una sola escritura. */
  beat(ownerInstance: string, now: Date): Promise<void>;
}
