/**
 * La forma de lo que llega. Solo lo de primer nivel.
 *
 * Lo de dentro —cabeceras, topes, comprobaciones— lo valida `channelProblems`, que comprueba el
 * **tipo** de cada cosa además de su valor. Esa comprobación está ahí por una lección reciente: un
 * DTO que dice `@IsObject()` y nada más deja pasar cualquier cosa dentro, y un campo que el tipo de
 * TypeScript promete texto y llega como objeto acababa en un 500 con traza de Node.
 */
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { ChannelExpectation, ChannelLimits, RequestAuth } from "@eq/runner-core";

import type { EndpointHeader } from "@/modules/endpoints/domain/model";
import {
  CHANNEL_PROTOCOLS,
  MAX_CHANNEL_NAME,
  MAX_CHANNEL_URL,
  type ChannelProtocol,
  type SavedMessage,
} from "../../domain/model";
import type { GrpcSettings } from "../../domain/grpc";
import type { MqttQos, MqttSettings, MqttUserProperty } from "../../domain/mqtt";

export class CreateChannelDto {
  /** Ausente es `ws`, que es lo que eran todos los canales antes de MQTT y gRPC. */
  @IsOptional() @IsIn(CHANNEL_PROTOCOLS) protocol?: ChannelProtocol;
  @IsString() @MaxLength(MAX_CHANNEL_NAME) name: string;
  @IsString() @MaxLength(MAX_CHANNEL_URL) url: string;
  @IsOptional() @IsArray() subprotocols?: string[];
  @IsOptional() @IsArray() headers?: EndpointHeader[];
  @IsOptional() @IsObject() auth?: RequestAuth | null;
  @IsOptional() @IsObject() limits?: Partial<ChannelLimits>;
  @IsOptional() @IsObject() expectations?: ChannelExpectation;
  @IsOptional() @IsArray() messages?: SavedMessage[];
  @IsOptional() @IsObject() mqtt?: Partial<MqttSettings>;
  @IsOptional() @IsObject() grpc?: Partial<GrpcSettings>;
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @MaxLength(MAX_CHANNEL_NAME) name?: string;
  @IsOptional() @IsString() @MaxLength(MAX_CHANNEL_URL) url?: string;
  @IsOptional() @IsArray() subprotocols?: string[];
  @IsOptional() @IsArray() headers?: EndpointHeader[];
  /** `null` quita la autenticación. Ausente la deja como estaba. */
  @IsOptional() auth?: RequestAuth | null;
  @IsOptional() @IsObject() limits?: Partial<ChannelLimits>;
  @IsOptional() @IsObject() expectations?: ChannelExpectation;
  @IsOptional() @IsArray() messages?: SavedMessage[];
  @IsOptional() @IsObject() mqtt?: Partial<MqttSettings>;
  @IsOptional() @IsObject() grpc?: Partial<GrpcSettings>;
}

export class OpenChannelSessionDto {
  /** Sin entorno se abre igual, pero una URL con `{{variables}}` no tendrá de dónde sacarlas. */
  @IsOptional() @IsUUID() environmentId?: string;
}

export class SendChannelMessageDto {
  @IsString() text: string;
  /** Solo en MQTT, y ahí obligatorio: a qué tema se publica. */
  @IsOptional() @IsString() topic?: string;
  @IsOptional() @IsIn([0, 1, 2]) qos?: MqttQos;
  @IsOptional() @IsBoolean() retain?: boolean;
  /**
   * Solo en un WebSocket: el texto son bytes escritos en base64 o en hexadecimal, y sale como una
   * trama binaria. Ausente o `text`: una trama de texto, como siempre.
   */
  @IsOptional() @IsIn(["text", "base64", "hex"]) encoding?: "text" | "base64" | "hex";
  /** Solo en MQTT 5: propiedades de usuario del `PUBLISH`, con `{{variables}}`. */
  @IsOptional() @IsArray() userProperties?: MqttUserProperty[];
}

/** Un filtro al que suscribirse, o del que darse de baja, a mitad de una sesión MQTT. */
export class ChannelSubscriptionDto {
  @IsString() @MaxLength(65_535) topic: string;
  @IsOptional() @IsIn([0, 1, 2]) qos?: MqttQos;
}
