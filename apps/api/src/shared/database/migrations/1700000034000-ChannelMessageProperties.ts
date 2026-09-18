import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las propiedades de MQTT 5 de cada mensaje: `channel_messages.properties`.
 *
 * Una columna `jsonb` nulable y no cuatro: son propiedades de usuario (una lista, con nombres que
 * se repiten), el tipo de contenido y el tema y los datos de correlación de una petición-respuesta,
 * y solo las trae un mensaje MQTT 5 que las lleve. Un WebSocket, un gRPC o un MQTT 3.1.1 la dejan
 * nula, así que las filas de antes no cambian. Se guardan **ya tapadas**, como el cuerpo y el tema.
 *
 * Los eventos de la sesión (suscribirse a mitad, lo que contestó el broker) no necesitan columna:
 * son `direction = 'event'`, que cabe en el `varchar(10)` de siempre.
 */
export class ChannelMessageProperties1700000034000 implements MigrationInterface {
  name = "ChannelMessageProperties1700000034000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_messages" ADD COLUMN "properties" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Un evento sin la columna sigue siendo una fila legible; lo que se pierde son las propiedades.
    await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "properties"`);
  }
}
