/**
 * Crear, cambiar y borrar un canal.
 *
 * Los techos del despliegue entran aquí desde `env` y bajan al dominio como un valor: el dominio no
 * lee el entorno, pero tiene que saber dónde está el techo para decir «como mucho 30 segundos» al
 * guardar, en vez de guardar una hora y recortar en silencio al abrir.
 */
import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import {
  archiveIn,
  deleteIn,
  restoreIn,
  type LifecycleNoun,
  type LifecycleStore,
} from "@/shared/lifecycle/lifecycle-store";
import { ENV, type Env } from "@/shared/config/env";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import {
  MAX_CHANNELS_PER_PROJECT,
  blankChannel,
  channelProblems,
  withChanges,
  type Channel,
  type ChannelCeilings,
  type ChannelInput,
} from "../../domain/model";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "../../domain/ports";
import { viewChannel, type ChannelView } from "../views";

export function ceilingsOf(env: Env): ChannelCeilings {
  return {
    maxMessages: env.CHANNEL_MAX_MESSAGES,
    maxBytes: env.CHANNEL_MAX_BYTES,
    maxMessageBytes: env.CHANNEL_MAX_MESSAGE_BYTES,
    maxDurationMs: env.CHANNEL_MAX_DURATION_MS,
    idleMs: env.CHANNEL_MAX_IDLE_MS,
    maxOpen: env.CHANNEL_MAX_OPEN,
  };
}

export class CreateChannelCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: ChannelInput & { name: string; url: string },
    readonly actorId: string,
  ) {}
}

@CommandHandler(CreateChannelCommand)
export class CreateChannelHandler implements ICommandHandler<CreateChannelCommand, ChannelView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(command: CreateChannelCommand): Promise<ChannelView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    // Nombre y URL se piden aunque no vengan: `channelProblems` solo mira lo que se manda, y crear
    // un canal sin ellos tiene que ser un 422 que los nombre, no un canal a medias.
    const problems = channelProblems(
      { ...command.input, name: command.input.name ?? "", url: command.input.url ?? "" },
      ceilingsOf(this.env),
    );
    if (problems.length) throw new InvalidInputError("El canal no es válido", problems);

    if ((await this.channels.countByProject(project.id)) >= MAX_CHANNELS_PER_PROJECT) {
      throw new ConflictError(
        `Este proyecto ya tiene ${MAX_CHANNELS_PER_PROJECT} canales: borra alguno antes de crear otro`,
        "channels-full",
      );
    }

    const now = this.clock.now();
    const blank = blankChannel({
      id: randomUUID(),
      projectId: project.id,
      name: command.input.name,
      url: command.input.url,
      now,
      by: command.actorId,
      protocol: command.input.protocol,
    });
    const channel = withChanges(blank, command.input, now, command.actorId);
    await this.channels.save(channel);
    return viewChannel(channel);
  }
}

export class UpdateChannelCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly input: ChannelInput,
    readonly actorId: string,
  ) {}
}

@CommandHandler(UpdateChannelCommand)
export class UpdateChannelHandler implements ICommandHandler<UpdateChannelCommand, ChannelView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(command: UpdateChannelCommand): Promise<ChannelView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const channel = await this.channels.findById(project.id, command.channelId);
    if (!channel) throw new NotFoundError("El canal no existe", "channel-not-found");
    // El protocolo lo pone el canal y no quien escribe: decide qué se valida, y no cambia.
    const problems = channelProblems({ ...command.input, protocol: channel.protocol }, ceilingsOf(this.env));
    if (problems.length) throw new InvalidInputError("El canal no es válido", problems);

    const changed = withChanges(channel, command.input, this.clock.now(), command.actorId);
    await this.channels.save(changed);
    return viewChannel(changed);
  }
}

/** Borrar un canal: blando por defecto, definitivo con `purge` y solo sobre algo ya eliminado. */
export class DeleteChannelCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly actorId: string,
    readonly purge = false,
  ) {}
}

/** Archivar un canal: sale de la lista y deja de poder abrirse, sin perder sus tramas guardadas. */
export class SetChannelArchivedCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly actorId: string,
    readonly archived: boolean,
  ) {}
}

/** Restaurar un canal eliminado, con sus tramas y sus sesiones. */
export class RestoreChannelCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly actorId: string,
  ) {}
}

/** Cómo se llama esto en los errores del ciclo de vida. */
const CHANNEL: LifecycleNoun = { code: "channel", that: "El canal", the: "el canal" };

/** El almacén de canales con la forma del servicio de ciclo de vida. */
const channelStore = (channels: ChannelRepositoryPort): LifecycleStore<Channel> => ({
  findById: (projectId, id) => channels.findAnyById(projectId, id),
  save: (row) => channels.save(row),
  remove: (projectId, id) => channels.remove(projectId, id),
});

const touchedBy = (actorId: string) => (row: Channel, now: Date) => ({ ...row, updatedAt: now, updatedBy: actorId });

/**
 * Borrar es en blando, como un endpoint: las sesiones de un canal borrado siguen siendo lo que pasó
 * aquel día, y la clave ajena en cascada se las llevaría si la fila desapareciera.
 *
 * Lo que faltaba no era el borrado blando —ya estaba— sino la vuelta: hasta aquí la fila se marcaba
 * y no había ninguna pantalla desde la que deshacerlo. `?purge=true` es el definitivo, y ese sí se
 * lleva las conversaciones.
 */
@CommandHandler(DeleteChannelCommand)
export class DeleteChannelHandler implements ICommandHandler<DeleteChannelCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeleteChannelCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    await deleteIn(
      channelStore(this.channels),
      project.id,
      command.channelId,
      command.purge,
      this.clock.now(),
      CHANNEL,
      { patch: touchedBy(command.actorId) },
    );
  }
}

@CommandHandler(SetChannelArchivedCommand)
export class SetChannelArchivedHandler implements ICommandHandler<SetChannelArchivedCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetChannelArchivedCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    await archiveIn(
      channelStore(this.channels),
      project.id,
      command.channelId,
      command.archived,
      this.clock.now(),
      CHANNEL,
      { patch: touchedBy(command.actorId) },
    );
  }
}

/**
 * Restaurar un canal eliminado.
 *
 * Comprueba el tope del proyecto, que se cuenta sobre los vivos: si mientras estaba fuera se
 * crearon canales hasta llenarlo, devolverlo lo pasaría, y un tope que se puede saltar por la
 * puerta de atrás no es un tope.
 */
@CommandHandler(RestoreChannelCommand)
export class RestoreChannelHandler implements ICommandHandler<RestoreChannelCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestoreChannelCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const channel = await this.channels.findAnyById(project.id, command.channelId);
    if (!channel) throw new NotFoundError("El canal no existe", "channel-not-found");
    if (channel.deletedAt && (await this.channels.countByProject(project.id)) >= MAX_CHANNELS_PER_PROJECT)
      throw new ConflictError(
        `Este proyecto ya tiene ${MAX_CHANNELS_PER_PROJECT} canales: borra alguno antes de restaurar este`,
        "channels-full",
      );
    await restoreIn(channelStore(this.channels), project.id, command.channelId, this.clock.now(), CHANNEL, {
      patch: touchedBy(command.actorId),
    });
  }
}
