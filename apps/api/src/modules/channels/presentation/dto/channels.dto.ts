/**
 * La forma de lo que llega. Solo lo de primer nivel.
 *
 * Lo de dentro —cabeceras, topes, comprobaciones— lo valida `channelProblems`, que comprueba el
 * **tipo** de cada cosa además de su valor. Esa comprobación está ahí por una lección reciente: un
 * DTO que dice `@IsObject()` y nada más deja pasar cualquier cosa dentro, y un campo que el tipo de
 * TypeScript promete texto y llega como objeto acababa en un 500 con traza de Node.
 */
import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
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

export class CreateChannelDto {
  /** Sin él, un WebSocket: es lo que era un canal antes de que hubiera otro protocolo. */
  @IsOptional() @IsIn(CHANNEL_PROTOCOLS) protocol?: ChannelProtocol;
  @IsString() @MaxLength(MAX_CHANNEL_NAME) name: string;
  @IsString() @MaxLength(MAX_CHANNEL_URL) url: string;
  @IsOptional() @IsArray() subprotocols?: string[];
  @IsOptional() @IsArray() headers?: EndpointHeader[];
  @IsOptional() @IsObject() auth?: RequestAuth | null;
  @IsOptional() @IsObject() limits?: Partial<ChannelLimits>;
  @IsOptional() @IsObject() expectations?: ChannelExpectation;
  @IsOptional() @IsArray() messages?: SavedMessage[];
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
  @IsOptional() @IsObject() grpc?: Partial<GrpcSettings>;
}

export class OpenChannelSessionDto {
  /** Sin entorno se abre igual, pero una URL con `{{variables}}` no tendrá de dónde sacarlas. */
  @IsOptional() @IsUUID() environmentId?: string;
}

export class SendChannelMessageDto {
  @IsString() text: string;
}
