/**
 * Lo propio de un canal gRPC: sus `.proto`, la definición que se enseña en el selector de métodos,
 * la reflexión bajo demanda y el medio cierre de un stream.
 *
 * Leer es `viewer` y el resto `editor`, como el canal: la reflexión abre una conexión contra el
 * servidor con la credencial del canal, y eso es tan capaz como abrir una sesión.
 */
import { Inject } from "@nestjs/common";
import {
  CommandHandler,
  QueryHandler,
  type ICommand,
  type ICommandHandler,
  type IQuery,
  type IQueryHandler,
} from "@nestjs/cqrs";

import { ENV, type Env } from "@/shared/config/env";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { BlockedTargetError } from "@/shared/http/safe-fetch";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import {
  CHANNEL_PROTO_REPOSITORY,
  protoFilesProblems,
  type ChannelProtoRepositoryPort,
  type ProtoFile,
} from "../../domain/grpc";
import { ProtoSchemaError, schemaFromFiles, type GrpcServiceView } from "../../domain/grpc-schema";
import { effectiveLimits, type Channel } from "../../domain/model";
import {
  CHANNEL_REPOSITORY,
  CHANNEL_SESSION_REPOSITORY,
  type ChannelRepositoryPort,
  type ChannelSessionRepositoryPort,
} from "../../domain/ports";
import { isFinished } from "../../domain/session";
import { ReflectionError } from "../../infrastructure/grpc-reflection";
import { ChannelSessionRegistry } from "../../infrastructure/session-registry";
import { GrpcSessionPlanner } from "../grpc";
import { ceilingsOf } from "./manage-channels";
import { resolveChannelTarget } from "./manage-sessions";

/** Lo que ve el selector: los ficheros —sin su contenido— y los servicios que definen. */
export type GrpcSchemaView = {
  files: { path: string; bytes: number }[];
  services: GrpcServiceView[];
  /** Por qué no se pudieron leer, si no se pudieron. Los ficheros se enseñan igual. */
  problem: string | null;
};

async function grpcChannel(channels: ChannelRepositoryPort, projectId: string, channelId: string): Promise<Channel> {
  const channel = await channels.findById(projectId, channelId);
  if (!channel) throw new NotFoundError("El canal no existe", "channel-not-found");
  if (channel.protocol !== "grpc")
    throw new ConflictError("Este canal no es gRPC: no tiene .proto ni métodos", "channel-not-grpc");
  return channel;
}

const listed = (files: ProtoFile[]) =>
  files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") }));

export class GetGrpcSchemaQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
  ) {}
}

@QueryHandler(GetGrpcSchemaQuery)
export class GetGrpcSchemaHandler implements IQueryHandler<GetGrpcSchemaQuery, GrpcSchemaView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_PROTO_REPOSITORY) private readonly protos: ChannelProtoRepositoryPort,
  ) {}

  async execute(query: GetGrpcSchemaQuery): Promise<GrpcSchemaView> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const channel = await grpcChannel(this.channels, project.id, query.channelId);
    const files = await this.protos.list(channel.id);
    if (!files.length) return { files: [], services: [], problem: null };
    try {
      return { files: listed(files), services: schemaFromFiles(files).services(), problem: null };
    } catch (error) {
      // Un conjunto guardado que ya no se lee —se guardó con otra versión del analizador— se enseña
      // con el motivo, en vez de un 422 que deja la pantalla sin ficheros que reemplazar.
      if (error instanceof ProtoSchemaError) return { files: listed(files), services: [], problem: error.message };
      throw error;
    }
  }
}

export class SaveChannelProtosCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly files: ProtoFile[],
  ) {}
}

/**
 * Reemplazar los `.proto` del canal. Se leen **antes** de guardar: un conjunto que no se puede leer
 * es un 422 con el fichero y la línea, no un canal que falla al invocar.
 */
@CommandHandler(SaveChannelProtosCommand)
export class SaveChannelProtosHandler implements ICommandHandler<SaveChannelProtosCommand, GrpcSchemaView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(CHANNEL_PROTO_REPOSITORY) private readonly protos: ChannelProtoRepositoryPort,
  ) {}

  async execute(command: SaveChannelProtosCommand): Promise<GrpcSchemaView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const channel = await grpcChannel(this.channels, project.id, command.channelId);
    const problems = protoFilesProblems(command.files);
    if (problems.length) throw new InvalidInputError("Los .proto no son válidos", problems);
    const files = command.files.map((file) => ({ path: file.path, content: file.content }));
    let services: GrpcServiceView[] = [];
    if (files.length) {
      try {
        services = schemaFromFiles(files).services();
      } catch (error) {
        if (error instanceof ProtoSchemaError)
          throw new InvalidInputError("Los .proto no se pudieron leer", [
            { field: error.field, detail: error.message },
          ]);
        throw error;
      }
    }
    await this.protos.replace(channel.id, files);
    return { files: listed(files), services, problem: null };
  }
}

export class ReflectGrpcCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly environmentId: string | null,
  ) {}
}

/**
 * Preguntar al servidor por reflexión, con el entorno, la metadata y la credencial del canal: lo
 * mismo con lo que se abriría una sesión. No se guarda nada —la definición es la del servidor ese
 * día—; lo que no se puede leer es un 422 que lo dice, y la guarda de red, un 422 con su motivo.
 */
@CommandHandler(ReflectGrpcCommand)
export class ReflectGrpcHandler implements ICommandHandler<ReflectGrpcCommand, GrpcSchemaView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(ENV) private readonly env: Env,
    private readonly planner: GrpcSessionPlanner,
  ) {}

  async execute(command: ReflectGrpcCommand): Promise<GrpcSchemaView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const channel = await grpcChannel(this.channels, project.id, command.channelId);
    const { url, headers } = await resolveChannelTarget(
      { environments: this.environments, cipher: this.cipher },
      project.id,
      channel,
      command.environmentId,
    );
    try {
      const schema = await this.planner.reflect({
        url,
        headers,
        limits: effectiveLimits(channel.limits, ceilingsOf(this.env)),
      });
      return { files: [], services: schema.services(), problem: null };
    } catch (error) {
      if (error instanceof BlockedTargetError || error instanceof ReflectionError || error instanceof ProtoSchemaError)
        throw new InvalidInputError(error.message, [{ field: "url", detail: error.message }], "grpc-reflection-failed");
      throw error;
    }
  }
}

export class EndChannelStreamCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
  ) {}
}

/** El medio cierre: «ya no mando más», y el servidor contesta lo que le quede. */
@CommandHandler(EndChannelStreamCommand)
export class EndChannelStreamHandler implements ICommandHandler<EndChannelStreamCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(command: EndChannelStreamCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const session = await this.sessions.findById(project.id, command.sessionId);
    if (!session) throw new NotFoundError("La sesión no existe", "channel-session-not-found");
    if (isFinished(session)) throw new ConflictError("La sesión ya terminó", "channel-session-finished");
    this.registry.end(session.id);
  }
}

export const GRPC_COMMAND_HANDLERS = [SaveChannelProtosHandler, ReflectGrpcHandler, EndChannelStreamHandler];
export const GRPC_QUERY_HANDLERS = [GetGrpcSchemaHandler];
