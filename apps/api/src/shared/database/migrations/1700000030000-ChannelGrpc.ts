import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * gRPC como protocolo de un canal.
 *
 * `protocol` ya nació con la tabla para esto: un canal gRPC es una fila más de `channel_endpoints`,
 * con sus sesiones y sus mensajes en las mismas tablas —una llamada con streams es una conversación—.
 * Lo que falta es lo que solo tiene gRPC:
 *
 * - `grpc`, una columna `jsonb` y no cuatro: servicio, método, mensaje y plazo solo existen juntos y
 *   solo en un protocolo, y cuatro columnas nulas en cada WebSocket no dicen nada.
 * - `channel_proto_files`, los `.proto` del canal, **aparte** de la fila. Se leen al invocar y al
 *   elegir el método, no al listar canales: en la fila, cada lista de canales cargaría el MB de
 *   definiciones de cada uno. Se guardan —y no se piden cada vez— porque una corrida o un monitor no
 *   tienen a nadie que los vuelva a subir.
 *
 * El estado y los trailers de una llamada no necesitan columna: el estado es `closeCode` —el número
 * con el que terminó la conversación— y los trailers van con los contadores, en el `jsonb` donde ya
 * están `closeReason` y las marcas de tiempo.
 */
export class ChannelGrpc1700000030000 implements MigrationInterface {
  name = "ChannelGrpc1700000030000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_endpoints" ADD "grpc" jsonb`);
    await queryRunner.query(`
      CREATE TABLE "channel_proto_files" (
        "channelId" uuid NOT NULL REFERENCES "channel_endpoints"("id") ON DELETE CASCADE,
        "path" varchar(300) NOT NULL,
        "content" text NOT NULL,
        "bytes" int NOT NULL,
        PRIMARY KEY ("channelId", "path")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "channel_proto_files"`);
    await queryRunner.query(`ALTER TABLE "channel_endpoints" DROP COLUMN "grpc"`);
  }
}
