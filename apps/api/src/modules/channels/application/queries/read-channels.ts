/**
 * Leer canales y sesiones.
 *
 * Una sesión viva se lee **de la memoria del proceso que la tiene**, y una terminada de la base de
 * datos. Las dos dicen lo mismo —los mensajes se guardan según llegan—, pero la de memoria no espera
 * a que la última escritura termine, y quien recarga en mitad de una conversación tiene que ver el
 * mensaje que acaba de llegar.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { NotFoundError } from "@/shared/errors/domain-error";
import type { LifecycleState } from "@/shared/lifecycle/lifecycle";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import {
  CHANNEL_REPOSITORY,
  CHANNEL_SESSION_REPOSITORY,
  type ChannelRepositoryPort,
  type ChannelSessionRepositoryPort,
} from "../../domain/ports";
import { ChannelSessionRegistry } from "../../infrastructure/session-registry";
import { viewChannel, viewSession, type ChannelSessionView, type ChannelView } from "../views";

/** Cuántas sesiones de un canal se enseñan. Las de antes siguen en la base; no en la lista. */
export const SESSION_HISTORY = 20;

export class ListChannelsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Qué lista se pide: los que se usan, los archivados o los eliminados. */
    readonly state: LifecycleState = "active",
  ) {}
}

@QueryHandler(ListChannelsQuery)
export class ListChannelsHandler implements IQueryHandler<ListChannelsQuery, { channels: ChannelView[] }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
  ) {}

  async execute(query: ListChannelsQuery): Promise<{ channels: ChannelView[] }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    return { channels: (await this.channels.listByProject(project.id, query.state)).map(viewChannel) };
  }
}

export class GetChannelQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
  ) {}
}

@QueryHandler(GetChannelQuery)
export class GetChannelHandler implements IQueryHandler<
  GetChannelQuery,
  ChannelView & { sessions: ChannelSessionView[] }
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(query: GetChannelQuery): Promise<ChannelView & { sessions: ChannelSessionView[] }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const channel = await this.channels.findById(project.id, query.channelId);
    if (!channel) throw new NotFoundError("El canal no existe", "channel-not-found");
    const sessions = await this.sessions.listByChannel(project.id, channel.id, SESSION_HISTORY);
    return {
      ...viewChannel(channel),
      sessions: sessions.map((session) =>
        viewSession(this.registry.current(session.id) ?? session, this.registry.usable(session)),
      ),
    };
  }
}

export class GetChannelSessionQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
  ) {}
}

@QueryHandler(GetChannelSessionQuery)
export class GetChannelSessionHandler implements IQueryHandler<GetChannelSessionQuery, ChannelSessionView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(query: GetChannelSessionQuery): Promise<ChannelSessionView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const stored = await this.sessions.findById(project.id, query.sessionId);
    if (!stored) throw new NotFoundError("La sesión no existe", "channel-session-not-found");
    const live = this.registry.current(stored.id);
    if (live) return viewSession(live, true, live.conversation.messages);
    // Abierta en otra instancia viva: la fila y sus mensajes guardados, y se puede usar igual —las
    // órdenes y el stream van a la dueña por el bus—.
    return viewSession(stored, await this.registry.answers(stored), await this.sessions.listMessages(stored.id));
  }
}

export const CHANNEL_QUERY_HANDLERS = [ListChannelsHandler, GetChannelHandler, GetChannelSessionHandler];
