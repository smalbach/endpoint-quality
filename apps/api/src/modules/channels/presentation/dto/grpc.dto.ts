import { IsArray, IsOptional, IsUUID } from "class-validator";

import type { ProtoFile } from "../../domain/grpc";

/** La forma de primer nivel; rutas y tamaños los mira `protoFilesProblems`, campo a campo. */
export class SaveProtosDto {
  @IsArray() files: ProtoFile[];
}

/** Sin entorno se pregunta igual, pero una URL con `{{variables}}` no tendrá de dónde sacarlas. */
export class ReflectGrpcDto {
  @IsOptional() @IsUUID() environmentId?: string;
}
