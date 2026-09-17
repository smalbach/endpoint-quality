import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

import {
  DOC_VISIBILITIES,
  MAX_DOC_BASE_URL,
  MAX_DOC_INTRO,
  MAX_DOC_NAME,
  type DocVisibility,
} from "../../domain/model";

/**
 * `visibility` es **obligatorio** y no tiene valor por defecto, como en un mock y por lo mismo: una
 * documentación publicada enseña la forma de la API de alguien, y si la opción cómoda fuera la
 * abierta se publicaría sin elegirlo.
 *
 * `includeExamples` sí tiene valor por defecto —`false`, lo pone el dominio— porque es una decisión
 * distinta y menor: publicar la *forma* de la API es una cosa y publicar sus *datos* es otra. La que
 * arrastra datos empieza apagada; encenderla es un clic y se ve.
 *
 * La forma de `baseUrl` se valida en el dominio y no aquí: la regla es que sea una URL entera **sin
 * variables**, porque esta página no tiene entorno con el que resolverlas, y eso no es una longitud.
 */
export class CreateDocSiteDto {
  @IsString() @MinLength(1) @MaxLength(MAX_DOC_NAME) name: string;
  @IsIn(DOC_VISIBILITIES) visibility: DocVisibility;
  @IsOptional() @IsString() @MaxLength(MAX_DOC_BASE_URL) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(MAX_DOC_INTRO) intro?: string;
  @IsOptional() @IsBoolean() includeExamples?: boolean;
}

export class UpdateDocSiteDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_DOC_NAME) name?: string;
  @IsOptional() @IsIn(DOC_VISIBILITIES) visibility?: DocVisibility;
  @IsOptional() @IsString() @MaxLength(MAX_DOC_BASE_URL) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(MAX_DOC_INTRO) intro?: string;
  @IsOptional() @IsBoolean() includeExamples?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
