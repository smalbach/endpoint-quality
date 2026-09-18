import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsUUID } from "class-validator";

import { MAX_IMPORT_ITEMS } from "../../application/commands/manage-captures";

export class StartCaptureDto {
  /**
   * Descifrar HTTPS en esta sesión. Solo vale con `CAPTURE_MITM=true` en el despliegue, y solo
   * sirve si el dispositivo instaló la CA de la instalación.
   */
  @IsOptional() @IsBoolean() decryptHttps?: boolean;
}

export class ImportCaptureDto {
  /** Las peticiones elegidas en la lista. Las que no son de la sesión se ignoran. */
  @IsArray() @ArrayMaxSize(MAX_IMPORT_ITEMS) @IsUUID("all", { each: true }) itemIds: string[];
  /** Además de los endpoints, un flujo con las peticiones en el orden en que se capturaron. */
  @IsOptional() @IsBoolean() flow?: boolean;
}
