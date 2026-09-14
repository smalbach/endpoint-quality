import {
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
} from "class-validator";

/** Every field optional: sensible defaults live in the command, and an empty body is a full run
 * with the recommended rules against the active environment. */
export class StartSecurityRunDto {
  @IsOptional() @IsUUID() environmentId?: string;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  /** A partial `{ ruleKey: boolean }`; missing keys fall back to the recommended selection. */
  @IsOptional() @IsObject() rules?: Record<string, boolean>;
  @IsOptional() @IsInt() @Min(5) @Max(50) rateLimitIterations?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(30000) requestTimeoutMs?: number;
  @IsOptional() @IsBoolean() crossUserPermutations?: boolean;
  @IsOptional() @IsArray() @IsUUID("4", { each: true }) endpointIds?: string[];
  @IsOptional() @IsString() @MaxLength(20) adminRole?: string | null;
}

export class SecurityRunVisibilityDto {
  @IsIn(["private", "public"]) visibility: "private" | "public";
}
