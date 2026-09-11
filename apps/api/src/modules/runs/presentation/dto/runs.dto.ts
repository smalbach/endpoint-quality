import {
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
import type { OrderMode, ScenarioAuth } from "@eq/runner-core";

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
  /** Pasos de un flujo a la vez. Capado bajo a propósito: lo que hay al otro lado es el entorno de
   * pruebas de alguien, y una corrida que abre veinte conexiones a la vez mide su rate limiter. */
  @IsOptional() @IsInt() @Min(1) @Max(10) concurrency?: number;
  /** A row's id, so it is a uuid. When present the run executes that graph instead of the
   * generated matrix. */
  @IsOptional() @IsUUID() workflowId?: string;
  /** Walks the flow once per row. Meaningless without `workflowId`, and refused as such. */
  @IsOptional() @IsUUID() datasetId?: string;
  /** Walks every flow of the suite, in order, as one run. Exclusive with `workflowId`. */
  @IsOptional() @IsUUID() suiteId?: string;
}

const AUTH = ["default", "none", "insufficient", "api-key"];

/**
 * The request to send, flat: what the form has on screen, plus the environment to send it against.
 *
 * Flat and not a nested `template` object because there is no template row involved. Naming one
 * would invite a `templateId` that means «send the saved version», and two meanings of «enviar»
 * is exactly the surprise this avoids — what gets sent is what is being looked at.
 */
export class PreviewRequestDto {
  @IsUUID() environmentId: string;
  @IsString() @MinLength(1) @MaxLength(200) operationId: string;
  /** Only ever shown back in an assertion's text. Absent is fine: the request is not being saved. */
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsInt() @Min(100) @Max(599) expectedStatus: number;
  @IsOptional() @IsObject() parameters?: Record<string, string>;
  /** No `disabled…` counterpart: this is not a row being saved, it is a request being sent, and
   * what is switched off is simply not in it. The editor drops them before it calls. */
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsObject() body?: Record<string, unknown> | null;
  @IsOptional() @IsIn(AUTH, { message: `auth debe ser uno de: ${AUTH.join(", ")}` }) auth?: ScenarioAuth;
}
