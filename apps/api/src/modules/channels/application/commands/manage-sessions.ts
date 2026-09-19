/**
 * Abrir una sesión con un canal, mandarle mensajes y cerrarla.
 *
 * Abrir es donde se junta todo lo que el canal no sabe por sí solo: el entorno contra el que se
 * abre, sus variables —descifradas aquí y en ningún otro sitio—, la autenticación firmada, y la
 * lista de secretos contra la que se tapa cada mensaje. Lo que sale de aquí hacia el registro es
 * un plan ya resuelto; el registro no vuelve a ver una plantilla ni una variable.
 *
 * **La lista de secretos se construye antes de abrir y viaja con el plan**, porque es lo que
 * `applyFrame` usa para tapar cada mensaje antes de guardarlo o emitirlo. Un secreto que no está en
 * esa lista —un token que el servidor inventa y devuelve— lo tapa la regla por nombre de campo
 * (`redactBody`), que es la segunda red y la misma que usan los ejemplos guardados.
 */
import { createHmac, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import {
  interpolateText,
  publishTopicProblem,
  signAuth,
  type ComputedSeed,
  unresolvedVariables,
  withEnvironmentNamespace,
  type ChannelLimits,
  type RequestAuth,
} from "@eq/runner-core";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { writableProject } from "@/modules/endpoints/application/commands/manage-endpoints";
import { SECRET_PARAMS } from "@/modules/endpoints/application/commands/auth-bridge";
import { redactBody } from "@/modules/endpoints/domain/examples";
import { resolveVariables } from "@/modules/environments/domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { Environment } from "@/modules/environments/domain/model";
import { MAX_SAVED_MESSAGE_BYTES, effectiveLimits, type Channel } from "../../domain/model";
import { SECRET_METADATA } from "../../domain/grpc";
import {
  mqttSessionPlan,
  planProblems,
  userPropertiesProblems,
  type MqttPublish,
  type MqttQos,
  type MqttSessionPlan,
} from "../../domain/mqtt";
import {
  eventNameProblem,
  socketIoSessionPlan,
  type SocketIoEmit,
  type SocketIoSessionPlan,
} from "../../domain/socketio";
import { SOCKETIO_TRANSPORT, type SocketIoTransportPort } from "../../infrastructure/socketio-transport";
import {
  CHANNEL_REPOSITORY,
  CHANNEL_SESSION_REPOSITORY,
  type ChannelRepositoryPort,
  type ChannelSessionRepositoryPort,
} from "../../domain/ports";
import { isFinished, startSession, type ChannelSession } from "../../domain/session";
import {
  ChannelSessionRegistry,
  type BinaryEncoding,
  type MqttSubscriptionResult,
  type SessionPlan,
} from "../../infrastructure/session-registry";
import { viewSession, type ChannelSessionView } from "../views";
import { GrpcSessionPlanner } from "../grpc";
import { ceilingsOf } from "./manage-channels";

export class OpenChannelSessionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly channelId: string,
    readonly environmentId: string | null,
    readonly actorId: string,
  ) {}
}

/**
 * Abrir una sesión, venga de donde venga: del botón «Conectar» o de un nodo canal de un flujo.
 *
 * **Un solo camino** a propósito. Todo lo que protege una sesión se decide aquí o más abajo —la
 * guarda de red en el transporte, los topes recortados al techo, la lista de secretos, la regla por
 * nombre de campo, el entorno sin escrituras, los métodos gRPC sin efectos—, y una corrida que
 * abriera sus sockets por su cuenta sería un segundo sitio donde cada una de esas reglas puede faltar
 * sin que ninguna prueba se ponga roja.
 *
 * Lo único que cambia para una corrida entra por argumentos y solo puede **añadir** cautela o datos:
 * sus variables encima del entorno (con sus secretos en la lista), una petición gRPC distinta de la
 * guardada, una inactividad más corta, y la escucha de lo recibido para las capturas.
 */
