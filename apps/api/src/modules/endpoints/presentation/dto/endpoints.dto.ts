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
