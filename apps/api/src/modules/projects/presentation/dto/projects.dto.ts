import { PROJECT_AUTH_TYPES, type ProjectAuthType } from "@/modules/projects/domain/project-auth";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

import { MAX_SPEC_BYTES } from "@/shared/http/body-limits";

/** How the project logs in to its API. Secrets travel as strings; the mask means «unchanged». */
export class ProjectAuthDto {
  @IsIn(PROJECT_AUTH_TYPES) type: ProjectAuthType;
  @IsOptional() @IsString() @MaxLength(8000) token?: string;
  @IsOptional() @IsString() @MaxLength(2000) loginUrl?: string;
  @IsOptional() @IsString() @MaxLength(10) loginMethod?: string;
  @IsOptional() @IsString() @MaxLength(20_000) loginBody?: string;
  @IsOptional() @IsString() @MaxLength(500) tokenPath?: string;
  @IsOptional() @IsString() @MaxLength(320) username?: string;
  @IsOptional() @IsString() @MaxLength(1000) password?: string;
  @IsOptional() @IsString() @MaxLength(200) headerName?: string;
  @IsOptional() @IsString() @MaxLength(8000) apiKey?: string;
}

export class CreateProjectDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(2000) baseUrl?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @ValidateNested() @Type(() => ProjectAuthDto) auth?: ProjectAuthDto;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(2000) baseUrl?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @ValidateNested() @Type(() => ProjectAuthDto) auth?: ProjectAuthDto;
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

/** Una bifurcación: cómo se llama. Todo lo demás sale del original. */
export class ForkProjectDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

/**
 * Aplicar una comparación: la huella de la que se vio, y quién gana en cada conflicto.
 *
 * `resolutions` es `tipo:clave` → `source` o `target`. Se valida contra la comparación en el
 * comando, que es quien sabe qué conflictos hay.
 */
export class SyncForkDto {
  @IsString() @MaxLength(64) token: string;
  @IsOptional() @IsObject() resolutions?: Record<string, "source" | "target">;
}

/** Una solicitud de fusión: qué se pide, dicho por quien lo pide. Lo que se lleva sale de la comparación. */
export class CreateMergeRequestDto {
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(10_000) description?: string;
}

export class MergeRequestCommentDto {
  @IsString() @MaxLength(10_000) body: string;
}

/** Aprobar, rechazar o retirar, con un comentario opcional que va en la misma línea del hilo. */
export class MergeRequestReviewDto {
  @IsOptional() @IsString() @MaxLength(10_000) body?: string;
}

/** Element-by-element import: exactly which endpoints, flows and environments to bring. */
export class ImportElementsDto {
  @IsUUID() sourceProjectId: string;
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID("4", { each: true }) endpointIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("4", { each: true }) workflowIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID("4", { each: true }) environmentIds?: string[];
}

/** A project file and which of the parts it carries to bring. Its content is validated by the
 * command, piece by piece, with the validators each editor uses — not here. */
export class ImportProjectBundleDto {
  @IsObject() bundle: Record<string, unknown>;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) parts?: string[];
}

/** One thing handed to the import: a file's name and its text, or a paste with no name. */
export class ImportSourceDto {
  @IsOptional() @IsString() @MaxLength(260) name?: string;
  @IsString() @MaxLength(MAX_SPEC_BYTES) text: string;
}

/**
 * La credencial con la que leer la URL de un import. **No se guarda en ninguna parte.**
 *
 * Es el secreto de un tercero y llega para una sola petición: no hay tabla donde acabe, no sale en
 * el resumen del import, no aparece en el error y no se escribe en ningún log. Se usa y se olvida
 * — lo contrario que la del contrato, que sí se guarda cifrada porque un chequeo de deriva
 * programado tiene que volver a leer la misma URL él solo. Ver `shared/import/url-credential.ts`.
 *
 * Qué campos hacen falta con cada `kind` lo decide el comando y no estos decoradores: es una sola
 * comprobación, en el módulo que construye la cabecera.
 */
export class ImportUrlAuthDto {
  @IsIn(["bearer", "header"]) kind: "bearer" | "header";
  @IsOptional() @IsString() @MaxLength(8000) token?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(8000) value?: string;
}

/**
 * The one import: files, a paste, or a link — and it works out what each one is.
 *
 * Nothing here says what the things *are*: that is read off their content, which is the whole
 * point (see `shared/import/detect.ts`). `dryRun` answers with the plan and writes nothing, which
 * is what lets the dialog be read before it is confirmed.
 */
export class ImportAnythingDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ImportSourceDto)
  sources?: ImportSourceDto[];
  /** Read through the same SSRF guard as every other outbound request. */
  @IsOptional() @IsString() @IsUrl({ require_tld: false }) @MaxLength(2000) url?: string;
  /** Para una colección o un OpenAPI detrás de auth. Se usa para esa petición y se olvida. */
  @IsOptional() @ValidateNested() @Type(() => ImportUrlAuthDto) urlAuth?: ImportUrlAuthDto;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  /** The base URL every environment in the batch is stored with, overriding what its file says. */
  @IsOptional() @IsString() @MaxLength(2000) baseUrl?: string;
}
