import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * La fila de turnos de las corridas que van de una en una en todo el despliegue: las de seguridad y
 * las de rendimiento (ver `shared/turns/execution-turns.ts`).
 *
 * Una tabla propia y no columnas en `security_runs` y `performance_runs`: lo que se ordena y se
 * bloquea es la fila de espera de todas las instancias, que no es un dato de la corrida y dura lo que
 * dura la espera. Al terminar, la fila se borra; lo que queda de la corrida está en su tabla.
 *
 * - `seq` es el orden de llegada, de la base y no de un reloj: dos instancias que encolan en el
 *   mismo milisegundo tienen igualmente un orden.
 * - `holder` es la instancia (`InstanceBusPort.instanceId`); `heartbeatAt`, su último latido. Una
 *   fila sin latir más de lo acordado es de una instancia muerta, y quien pide turno la borra.
 * - Sin clave ajena a las corridas: son dos tablas, y una fila huérfana caduca sola por el latido.
 */
export class ExecutionTurns1700000041000 implements MigrationInterface {
  name = "ExecutionTurns1700000041000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "execution_turns" (
        "runId" uuid PRIMARY KEY,
        "kind" varchar(16) NOT NULL,
        "seq" bigserial NOT NULL,
        "holder" varchar(200) NOT NULL,
        "startedAt" timestamptz,
        "heartbeatAt" timestamptz NOT NULL
      )
    `);
    // Lo que pregunta cada intento de empezar: los de su tipo, por orden.
    await queryRunner.query(`CREATE INDEX "IDX_execution_turns_kind_seq" ON "execution_turns" ("kind", "seq")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "execution_turns"`);
  }
}