@Injectable()
export class ChannelSessionOpener {
  constructor(
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
    private readonly registry: ChannelSessionRegistry,
    private readonly grpc: GrpcSessionPlanner,
    @Optional() @Inject(SOCKETIO_TRANSPORT) private readonly socketio: SocketIoTransportPort | null = null,
  ) {}

  async open(input: {
    projectId: string;
    channel: Channel;
    environmentId: string | null;
    actorId: string;
    overlay?: { variables: Record<string, string>; secrets: string[] };
    /** Solo gRPC: la petición de la llamada en lugar de la guardada. */
    grpcRequest?: string;
    /** Solo puede bajar la del canal. */
    idleMs?: number;
    onReceived?: SessionPlan["onReceived"];
  }): Promise<ChannelSession> {
    const channel =
      input.grpcRequest !== undefined && input.channel.grpc
        ? { ...input.channel, grpc: { ...input.channel.grpc, message: input.grpcRequest } }
        : input.channel;
    const { environment, url, headers, secrets, interpolate, variables, mqtt, socketio } = await resolveChannelTarget(
      { environments: this.environments, cipher: this.cipher },
      input.projectId,
      channel,
      input.environmentId,
      input.overlay,
    );
    const ceiling = effectiveLimits(channel.limits, ceilingsOf(this.env));
    const limits = input.idleMs ? { ...ceiling, idleMs: Math.min(ceiling.idleMs, input.idleMs) } : ceiling;
    const readOnly = environment ? !environment.writesAllowed : false;
    // Un canal gRPC trae su propia apertura; el registro le pasa las mismas escuchas que a un socket.
    const open =
      channel.protocol === "grpc"
        ? await this.grpc.prepare(channel, {
            url,
            headers,
            interpolate,
            limits,
            readOnly,
            environmentName: environment?.name ?? "",
          })
        : socketio
          ? socketIoOpener(
              this.socketio,
              url,
              headers,
              socketio,
              limits,
              Math.min(limits.maxDurationMs, this.env.REQUEST_TIMEOUT_MS),
            )
          : undefined;

    const session = startSession({
      id: randomUUID(),
      channelId: channel.id,
      projectId: input.projectId,
      environmentId: environment?.id ?? null,
      ownerInstance: this.registry.instance,
      startedBy: input.actorId,
      now: this.clock.now(),
    });
    return this.registry.start(session, {
      url,
      headers,
      subprotocols: channel.subprotocols,
      limits,
      rules: {
        // En gRPC, cada secreto también en base64: la metadata `-bin` que vuelve se enseña así, y un
        // servidor que devuelve en un trailer binario el token que recibió lo devuelve en base64.
        secrets: channel.protocol === "grpc" ? withBase64(secrets) : secrets,
        // La segunda red: los campos que se llaman como una credencial y los JWT por su forma, que
        // es lo que tapa un token que el servidor inventa y que ninguna variable conocía.
        redact: redactMessage,
        // Y en las cabeceras de la apertura y los trailers, por nombre: la lista de siempre, también
        // con `-bin` detrás (`x-api-key-bin` es la misma credencial en bytes).
        secretHeader: SECRET_METADATA,
      },
      expect: channel.expectations,
      readOnly,
      environmentName: environment?.name ?? "",
      open,
      // Los mensajes llevan `{{variables}}` como la URL y las cabeceras: sin esto, una trama
      // guardada con `{{token}}` viajaba con las llaves literales, y guardarla con el valor es
      // dejar la credencial en la columna del canal. La semilla es nueva en cada mensaje, porque
      // `{{$uuid}}` en una trama es un id por mensaje y no uno por sesión.
      interpolate: (text) => interpolateText(text, variables, freshSeed(this.clock.now())),
      ...(mqtt ? { mqtt } : {}),
      ...(input.onReceived ? { onReceived: input.onReceived } : {}),
    });
  }
}

/**
 * Lo que abre un canal Socket.IO: su transporte con el plan ya resuelto. Una trama que traduce el
 * transporte —un evento con su nombre, un acuse— entra por `onFrame`, con la hora de la sesión.
 */
