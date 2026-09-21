import type { RequestAuth } from "@eq/runner-core";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import {
  ENDPOINT_METHODS,
  ENDPOINT_STATUSES,
  MAX_PATH,
  MAX_SCRIPT,
  type EndpointBody,
  type EndpointHeader,
  type EndpointMethod,
  type EndpointPathParameter,
  type EndpointQueryParameter,
  type EndpointStatus,
} from "../../domain/model";
import { MAX_EXAMPLE_NAME, type ExampleRequest, type ExampleResponse } from "../../domain/examples";

const LIST_STATUSES = [...ENDPOINT_STATUSES, "all"] as const;

/**
 * The shape is checked here; what the rows mean — a duplicate name, a header with a line break, a
 * body mode — in `endpointProblems`, so the same rules apply to an import that never passes a DTO.
 */
export class CreateEndpointDto {
  @IsIn(ENDPOINT_METHODS) method: EndpointMethod;
  @IsString() @MinLength(1) @MaxLength(MAX_PATH) path: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsObject({ each: true }) pathParameters?: EndpointPathParameter[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsObject({ each: true }) query?: EndpointQueryParameter[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsObject({ each: true }) headers?: EndpointHeader[];
  @IsOptional() @IsObject() body?: EndpointBody;
  @IsOptional() @IsBoolean() requiresAuth?: boolean;
  @IsOptional() @IsObject() auth?: RequestAuth;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsIn(ENDPOINT_STATUSES) status?: EndpointStatus;
  @IsOptional() @IsString() @MaxLength(MAX_SCRIPT) preRequestScript?: string;
  @IsOptional() @IsString() @MaxLength(MAX_SCRIPT) postResponseScript?: string;
}

export class UpdateEndpointDto {
  @IsOptional() @IsIn(ENDPOINT_METHODS) method?: EndpointMethod;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_PATH) path?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsObject({ each: true }) pathParameters?: EndpointPathParameter[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsObject({ each: true }) query?: EndpointQueryParameter[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsObject({ each: true }) headers?: EndpointHeader[];
  @IsOptional() @IsObject() body?: EndpointBody;
  @IsOptional() @IsBoolean() requiresAuth?: boolean;
  @IsOptional() @IsObject() auth?: RequestAuth;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsIn(ENDPOINT_STATUSES) status?: EndpointStatus;
  @IsOptional() @IsString() @MaxLength(MAX_SCRIPT) preRequestScript?: string;
  @IsOptional() @IsString() @MaxLength(MAX_SCRIPT) postResponseScript?: string;
}

export class ListEndpointsQueryDto {
  @IsOptional() @IsIn(LIST_STATUSES) status?: EndpointStatus | "all";
  /** `deleted` pide la papelera. Ver `EndpointListFilter`: aquí no hay «archivado», es un `status`. */
  @IsOptional() @IsIn(["active", "deleted"]) state?: "active" | "deleted";
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class BulkEndpointStatusDto {
  @IsArray() @ArrayMaxSize(1000) @IsUUID("4", { each: true }) ids: string[];
  @IsIn(ENDPOINT_STATUSES) status: EndpointStatus;
}

export class BulkDeleteEndpointsDto {
  @IsArray() @ArrayMaxSize(1000) @IsUUID("4", { each: true }) ids: string[];
}

export class ImportEndpointCurlDto {
  @IsString() @MinLength(4) @MaxLength(200_000) curl: string;
}

/**
 * Un ejemplo guardado, tal y como sale de «Enviar».
 *
 * El `name` es opcional: vacío se lo pone el código de estado, que es lo que alguien busca en la
 * lista —se guardan ejemplos precisamente para tener el 200, el 404 y el 422 al lado—. El par entero
 * entra como objeto y **el dominio lo valida**, porque los límites de tamaño y la redacción son
 * suyos: repetirlos aquí como decoradores daría dos reglas que tendrían que coincidir.
 */
export class SaveExampleDto {
  @IsOptional() @IsString() @MaxLength(MAX_EXAMPLE_NAME) name?: string;
  @IsObject() request: ExampleRequest;
  @IsObject() response: ExampleResponse;
}

export class UpdateExampleDto {
  @IsOptional() @IsString() @MaxLength(MAX_EXAMPLE_NAME) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) orderIndex?: number;
  @IsOptional() @IsObject() request?: ExampleRequest;
  @IsOptional() @IsObject() response?: ExampleResponse;
}
