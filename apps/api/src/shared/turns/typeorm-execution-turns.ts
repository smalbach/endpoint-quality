import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

import type { ExecutionTurnStorePort, TurnKind } from "./execution-turns";

/**
 * La fila de turnos en Postgres (`execution_turns`, ver `ExecutionTurns1700000041000`).
 *
 * **Las horas son las de la base** (`now()`), no las de cada instancia: con dos relojes que no
 * coinciden, una instancia adelantada daría por muertas las filas de las demás. Así, «sin latir
 * desde hace `staleMs`» se mide siempre con el mismo reloj.
 *
 * **Empezar va bajo `pg_advisory_xact_lock`, uno por tipo.** El `UPDATE` condicionado solo no basta:
 * dos instancias que intentan empezar dos corridas distintas actualizan dos filas distintas, y con
 * `READ COMMITTED` cada una ve la fila de la otra aún sin empezar y ganan las dos. Con el candado
 * de la transacción, la segunda espera a que la primera confirme y entonces ve su `startedAt`. Es un
 * candado de transacción: se suelta solo al terminar, también si la conexión se cae.
 */
@Injectable()
export class TypeOrmExecutionTurnStore implements ExecutionTurnStorePort {
  constructor(private readonly dataSource: DataSource) {}

  async join(kind: TurnKind, runId: string, holder: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO execution_turns ("runId", kind, holder, "heartbeatAt") VALUES ($1, $2, $3, now())
       ON CONFLICT ("runId") DO NOTHING`,
      [runId, kind, holder],
    );
  }

  async tryStart(kind: TurnKind, runId: string, holder: string, staleMs: number): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`execution_turns:${kind}`]);
      await manager.query(
        `DELETE FROM execution_turns WHERE kind = $1 AND "heartbeatAt" < now() - make_interval(secs => $2::double precision / 1000)`,
        [kind, staleMs],
      );
      // `manager.query` de un UPDATE … RETURNING en Postgres devuelve [filas, cuántas].
      const [rows]: [unknown[], number] = await manager.query(
        `UPDATE execution_turns me SET "startedAt" = now(), "heartbeatAt" = now()
         WHERE me."runId" = $1 AND me.holder = $2 AND me.kind = $3 AND me."startedAt" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM execution_turns other
             WHERE other.kind = me.kind AND other."runId" <> me."runId"
               AND (other."startedAt" IS NOT NULL OR other.seq < me.seq)
           )
         RETURNING me."runId"`,
        [runId, holder, kind],
      );
      return rows.length > 0;
    });
  }

  async heartbeat(holder: string): Promise<string[]> {
    // Como en `tryStart`: un UPDATE … RETURNING devuelve [filas, cuántas].
    const [rows]: [{ runId: string }[], number] = await this.dataSource.query(
      `UPDATE execution_turns SET "heartbeatAt" = now() WHERE holder = $1 RETURNING "runId"`,
      [holder],
    );
    return rows.map((row) => row.runId);
  }

  async leave(runId: string, holder: string): Promise<void> {
    await this.dataSource.query(`DELETE FROM execution_turns WHERE "runId" = $1 AND holder = $2`, [runId, holder]);
  }
}