function socketIoOpener(
  transport: SocketIoTransportPort | null,
  url: string,
  headers: Record<string, string>,
  plan: SocketIoSessionPlan,
  limits: ChannelLimits,
  connectTimeoutMs: number,
): SessionPlan["open"] {
  return (listeners) => {
    if (!transport) throw new Error("Esta instancia no tiene transporte Socket.IO");
    return transport.open(
      url,
      { ...plan, headers, maxMessageBytes: limits.maxMessageBytes, connectTimeoutMs, ackTimeoutMs: connectTimeoutMs },
      (frame) => listeners.onFrame?.(frame),
    );
  };
}

@CommandHandler(OpenChannelSessionCommand)
export class OpenChannelSessionHandler implements ICommandHandler<OpenChannelSessionCommand, ChannelSessionView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
    private readonly opener: ChannelSessionOpener,
  ) {}

  async execute(command: OpenChannelSessionCommand): Promise<ChannelSessionView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const channel = await this.channels.findById(project.id, command.channelId);
    if (!channel) throw new NotFoundError("El canal no existe", "channel-not-found");
    const started = await this.opener.open({
      projectId: project.id,
      channel,
      environmentId: command.environmentId,
      actorId: command.actorId,
    });
    return viewSession(started, this.registry.owns(started.id));
  }
}

/**
 * Lo que un canal necesita para abrir, resuelto contra el entorno: URL, cabeceras firmadas, los
 * secretos contra los que se tapa cada mensaje, y cómo interpolar lo que llegue después.
 *
 * Fuera del manejador porque abrir no es lo único que lo necesita: la reflexión de un canal gRPC
 * habla con el mismo servidor, con la misma metadata y la misma credencial, y dos maneras de
 * resolverlas serían dos respuestas a «¿con qué me conecto?».
 */
export async function resolveChannelTarget(
  deps: { environments: EnvironmentRepositoryPort; cipher: SecretCipherPort },
  projectId: string,
  channel: Channel,
  environmentId: string | null,
  /**
   * Lo que una corrida sabe además del entorno: sus variables (las capturadas por pasos anteriores,
   * la sesión de un login) y los valores que hay que tapar con ellas. Encima del entorno, como en un
   * paso HTTP de la misma corrida; sin esto, un nodo canal no podría gastar el token de un login.
   */
  overlay?: { variables: Record<string, string>; secrets: string[] },
): Promise<{
  environment: Environment | null;
  url: string;
  headers: Record<string, string>;
  secrets: string[];
  interpolate: (value: string) => string;
  variables: Record<string, string>;
  mqtt: MqttSessionPlan | undefined;
  socketio: SocketIoSessionPlan | undefined;
}> {
  const environment = environmentId ? await deps.environments.findById(environmentId) : null;
  if (environmentId && (!environment || environment.projectId !== projectId))
    throw new NotFoundError("El entorno no existe", "environment-not-found");

  const values = environment ? resolveVariables(environment.variables, (payload) => deps.cipher.decrypt(payload)) : {};
  const variables = { ...withEnvironmentNamespace(values), ...overlay?.variables };
  const interpolate = (value: string) => interpolateText(value, variables);

  // Los valores de las variables sensibles: lo primero que se tapa en cada mensaje. `values` tiene
  // una entrada por cada variable del entorno, así que el nombre siempre está.
  const secrets = environment
    ? Object.entries(environment.variables)
        .filter(([, variable]) => variable.sensitive)
        .map(([name]) => values[name])
        .filter(Boolean)
    : [];
  for (const secret of overlay?.secrets ?? []) if (secret) secrets.push(secret);

  let url = interpolate(channel.url);
  const headers: Record<string, string> = {};
  for (const header of channel.headers) {
    if (header.enabled && header.name.trim()) headers[header.name.trim()] = interpolate(header.value);
  }

  // MQTT: usuario y contraseña salen de la autenticación `basic`, y la contraseña entra aquí en la
  // lista de secretos —ver `mqttSessionPlan`—. No se «firma»: no hay upgrade que firmar.
  const mqtt =
    channel.protocol === "mqtt" && channel.mqtt
      ? mqttSessionPlan(channel.mqtt, channel.auth, interpolate, secrets, () => randomUUID().slice(0, 8))
      : undefined;

  // Socket.IO: la carga de `auth` y la query, resueltas, con cada valor de la carga en los secretos.
  const socketio =
    channel.protocol === "socketio" && channel.socketio
      ? socketIoSessionPlan(channel.socketio, url, interpolate, secrets)
      : undefined;

  const unresolved = unresolvedVariables([url, headers, mqtt ?? null, socketio?.plan ?? null]);
  if (unresolved.length) {
    throw new InvalidInputError(
      `Variables sin valor: ${unresolved.join(", ")}`,
      unresolved.map((name) => ({
        field: "environmentId",
        detail: `{{${name}}} no tiene valor${environment ? ` en «${environment.name}»` : ": elige un entorno"}`,
      })),
      "unresolved-variables",
    );
  }

  const planned = mqtt ? planProblems(mqtt) : [];
  if (planned.length) throw new InvalidInputError("Las suscripciones no son válidas con este entorno", planned);
  if (socketio?.problems.length)
    throw new InvalidInputError("La carga de auth no es válida con este entorno", socketio.problems);

  if (!mqtt && channel.auth && channel.auth.type !== "none" && channel.auth.type !== "inherit") {
    url = sign(channel.auth, url, headers, interpolate, secrets, channel.protocol);
  }
  return { environment, url, headers, secrets, interpolate, variables, mqtt, socketio: socketio?.plan };
}

