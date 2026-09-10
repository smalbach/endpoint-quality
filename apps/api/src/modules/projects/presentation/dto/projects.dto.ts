import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

import { MAX_SPEC_BYTES } from "@/shared/http/body-limits";

export class CreateProjectDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class ArchiveProjectDto {
  @IsBoolean() archived: boolean;
}

/**
 * Where a contract comes from.
 *
 * The size cap on `raw` is a real limit and not a formality: the document is stored, parsed and
 * held in memory, and an unbounded upload is a denial of service that needs no cleverness.
 * 8 MB is roughly seventy times Digital Catalog's 118 KB contract.
 */
export class SpecSourceDto {
  @IsIn(["url", "inline", "upload"]) kind: "url" | "inline" | "upload";

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ["http", "https"] }, { message: "url debe ser una dirección http o https" })
  @MaxLength(2000)
  url?: string;

  @IsOptional() @IsString() @MaxLength(MAX_SPEC_BYTES, { message: "el documento supera los 8 MB" }) raw?: string;
  @IsOptional() @IsString() @MaxLength(300) filename?: string;
  /**
   * Headers for a contract behind authentication.
   *
   * Stored encrypted against this source's location, with the same cipher as the target
   * credentials — a header carrying a bearer token is exactly as much of a credential as the
   * token. Sending them once is enough: a later import or drift check of the **same URL** reuses
   * them, which is what lets a drift check run on a schedule with no secret in the request.
   */
  @IsOptional() @IsObject() headers?: Record<string, string>;
}

export class ImportSpecDto {
  /**
   * Optional: omitted, the project re-reads wherever it read last time.
   *
   * That is the difference between a drift check somebody runs and one that runs on a schedule —
   * a cron job that has to carry the contract's credentials in its request is a cron job with a
   * secret in it.
   */
  @IsOptional() @ValidateNested() @Type(() => SpecSourceDto) source?: SpecSourceDto;
  /** Absent means activate, which is what importing usually means. A drift check passes false. */
  @IsOptional() @IsBoolean() activate?: boolean;
}
