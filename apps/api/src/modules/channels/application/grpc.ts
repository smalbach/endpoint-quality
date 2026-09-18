/**
 * Lo que un canal gRPC hace además de lo que hace cualquier canal: leer su definición —de los
 * `.proto` guardados o de la reflexión—, elegir el método y preparar la llamada.
 *
 * `GrpcSessionPlanner` es la pieza que `OpenChannelSessionHandler` llama para un canal gRPC: recibe
 * lo ya resuelto contra el entorno y devuelve la apertura que el registro ejecuta. Todo lo que se
 * puede comprobar **antes** de conectar se comprueba aquí y es un 422 o un 409 con su campo —un
 * método que no existe, un JSON que no encaja, un entorno sin escrituras—; lo que solo se sabe
 * conectando —la reflexión— va dentro de la apertura, y un fallo ahí es una sesión en rojo con el
 * motivo, como un upgrade rechazado.
 */
import { Inject, Injectable } from "@nestjs/common";
import { unresolvedVariables, type ChannelLimits } from "@eq/runner-core";

import { ENV, type Env } from "@/shared/config/env";
import { ConflictError, InvalidInputError } from "@/shared/errors/domain-error";
import {
  CHANNEL_PROTO_REPOSITORY,
  binaryMetadataProblem,
  isBinaryMetadata,
  type ChannelProtoRepositoryPort,
} from "../domain/grpc";
import {
  isReadOnly,
  messageProblem,
  ProtoSchemaError,
  schemaFromFiles,
  type GrpcSchema,
  type ResolvedMethod,
} from "../domain/grpc-schema";
import type { Channel } from "../domain/model";
import {
  GRPC_TRANSPORT,
  type GrpcCall,
  type GrpcTarget,
  type GrpcTransportPort,
} from "../infrastructure/grpc-transport";
import type { ChannelListeners, OpenChannel } from "../infrastructure/ws-transport";

export type GrpcPlanContext = {
  url: string;
  headers: Record<string, string>;
  interpolate: (value: string) => string;
  limits: ChannelLimits;
  readOnly: boolean;
  environmentName: string;
};

/** El esquema de los `.proto` de un canal; un 422 con el motivo si no hay o no se leen. */
export async function storedSchema(protos: ChannelProtoRepositoryPort, channelId: string): Promise<GrpcSchema> {
  const files = await protos.list(channelId);
  if (!files.length)
    throw new InvalidInputError("El canal no tiene .proto", [
      { field: "grpc.source", detail: "Sube los .proto del servicio o usa la reflexión del servidor" },
    ]);
  try {
    return schemaFromFiles(files);
  } catch (error) {
    if (error instanceof ProtoSchemaError)
      throw new InvalidInputError(error.message, [{ field: "files", detail: error.message }]);
    throw error;
  }
}