/**
 * La autenticación, firmada y puesta donde toque: cabecera o query.
 *
 * La query no es un detalle en un socket: un navegador **no puede** poner cabeceras en un
 * WebSocket, así que las APIs de verdad aceptan el token en `?access_token=`. Va a la URL, que no
 * se guarda en ninguna parte —la sesión no tiene columna de URL— y cuyo valor entra en la lista
 * de secretos igual que el de una cabecera.
 *
 * Lo que necesita pedir algo al servidor antes de firmar —el reto de Digest, un token de OAuth 2.0
 * que todavía no existe— no se hace aquí, y se dice en vez de abrir sin credencial.
 */
function sign(
  auth: RequestAuth,
  url: string,
  headers: Record<string, string>,
  interpolate: (value: string) => string,
  secrets: string[],
  protocol: Channel["protocol"],
): string {
  const resolved: RequestAuth = {
    type: auth.type,
    params: Object.fromEntries(Object.entries(auth.params).map(([key, value]) => [key, interpolate(value)])),
  };
  for (const [key, value] of Object.entries(resolved.params)) {
    if (SECRET_PARAMS.has(key) && value) secrets.push(value);
  }
  // gRPC es un POST de HTTP/2; lo que firma una autenticación de esta lista no depende de la URL.
  const signed = signAuth(resolved, { method: protocol === "grpc" ? "POST" : "GET", url, headers });
  if (signed.unsupported || signed.needsChallenge) {
    throw new InvalidInputError(
      "La autenticación de este canal no se puede firmar al abrir",
      [
        {
          field: "auth",
          detail:
            signed.unsupported ??
            "Este tipo necesita pedir un reto al servidor antes de firmar, y un upgrade no tiene cómo",
        },
      ],
      "channel-auth-unsupported",
    );
  }
  for (const pair of signed.headers) {
    headers[pair.name] = pair.value;
    secrets.push(pair.value);
  }
  if (!signed.query.length) return url;
  // Una llamada gRPC no tiene query: la ruta es `/paquete.Servicio/Metodo`.
  if (protocol === "grpc")
    throw new InvalidInputError(
      "En gRPC la clave va en la metadata",
      [{ field: "auth", detail: "Una llamada gRPC no tiene query: pon la clave de API en una cabecera" }],
      "channel-auth-unsupported",
    );
  const withQuery = new URL(url);
  for (const pair of signed.query) {
    withQuery.searchParams.set(pair.name, pair.value);
    secrets.push(pair.value);
  }
  return withQuery.toString();
}

