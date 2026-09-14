import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { PerformancePlanDefinition } from "../../domain/model";

/**
 * Thin, like the workflows DTOs: the pipe settles that the request is an object with strings of the
 * right length; what a plan's definition may *say* is the zod schema in the domain, checked inside
 * the command — a second copy of the load-profile union in decorators would be free to disagree.
 */
export class CreatePlanDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsObject() definition?: PerformancePlanDefinition;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsObject() definition?: PerformancePlanDefinition;
}

export class StartPerformanceRunDto {
  @IsUUID() environmentId: string;
}
