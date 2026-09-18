import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Socket.IO como protocolo de canal.
 *
 * La misma decisión que MQTT y gRPC: una fila más de `channel_endpoints` (`protocol = 'socketio'`,
 * que cabe en el `varchar(10)` de siempre), con sus sesiones y sus mensajes en las mismas tablas. Lo
 * que falta es poco y todo nulable, así que las filas de los demás protocolos no cambian:
 *
 * - `channel_endpoints.socketio`: ruta, espacio de nombres, carga de `auth`, query, eventos que se
 *   oyen y transportes. Una columna `jsonb` y no seis, por lo mismo que `mqtt` y `grpc`. La carga y
 *   la query se guardan **sin** los valores escritos a mano de sus campos de credencial.
 * - `channel_messages.event` y `ack`: el nombre del evento de cada mensaje (ya tapado, como el tema
 *   de MQTT) y si se pidió acuse o el mensaje **es** el acuse. Columnas y no parte del cuerpo, porque
 *   una comprobación sobre el cuerpo no puede tropezar con el nombre del evento, y la pantalla lo
 *   enseña aparte.
 */
export class ChannelSocketIo1700000036000 implements MigrationInterface {
  name = "ChannelSocketIo1700000036000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_endpoints" ADD COLUMN "socketio" jsonb`);
    await queryRunner.query(`ALTER TABLE "channel_messages" ADD COLUMN "event" text`);
    await queryRunner.query(`ALTER TABLE "channel_messages" ADD COLUMN "ack" boolean`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Un canal Socket.IO no se puede usar sin sus ajustes: se va con la columna, y sus sesiones con él.
    await queryRunner.query(`DELETE FROM "channel_endpoints" WHERE "protocol" = 'socketio'`);
    await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "ack"`);
    await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "event"`);
    await queryRunner.query(`ALTER TABLE "channel_endpoints" DROP COLUMN "socketio"`);
  }
}