/**
 * Tapar un mensaje **sin reescribirlo** cuando no hay nada que tapar.
 *
 * `redactBody` devuelve el JSON formateado, que para un ejemplo guardado está bien y para una
 * transcripción no: una conversación tiene que enseñar lo que pasó por el cable, y un mensaje
 * compacto que aparece con saltos de línea y sangría es otro texto —con otro tamaño que el de
 * `bytes`, y contra el que un `matches` escrito sobre el original ya no casa—. Lo cazó la prueba
 * contra un servidor de verdad; la guionizada no comparaba cuerpos exactos.
 *
 * Así que: sin nada tapado, el texto tal cual; con algo tapado, compacto si llegó compacto.
 */
export function redactMessage(text: string): string {
  const result = redactBody(text, "application/json");
  if (!result.masked.length) return text;
  if (text.includes("\n")) return result.body;
  // Con algo tapado, el cuerpo es el JSON que `redactBody` volvió a serializar: siempre se lee.
  return JSON.stringify(JSON.parse(result.body));
}

/**
 * Los secretos, y cada uno también en base64 (estándar con y sin relleno, y URL). Con relleno se
 * tapa entero un valor que es solo el secreto; sin él, el que sigue con más bytes detrás. Solo casa
 * cuando el secreto empieza el valor binario —que es el caso de un eco—: en mitad de otros bytes, su
 * base64 depende de lo que tenga delante.
 */
export function withBase64(secrets: string[]): string[] {
  const encoded = secrets.flatMap((secret) => {
    const bytes = Buffer.from(secret, "utf8");
    const padded = bytes.toString("base64");
    return [padded, padded.replace(/=+$/, ""), bytes.toString("base64url")];
  });
  return [...new Set([...secrets, ...encoded])];
}

/** Lo que resuelve `{{$uuid}}`, `{{$now}}` y compañía, igual que en «Enviar» de un endpoint. */
const freshSeed = (now: Date): ComputedSeed => ({
  uuid: randomUUID(),
  now,
  random: Math.random(),
  hmacSha256: (key, text) => createHmac("sha256", key).update(text).digest("hex"),
});

export class SendChannelMessageCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
    readonly text: string,
    /** Solo en MQTT: a qué tema, con qué QoS y si se retiene. */
    readonly publish?: MqttPublish,
    /** Solo en un WebSocket: el texto son bytes en base64 o hexadecimal, y sale como trama binaria. */
    readonly binary?: BinaryEncoding,
    /** Solo en Socket.IO, y ahí obligatorio: el evento, el acuse y los argumentos. */
    readonly emit?: SocketIoEmit,
  ) {}
}

@CommandHandler(SendChannelMessageCommand)
export class SendChannelMessageHandler implements ICommandHandler<SendChannelMessageCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(command: SendChannelMessageCommand): Promise<void> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const session = await this.sessions.findById(project.id, command.sessionId);
    if (!session) throw new NotFoundError("La sesión no existe", "channel-session-not-found");
    if (isFinished(session)) throw new ConflictError("La sesión ya terminó", "channel-session-finished");
    if (typeof command.text !== "string" || Buffer.byteLength(command.text, "utf8") > MAX_SAVED_MESSAGE_BYTES) {
      throw new InvalidInputError("El mensaje no es válido", [
        { field: "text", detail: `Texto, como mucho ${MAX_SAVED_MESSAGE_BYTES / 1024} KB` },
      ]);
    }
    const topicProblem = command.publish ? publishTopicProblem(command.publish.topic) : null;
    if (topicProblem)
      throw new InvalidInputError("El mensaje no es válido", [{ field: "topic", detail: topicProblem }]);
    const propertyProblems =
      command.publish?.userProperties !== undefined
        ? userPropertiesProblems(command.publish.userProperties, "userProperties")
        : [];
    if (propertyProblems.length) throw new InvalidInputError("El mensaje no es válido", propertyProblems);
    const emitProblems = command.emit ? emitInputProblems(command.emit) : [];
    if (emitProblems.length) throw new InvalidInputError("El mensaje no es válido", emitProblems);
    // Esté donde esté el socket: si lo tiene otra instancia viva, la orden va a ella por el bus.
    await this.registry.route(session, {
      op: "send",
      sessionId: session.id,
      text: command.text,
      publish: command.publish,
      binary: command.binary,
      emit: command.emit,
    });
  }
}

