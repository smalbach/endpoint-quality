/**
 * A private Postgres schema per test file, with every migration applied into it.
 *
 * `schema.test.ts` walks migrations backwards and forwards in `public`, and other runs of the
 * suite may share the same database. A repository test that wrote into `public` would race
 * both. Here each file gets `eq_t_<random>` as its `search_path`, so the migrations — which
 * never name a schema — create every table, type and the `migrations` ledger inside it, and
 * the whole thing is dropped at the end.
 *
 * Skips (with a reason) when `EQ_TEST_DATABASE_URL` is unset, like the schema suite.
 */
import { randomBytes } from "node:crypto";
import { DataSource } from "typeorm";

import { buildDataSourceOptions } from "@/shared/database/data-source";

export const DATABASE_URL = process.env.EQ_TEST_DATABASE_URL;
export const SKIP_REASON =
  "sin EQ_TEST_DATABASE_URL: levanta Postgres (docker compose -f docker/compose.yml up -d postgres) y reexporta la variable";
export const dbSkip = DATABASE_URL ? false : SKIP_REASON;

export interface IsolatedDb {
  dataSource: DataSource;
  schema: string;
  drop(): Promise<void>;
}

export async function openIsolatedDb(): Promise<IsolatedDb> {
  if (!DATABASE_URL) throw new Error(SKIP_REASON);
  const schema = `eq_t_${randomBytes(6).toString("hex")}`;

  const admin = new DataSource({ type: "postgres", url: DATABASE_URL });
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);

  const dataSource = new DataSource({
    ...buildDataSourceOptions(DATABASE_URL),
    schema,
    extra: { options: `-c search_path=${schema}` },
  });
  await dataSource.initialize();
  await dataSource.runMigrations();

  return {
    dataSource,
    schema,
    async drop() {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    },
  };
}
