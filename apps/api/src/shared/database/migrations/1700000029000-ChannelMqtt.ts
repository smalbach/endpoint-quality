import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * MQTT como protocolo de canal.
 *
 * `1700000028000-Channels` ya dejó `protocol` en la tabla pensando en esto, y la decisión de fondo
 * se mantiene: un canal MQTT es una fila más de `channel_endpoints`, no una tabla aparte. Lo que
 * hace falta añadir es poco y todo nulable, así que las filas de WebSocket no cambian:
 *
 * - `channel_endpoints.mqtt`: versión, id de cliente, keepalive, sesión limpia y suscripciones.
 *   Una columna `jsonb` propia y no dentro de otra que ya existe, porque son ajustes que solo
 *   significan algo en MQTT, y colarlos en `subprotocols` o en `expectations` obligaría a quien lee
 *   esas columnas a saber de MQTT. **Sin credenciales**: usuario y contraseña van en `auth` como
 *   `basic`, por la misma puerta que ya vacía los secretos literales.
 * - `channel_messages.topic`, `qos` y `retain`: por dónde viajó cada mensaje. Columnas y no parte
 *   del cuerpo, porque una comprobación sobre el cuerpo no puede tropezar con el tema, y la pantalla
 *   los enseña aparte. El tema se guarda ya tapado, como el cuerpo.
 */
export class ChannelMqtt1700000029000 implements MigrationInterface {
  name = "ChannelMqtt1700000029000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "channel_endpoints" ADD COLUMN "mqtt" jsonb`);
    await queryRunner.query(`ALTER TABLE "channel_messages" ADD COLUMN "topic" text`);
    await queryRunner.query(`ALTER TABLE "channel_messages" ADD COLUMN "qos" smallint`);
    await queryRunner.query(`ALTER TABLE "channel_messages" ADD COLUMN "retain" boolean`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Un canal MQTT no se puede usar sin sus ajustes: se va con la columna, y sus sesiones con él.
    await queryRunner.query(`DELETE FROM "channel_endpoints" WHERE "protocol" = 'mqtt'`);
    await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "retain"`);
    await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "qos"`);
    await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "topic"`);
    await queryRunner.query(`ALTER TABLE "channel_endpoints" DROP COLUMN "mqtt"`);
  }
}