/** Lo que un `emit` tiene mal antes de llegar a la sesión: el nombre, y cuántos y cómo de grandes. */
function emitInputProblems(emit: SocketIoEmit): { field: string; detail: string }[] {
  const problems: { field: string; detail: string }[] = [];
  // Con `{{variables}}` el nombre se vuelve a mirar ya resuelto; aquí, lo que ya se sabe.
  const eventProblem = eventNameProblem(emit.event);
  if (eventProblem) problems.push({ field: "event", detail: eventProblem });
  if (emit.args !== undefined) {
    if (!Array.isArray(emit.args) || emit.args.some((arg) => typeof arg !== "string"))
      problems.push({ field: "args", detail: "Los argumentos son una lista de textos" });
    else if (emit.args.length > MAX_EMIT_ARGS) problems.push({ field: "args", detail: `Como mucho ${MAX_EMIT_ARGS}` });
    else if (emit.args.reduce((sum, arg) => sum + Buffer.byteLength(arg, "utf8"), 0) > MAX_SAVED_MESSAGE_BYTES)
      problems.push({ field: "args", detail: `Entre todos, como mucho ${MAX_SAVED_MESSAGE_BYTES / 1024} KB` });
  }
  return problems;
}

/** Los argumentos de un evento. Diez es más de los que usa cualquier API de verdad. */
const MAX_EMIT_ARGS = 10;

export class CloseChannelSessionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
  ) {}
}

@CommandHandler(CloseChannelSessionCommand)
export class CloseChannelSessionHandler implements ICommandHandler<CloseChannelSessionCommand, ChannelSessionView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(command: CloseChannelSessionCommand): Promise<ChannelSessionView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const session = await this.sessions.findById(project.id, command.sessionId);
    if (!session) throw new NotFoundError("La sesión no existe", "channel-session-not-found");
    // Cerrar una que ya terminó no es un error: el resultado que se pedía ya está.
    if (isFinished(session)) return viewSession(session, false);
    return viewSession(await this.registry.route(session, { op: "close", sessionId: session.id }), false);
  }
}

/**
 * Suscribirse a un filtro, o darse de baja, con la sesión MQTT abierta.
 *
 * Como mandar, por su id y solo en la instancia que tiene el socket; a diferencia de mandar, un
 * entorno sin escrituras lo deja hacer, porque suscribirse es escuchar.
 */
export class ChangeChannelSubscriptionCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly sessionId: string,
    readonly action: "subscribe" | "unsubscribe",
    readonly topic: string,
    readonly qos: MqttQos = 0,
  ) {}
}

@CommandHandler(ChangeChannelSubscriptionCommand)
export class ChangeChannelSubscriptionHandler implements ICommandHandler<
  ChangeChannelSubscriptionCommand,
  MqttSubscriptionResult
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_SESSION_REPOSITORY) private readonly sessions: ChannelSessionRepositoryPort,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(command: ChangeChannelSubscriptionCommand): Promise<MqttSubscriptionResult> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const session = await this.sessions.findById(project.id, command.sessionId);
    if (!session) throw new NotFoundError("La sesión no existe", "channel-session-not-found");
    if (isFinished(session)) throw new ConflictError("La sesión ya terminó", "channel-session-finished");
    return command.action === "subscribe"
      ? this.registry.route(session, { op: "subscribe", sessionId: session.id, topic: command.topic, qos: command.qos })
      : this.registry.route(session, { op: "unsubscribe", sessionId: session.id, topic: command.topic });
  }
}

export const CHANNEL_SESSION_COMMAND_HANDLERS = [
  OpenChannelSessionHandler,
  SendChannelMessageHandler,
  CloseChannelSessionHandler,
  ChangeChannelSubscriptionHandler,
];
