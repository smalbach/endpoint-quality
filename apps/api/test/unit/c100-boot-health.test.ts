/**
 * La sonda dice «down» cuando la base no contesta, y lo dice con el motivo.
 *
 * El arranque de `test/db/c100-boot-app.test.ts` la prueba contra una base viva; aquí va la otra
 * mitad, que es la que importa: una sonda que solo sabe decir «ok» es el `pass: true` a mano que
 * este producto existe para cazar.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DataSource } from "typeorm";

import { HealthController } from "@/shared/health.controller";

const dataSourceThat = (query: () => Promise<unknown>) => ({ query }) as unknown as DataSource;

describe("la sonda de salud", () => {
  test("con la base contestando dice «ok» y el tiempo que tardó", async () => {
    const asked: string[] = [];
    const controller = new HealthController(
      dataSourceThat(async () => {
        asked.push("SELECT 1");
        return [{ "?column?": 1 }];
      }),
    );

    const answer = await controller.check();

    assert.deepEqual(asked, ["SELECT 1"]);
    assert.equal(answer.status, "ok");
    assert.equal(answer.checks.database.status, "up");
    assert.ok(typeof answer.checks.database.latencyMs === "number" && answer.checks.database.latencyMs >= 0);
    assert.equal(answer.checks.database.error, undefined);
  });

  test("si la consulta falla dice «down» con el mensaje del fallo, y no se mide tiempo", async () => {
    const controller = new HealthController(
      dataSourceThat(async () => {
        throw new Error("la conexión se cerró");
      }),
    );

    const answer = await controller.check();

    assert.equal(answer.status, "down");
    assert.deepEqual(answer.checks.database, { status: "down", error: "la conexión se cerró" });
  });

  test("si lo que falla no es un Error, el motivo se dice igual", async () => {
    const controller = new HealthController(dataSourceThat(async () => Promise.reject("ECONNREFUSED")));

    const answer = await controller.check();

    assert.equal(answer.status, "down");
    assert.deepEqual(answer.checks.database, { status: "down", error: "sin detalle" });
  });
});
