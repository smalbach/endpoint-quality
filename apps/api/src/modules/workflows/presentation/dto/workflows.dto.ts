import {
  ArrayMaxSize,
  IsArray,
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
import type { ScenarioAuth, WorkflowDocument } from "@eq/runner-core";

const AUTH = ["default", "none", "insufficient", "api-key"];

/**
 * Thin on purpose. What a request template or a flow may say is a zod schema in `@eq/runner-core`,
 * checked inside the command; a second copy of those rules in decorators would be free to
 * disagree with the first, and this API's published contract is derived from these validators —
 * so the weaker copy is the one that would end up in the document.
 *
 * What stays here is what the pipe can settle before anything else runs: the request is an object,
 * the strings are strings, the lengths fit the columns.
 */
export class CreateRequestTemplateDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsString() @MinLength(1) @MaxLength(200) operationId: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsInt() @Min(100) @Max(599) expectedStatus: number;
  @IsOptional() @IsObject() parameters?: Record<string, string>;
  @IsOptional() @IsObject() disabledParameters?: Record<string, string>;
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsObject() disabledHeaders?: Record<string, string>;
  @IsOptional() @IsObject() body?: Record<string, unknown> | null;
  @IsOptional() @IsIn(AUTH, { message: `auth debe ser uno de: ${AUTH.join(", ")}` }) auth?: ScenarioAuth;
}

/** Every field optional, which is what a partial update *is*. */
export class UpdateRequestTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) operationId?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsInt() @Min(100) @Max(599) expectedStatus?: number;
  @IsOptional() @IsObject() parameters?: Record<string, string>;
  @IsOptional() @IsObject() disabledParameters?: Record<string, string>;
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsObject() disabledHeaders?: Record<string, string>;
  @IsOptional() @IsObject() body?: Record<string, unknown> | null;
  @IsOptional() @IsIn(AUTH, { message: `auth debe ser uno de: ${AUTH.join(", ")}` }) auth?: ScenarioAuth;
}

export class CreateWorkflowDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsObject() definition?: WorkflowDocument;
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  /** The whole graph. There is no route that edits one node: a half-written document whose halves
   * reference each other is the state this shape exists to make impossible. */
  @IsOptional() @IsObject() definition?: WorkflowDocument;
}

/** Same division of labour as the rest of this file: the shape here, the rules about column names
 * and row counts in the engine's schema, checked inside the command. */
export class CreateDatasetDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsArray() rows?: Record<string, string>[];
}

export class UpdateDatasetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsArray() rows?: Record<string, string>[];
}

export class CreateSuiteDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  /** Capped because a suite is a sequence somebody reads, and one flow of it failing has to be
   * findable. Fifty is already a long release checklist. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID("4", { each: true }) workflowIds?: string[];
}

export class UpdateSuiteDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID("4", { each: true }) workflowIds?: string[];
}
