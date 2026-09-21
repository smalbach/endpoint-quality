/**
 * El cuerpo de `PATCH …/:id/archived`, escrito una vez.
 *
 * Un booleano y no dos rutas (`/archive` y `/unarchive`) por lo mismo que en el proyecto: el botón
 * de la pantalla es un interruptor, y dos rutas obligan al navegador a decidir cuál llamar a
 * partir de un estado que ya le mandó el servidor.
 */
import { IsBoolean } from "class-validator";

export class SetArchivedDto {
  @IsBoolean() archived: boolean;
}
