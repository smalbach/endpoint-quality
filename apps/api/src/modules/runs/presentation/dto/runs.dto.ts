import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import type { OrderMode } from "@eq/runner-core";

export class StartRunDto {
  @IsUUID() environmentId: string;

  @IsOptional() @IsIn(["safe", "contract", "custom"]) order?: OrderMode;
  @IsOptional() @IsArray() @IsString({ each: true }) customOrder?: string[];
  /** Empty or absent means the whole contract. A subset button that silently means everything is
   * how a 46-operation write run gets started by accident. */
  @IsOptional() @IsArray() @IsString({ each: true }) operationIds?: string[];
  @IsOptional() @IsObject() caseSelection?: Record<string, string[]>;

  /** One sample is a measurement, not a percentile — the latency assertion says so. Capped at 50
   * so a matrix cannot turn into a load test by accident. */
  @IsOptional() @IsInt() @Min(1) @Max(50) samples?: number;
  /** Some targets rate-limit, and 311 cases fired flat out are indistinguishable from an attack. */
  @IsOptional() @IsInt() @Min(0) @Max(30_000) delayMs?: number;
  /** A row's id, so it is a uuid. When present the run executes that graph instead of the
   * generated matrix. */
  @IsOptional() @IsUUID() workflowId?: string;
}
