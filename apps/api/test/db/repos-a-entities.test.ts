/**
 * The entities against the schema the migrations build.
 *
 * The migrations are the source of truth and the entities are a second description of the same
 * tables that nothing compares automatically: an entity column the migrations never created is a
 * query that fails the first time somebody touches that screen. TypeORM's schema builder can say
 * what `synchronize` *would* change; here that diff is asked for (never run) and every statement in
 * it must be one of the differences that are there by design:
 *
 * - foreign keys and indexes, which the migrations declare and the entities deliberately do not;
 * - column defaults, whose jsonb literals TypeORM cannot compare with what Postgres stores.
 *
 * Anything else — a table or column added or dropped, a type or a nullability that differs — is
 * real drift between the two descriptions.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";

describe("entities agree with the migrated schema", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  test("synchronize would change no table, column, type or nullability", async () => {
    const log = await db.dataSource.driver.createSchemaBuilder().log();
    const drift = log.upQueries
      .map((query) => query.query)
      .filter((sql) => !/\b(CONSTRAINT|INDEX)\b|\b(SET|DROP) DEFAULT\b/.test(sql));
    assert.deepEqual(drift, []);
  });

  test("every entity maps to a table the migrations created", async () => {
    const tables = new Set(
      ((await db.dataSource.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [db.schema],
      )) as { table_name: string }[]).map((row) => row.table_name),
    );
    const missing = db.dataSource.entityMetadatas.map((meta) => meta.tableName).filter((name) => !tables.has(name));
    assert.deepEqual(missing, []);
  });
});
