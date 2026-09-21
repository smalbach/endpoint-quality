import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

import type { CollectionDocument } from "../../domain/model";
import { MAX_DELAY_MS, MAX_ITERATIONS } from "../../application/commands/run-collection";

/**
 * Finos, como los de flujos y planes: el pipe zanja que llegó un objeto con cadenas de un largo
 * razonable, y qué puede *decir* el documento lo zanja el esquema zod del dominio, comprobado
 * dentro del comando. Una segunda copia del árbol en decoradores sería libre de discrepar.
 */
export class CreateCollectionDto {
  @IsString() @MinLength(1) @MaxLength(300) name: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsObject() document?: CollectionDocument;
}

export class UpdateCollectionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) name?: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsObject() document?: CollectionDocument;
}

export class ImportPostmanCollectionDto {
  @IsString() @MinLength(2) text: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) name?: string;
}

export class RunCollectionDto {
  /** Sin entorno se corre contra la URL base del proyecto, como «No Environment» en Postman. */
  @IsOptional() @IsUUID() environmentId?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_ITERATIONS) iterations?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_DELAY_MS) delayMs?: number;
  @IsOptional() @IsBoolean() stopOnFailure?: boolean;
  @IsOptional() @IsString() @MaxLength(80) folderId?: string | null;
}

/**
 * El botón de enviar de una petición de la colección, con lo que hay en pantalla.
 *
 * Lleva la petición **tal como está escrita**, guardada o no —enviar antes de guardar es lo normal
 * mientras se ajusta una— y el `itemId` de dónde vive, que es lo que deja al servidor componer los
 * scripts de las carpetas de encima y resolver de quién hereda la autenticación. Componerlo en el
 * navegador sería una segunda copia de esas dos reglas, libre de discrepar con la del runner.
 */
export class SendCollectionRequestDto {
  @IsOptional() @IsUUID() environmentId?: string | null;
  /** Dónde vive la petición. Ausente en una recién creada que todavía no se ha guardado. */
  @IsOptional() @IsString() @MaxLength(80) itemId?: string | null;
  @IsObject() request: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(50_000) preRequestScript?: string;
  @IsOptional() @IsString() @MaxLength(50_000) postResponseScript?: string;
}
