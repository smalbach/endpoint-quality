import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { FlowHookEntity } from "@/shared/database/entities";
import type {
  FlowHook,
  FlowHookDelivery,
  FlowHookMethod,
  FlowHookRepositoryPort,
  FlowHookStatus,
} from "../../domain/flow-hooks";

/**
 * Las esperas de los nodos webhook, en Postgres.
 *
 * Las dos escrituras que no se pueden separar son una sentencia cada una. `deliver` es un `UPDATE`
 * condicionado a `status = 'open'` y a la caducidad: Postgres bloquea la fila, así que de dos
 * llamadas a la misma URL solo una ve `open`. `settle` lee y cierra bajo el mismo bloqueo (`FOR
 * UPDATE` en la subconsulta), así que o encuentra la entrega ya escrita o deja la fila cerrada antes
 * de que la llamada pueda entrar.
 */
@Injectable()
export class TypeOrmFlowHookRepository implements FlowHookRepositoryPort {
  constructor(@InjectRepository(FlowHookEntity) private readonly hooks: Repository<FlowHookEntity>) {}

  async open(hook: FlowHook): Promise<void> {
    await this.hooks.save(hook as unknown as FlowHookEntity);
  }

  async deliver(
    tokenHash: string,
    method: FlowHookMethod,
    delivery: FlowHookDelivery,
    now: Date,
  ): Promise<FlowHook | null> {
    const [rows] = (await this.hooks.query(
      `UPDATE "flow_hooks" SET "status" = 'delivered', "delivery" = $3
        WHERE "tokenHash" = $1 AND "method" = $2 AND "status" = 'open' AND "expiresAt" > $4
        RETURNING *`,
      [tokenHash, method, JSON.stringify(delivery), now],
    )) as [FlowHookEntity[], number];
    return rows?.[0] ? toHook(rows[0]) : null;
  }

  async find(id: string): Promise<FlowHook | null> {
    const row = await this.hooks.findOne({ where: { id } });
    return row ? toHook(row) : null;
  }

  async settle(id: string): Promise<FlowHookDelivery | null> {
    const [rows] = (await this.hooks.query(
      `UPDATE "flow_hooks" h
          SET "status" = CASE WHEN previous."status" = 'open' THEN 'closed' ELSE 'settled' END,
              "delivery" = NULL
         FROM (SELECT "id", "status", "delivery" FROM "flow_hooks" WHERE "id" = $1 FOR UPDATE) previous
        WHERE h."id" = previous."id"
        RETURNING previous."status" AS "status", previous."delivery" AS "delivery"`,
      [id],
    )) as [{ status: string; delivery: FlowHookDelivery | null }[], number];
    const row = rows?.[0];
    return row?.status === "delivered" ? row.delivery : null;
  }

  async openForRun(runId: string, now: Date): Promise<FlowHook[]> {
    const rows = await this.hooks
      .createQueryBuilder("h")
      .where(`h."runId" = :runId`, { runId })
      .andWhere(`h."status" = 'open'`)
      .andWhere(`h."expiresAt" > :now`, { now })
      .orderBy(`h."createdAt"`, "ASC")
      .getMany();
    return rows.map(toHook);
  }
}

function toHook(row: FlowHookEntity): FlowHook {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    runId: row.runId,
    caseId: row.caseId,
    stepId: row.stepId,
    method: row.method as FlowHookMethod,
    status: row.status as FlowHookStatus,
    // Un `RETURNING *` en crudo trae la fecha tal como la da el driver, que ya es un `Date`; y la
    // entrega como el `jsonb` parseado.
    expiresAt: new Date(row.expiresAt),
    delivery: (row.delivery as FlowHookDelivery | null) ?? null,
    createdAt: new Date(row.createdAt),
  };
}
