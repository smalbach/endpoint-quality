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
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import {
  interpolateText,
  publishTopicProblem,
  signAuth,
  type ComputedSeed,
  unresolvedVariables,
  withEnvironmentNamespace,
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
import { MAX_SAVED_MESSAGE_BYTES, effectiveLimits } from "../../domain/model";
import { mqttSessionPlan, planProblems, type MqttPublish } from "../../domain/mqtt";
import {
  CHANNEL_REPOSITORY,
  CHANNEL_SESSION_REPOSITORY,
  type ChannelRepositoryPort,
  type ChannelSessionRepositoryPort,
} from "../../domain/ports";
import { isFinished, startSession } from "../../domain/session";
import { ChannelSessionRegistry } from "../../infrastructure/session-registry";
import { viewSession, type ChannelSessionView } from "../views";
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

@CommandHandler(OpenChannelSessionCommand)
export class OpenChannelSessionHandler implements ICommandHandler<OpenChannelSessionCommand, ChannelSessionView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
    private readonly registry: ChannelSessionRegistry,
  ) {}

  async execute(command: OpenChannelSessionCommand): Promise<ChannelSessionView> {
    const project = await writableProject(this.projects, command.organizationId, command.projectId);
    const channel = await this.channels.findById(project.id, command.channelId);
    if (!channel) throw new NotFoundError("El canal no existe", "channel-not-found");

    const environment = command.environmentId ? await this.environments.findById(command.environmentId) : null;
    if (command.environmentId && (!environment || environment.projectId !== project.id))
      throw new NotFoundError("El entorno no existe", "environment-not-found");

    const values = environment
      ? resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload))
      : {};
    const variables = withEnvironmentNamespace(values);
    const interpolate = (value: string) => interpolateText(value, variables);

    // Los valores de las variables sensibles: lo primero que se tapa en cada mensaje.
    const secrets = environment
      ? Object.entries(environment.variables)
          .filter(([, variable]) => variable.sensitive)
          .map(([name]) => values[name] ?? "")
          .filter(Boolean)
      : [];

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

    const unresolved = unresolvedVariables([url, headers, mqtt ?? null]);
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

    if (!mqtt && channel.auth && channel.auth.type !== "none" && channel.auth.type !== "inherit") {
      url = this.sign(channel.auth, url, headers, interpolate, secrets);
    }

    const session = startSession({
      id: randomUUID(),
      channelId: channel.id,
      projectId: project.id,
      environmentId: environment?.id ?? null,
      ownerInstance: this.registry.instance,
      startedBy: command.actorId,
      now: this.clock.now(),
    });
    const started = await this.registry.start(session, {
      url,
      headers,
      subprotocols: channel.subprotocols,
      limits: effectiveLimits(channel.limits, ceilingsOf(this.env)),
      rules: {
        secrets,
        // La segunda red: los campos que se llaman como una credencial y los JWT por su forma, que
        // es lo que tapa un token que el servidor inventa y que ninguna variable conocía.
        redact: redactMessage,
      },
      expect: channel.expectations,
      readOnly: environment ? !environment.writesAllowed : false,
      environmentName: environment?.name ?? "",
      // Los mensajes llevan `{{variables}}` como la URL y las cabeceras: sin esto, una trama
      // guardada con `{{token}}` viajaba con las llaves literales, y guardarla con el valor es
      // dejar la credencial en la columna del canal. La semilla es nueva en cada mensaje, porque
      // `{{$uuid}}` en una trama es un id por mensaje y no uno por sesión.
      interpolate: (text) => interpolateText(text, variables, freshSeed(this.clock.now())),
      ...(mqtt ? { mqtt } : {}),
    });
    return viewSession(started, this.registry.owns(started.id));
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
  private sign(
    auth: RequestAuth,
    url: string,
    headers: Record<string, string>,
    interpolate: (value: string) => string,
    secrets: string[],
  ): string {
    const resolved: RequestAuth = {
      type: auth.type,
      params: Object.fromEntries(Object.entries(auth.params).map(([key, value]) => [key, interpolate(value)])),
    };
    for (const [key, value] of Object.entries(resolved.params)) {
      if (SECRET_PARAMS.has(key) && value) secrets.push(value);
    }
    const signed = signAuth(resolved, { method: "GET", url, headers });
    if (signed.unsupported || signed.needsChallenge) {
      throw new InvalidInputError(
        "La autenticación de este canal no se puede firmar para un WebSocket",
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
    const withQuery = new URL(url);
    for (const pair of signed.query) {
      withQuery.searchParams.set(pair.name, pair.value);
      secrets.push(pair.value);
    }
    return withQuery.toString();
  }
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
  try {
    return JSON.stringify(JSON.parse(result.body));
  } catch {
    return result.body;
  }
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
    await this.registry.send(session.id, command.text, command.publish);
  }
}

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
    return viewSession(await this.registry.close(session.id), false);
  }
}

export const CHANNEL_SESSION_COMMAND_HANDLERS = [
  OpenChannelSessionHandler,
  SendChannelMessageHandler,
  CloseChannelSessionHandler,
];
