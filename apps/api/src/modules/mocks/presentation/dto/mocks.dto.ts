import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

import { MAX_MOCK_NAME, MOCK_VISIBILITIES, type MockDelay, type MockVisibility } from "../../domain/model";

/**
 * `visibility` es **obligatorio** y no tiene valor por defecto. Es lo único de este DTO que no es la
 * forma de un campo sino una decisión: un mock sirve datos reales de alguien —redactados, pero
 * reales— y si la opción cómoda fuera la abierta se publicaría sin elegirlo.
 *
 * El retardo se valida en el dominio y no aquí: son tres formas distintas con sus límites entre sí
 * (el mínimo no puede pasar del máximo), y eso en decoradores no se escribe.
 */
export class CreateMockDto {
  @IsString() @MinLength(1) @MaxLength(MAX_MOCK_NAME) name: string;
  @IsIn(MOCK_VISIBILITIES) visibility: MockVisibility;
  @IsOptional() @IsObject() delay?: MockDelay;
}

export class UpdateMockDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_MOCK_NAME) name?: string;
  @IsOptional() @IsIn(MOCK_VISIBILITIES) visibility?: MockVisibility;
  @IsOptional() @IsObject() delay?: MockDelay;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