@Injectable()
export class GrpcSessionPlanner {
  constructor(
    @Inject(GRPC_TRANSPORT) private readonly transport: GrpcTransportPort,
    @Inject(CHANNEL_PROTO_REPOSITORY) private readonly protos: ChannelProtoRepositoryPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** La apertura de una llamada, con lo que se puede comprobar ya comprobado. */
  async prepare(
    channel: Channel,
    context: GrpcPlanContext,
  ): Promise<(listeners: ChannelListeners) => Promise<OpenChannel>> {
    const settings = channel.grpc;
    if (!settings?.service || !settings.method)
      throw new InvalidInputError("Falta el método", [
        { field: "grpc.method", detail: "Elige el servicio y el método que se invocan" },
      ]);
    const target = this.target(context);
    // La petición, solo si el método la manda con la llamada: en un stream de cliente no viaja nada al
    // invocar, y una variable sin valor en un mensaje que no sale no puede impedir abrir.
    const requestOf = (method: ResolvedMethod) =>
      method.definition.requestStream
        ? null
        : parseMessage(settings.message || "{}", context.interpolate, "grpc.message");

    // Con los `.proto` guardados, todo se sabe ya: el método, su tipo y si el entorno deja invocarlo.
    let known: { method: ResolvedMethod; request: ReturnType<typeof requestOf> } | null = null;
    if (settings.source === "proto") {
      const method = resolveMethod(await storedSchema(this.protos, channel.id), settings.service, settings.method);
      known = { method, request: requestOf(method) };
      checkCall(method, known.request?.value ?? null, context);
    }

    const callOf = (resolved: ResolvedMethod, request: ReturnType<typeof requestOf>): GrpcCall => ({
      method: resolved,
      request,
      deadlineMs: settings.deadlineMs,
      decode: (text) => {
        const next = parseMessage(text, context.interpolate, "text");
        const problem = messageProblem(resolved.requestType, next.value);
        if (problem) throw new InvalidInputError(problem, [{ field: "text", detail: problem }]);
        return next.value;
      },
    });

    return async (listeners) => {
      if (known) return this.transport.call(target, callOf(known.method, known.request), listeners);
      // La reflexión va **dentro** de la llamada, por la misma conexión fijada y con la misma
      // metadata: una sesión con reflexión abre una conexión, no una para preguntar y otra para
      // invocar. Lo que falle aquí es una sesión en rojo con el motivo: ya se estaba conectando.
      return this.transport.call(
        target,
        (schema) => {
          const method = resolveMethod(schema, settings.service, settings.method);
          const request = requestOf(method);
          checkCall(method, request?.value ?? null, context);
          return callOf(method, request);
        },
        listeners,
      );
    };
  }

  /** La reflexión, sola: lo que usa el selector de métodos cuando el canal no tiene `.proto`. */
  reflect(context: Pick<GrpcPlanContext, "url" | "headers" | "limits">): Promise<GrpcSchema> {
    return this.transport.reflect(this.target(context));
  }

  private target(context: Pick<GrpcPlanContext, "url" | "headers" | "limits">): GrpcTarget {
    // Una clave `-bin` con una `{{variable}}` solo se puede comprobar ya resuelta: el valor de la
    // variable es el que tiene que ser base64. Antes de conectar, y con la clave en el motivo.
    const binary = Object.entries(context.headers).flatMap(([name, value]) => {
      const problem = isBinaryMetadata(name) ? binaryMetadataProblem(value) : null;
      return problem ? [{ field: "headers", detail: `${name}: ${problem}` }] : [];
    });
    if (binary.length) throw new InvalidInputError("La metadata binaria no es base64", binary);
    return {
      url: context.url,
      metadata: context.headers,
      connectTimeoutMs: Math.min(context.limits.maxDurationMs, this.env.REQUEST_TIMEOUT_MS),
      maxMessageBytes: context.limits.maxMessageBytes,
    };
  }
}

function resolveMethod(schema: GrpcSchema, service: string, name: string): ResolvedMethod {
  const method = schema.method(service, name);
  if (!method)
    throw new InvalidInputError(`${service}/${name} no está en la definición`, [
      { field: "grpc.method", detail: `La definición no tiene ${service}/${name}: vuelve a elegir el método` },
    ]);
  return method;
}

/**
 * Lo que se comprueba de una llamada antes de hacerla: el mensaje contra su tipo, y el entorno.
 *
 * **Un entorno sin escrituras solo invoca lo declarado sin efectos.** En HTTP la protección mira el
 * método —un `GET` se deja, un `POST` no—; en gRPC todo es un `POST`, y lo único que dice qué hace
 * un método es su `idempotency_level`. Uno declarado `NO_SIDE_EFFECTS` se deja; el resto no, y se
 * dice con la opción que lo cambiaría.
 */
function checkCall(method: ResolvedMethod, request: object | null, context: GrpcPlanContext): void {
  if (context.readOnly && !isReadOnly(method.method))
    throw new ConflictError(
      `El entorno «${context.environmentName}» no permite escrituras, y ${method.service}/${method.method.name} no está declarado sin efectos (idempotency_level = NO_SIDE_EFFECTS): en él solo se invocan los que sí`,
      "writes-not-allowed",
    );
  if (!request) return;
  const problem = messageProblem(method.requestType, request);
  if (problem) throw new InvalidInputError(problem, [{ field: "grpc.message", detail: problem }]);
}

/** Un mensaje escrito: interpolado, sin variables sueltas, y JSON. El texto es el que se anota. */
function parseMessage(
  template: string,
  interpolate: (value: string) => string,
  field: string,
): { text: string; value: object } {
  const text = interpolate(template);
  const unresolved = unresolvedVariables([text]);
  if (unresolved.length)
    throw new InvalidInputError(
      `Variables sin valor: ${unresolved.join(", ")}`,
      unresolved.map((name) => ({ field, detail: `{{${name}}} no tiene valor en el entorno` })),
      "unresolved-variables",
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = `El mensaje no es JSON: ${error instanceof Error ? error.message : error}`;
    throw new InvalidInputError(detail, [{ field, detail }]);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidInputError("El mensaje es un objeto JSON", [{ field, detail: "Un objeto JSON: {…}" }]);
  return { text, value };
}
