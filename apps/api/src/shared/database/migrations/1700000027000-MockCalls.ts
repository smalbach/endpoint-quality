import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * La bitácora de un servidor de mocks: una fila por petición que su URL contestó.
 *
 * ## Las columnas que **no** están son la decisión de esta tabla
 *
 * No hay `headers`, no hay `body` y no hay `query`. La petición que llega a un mock es de un tercero
 * —el front de alguien apuntado a esta URL— y lleva dentro sus credenciales: el `Bearer` de un
 * usuario real, la contraseña del login que se está probando, un `?api_key=` de los de siempre.
 * Guardarlas convertiría esta tabla en un almacén de credenciales ajenas alimentado por una ruta
 * `@Public()` que cualquiera puede llamar. Tampoco hay IP ni agente: no arreglan nada de lo que esta
 * pantalla arregla. Lo que queda es lo que hace útil la pantalla, y ni una columna más.
 *
 * ## Por qué el índice es `(mockServerId, "at" DESC)`
 *
 * Porque es literalmente la única consulta: las últimas N de **este** mock, de la más reciente a la
 * más vieja. Y es la misma que usa el recorte de retención, que se salta las N primeras y borra el
 * resto — sin el `DESC` ese recorte sería un recorrido de la tabla en cada petición servida.
 *
 * `ON DELETE CASCADE` sobre `mock_servers`: la bitácora de un mock que ya no existe no es un
 * historial, es basura con datos de tráfico dentro. Y como el mock ya cae con su proyecto, esta
 * tabla no necesita su propio `projectId`: se llega al proyecto por el mock, que es también el único
 * camino por el que se puede preguntar por ella.
 *
 * `exampleId` es una referencia suelta y **sin clave ajena**, como el `runId` de `monitor_executions`
 * y por lo mismo: el ejemplo se puede borrar y la fila que dice qué se sirvió aquel día se queda.
 */
export class MockCalls1700000027000 implements MigrationInterface {
  name = "MockCalls1700000027000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mock_calls" (
        "id" uuid PRIMARY KEY,
        "mockServerId" uuid NOT NULL REFERENCES "mock_servers"("id") ON DELETE CASCADE,
        "at" timestamptz NOT NULL,
        "method" varchar(16) NOT NULL,
        "path" varchar(300) NOT NULL,
        "status" int NOT NULL,
        "exampleId" uuid,
        "exampleName" varchar(120) NOT NULL DEFAULT '',
        "missCode" varchar(40) NOT NULL DEFAULT '',
        "durationMs" int NOT NULL DEFAULT 0
      )
    `);
    // La lista de la pantalla y el recorte de retención, que son la misma consulta al revés.
    await queryRunner.query(`CREATE INDEX "IDX_mock_calls_server" ON "mock_calls" ("mockServerId", "at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mock_calls"`);
  }
}
