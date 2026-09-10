/**
 * Runs the pending migrations and exits. The schema step of a deployment, as a compiled entry
 * point rather than a developer command.
 *
 * `pnpm migration:run` drives TypeORM's CLI over the TypeScript sources, which is right on a
 * laptop and impossible in the runtime image: it has no sources, no compiler and no dev
 * dependencies. So the image would boot an API against an empty schema and fail on the first
 * query — with `docker compose up` advertised as the way to run this.
 *
 * **Not `migrationsRun: true` at boot.** That couples "the schema changed" to "a process
 * started": every replica of a rolling deploy would try, the API would serve requests while DDL
 * was still running, and a migration that fails would look like a crash loop instead of a failed
 * migration. Here it is its own step with its own exit code, which is what a compose dependency
 * and a Kubernetes init container both want.
 *
 *     node apps/api/dist/migrate.js
 */
import "reflect-metadata";
import { DataSource } from "typeorm";

import { buildDataSourceOptions } from "./shared/database/data-source";

/**
 * A Postgres advisory lock around the whole thing.
 *
 * Two migrators can genuinely start at once — two replicas' init containers, a compose `up` while
 * a deploy is running — and TypeORM's own guard is the `migrations` table, which is read before
 * it is written. The window between the two is small and it is real: both see "0002 is pending",
 * both run it, and the second one fails on an object that already exists. Session-scoped so it is
 * released even if the process is killed, since the connection dies with it.
 *
 * The number is arbitrary but fixed: any two migrators must pick the same one.
 */
const LOCK_ID = 8_531_204;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Falta DATABASE_URL");

  const dataSource = new DataSource(buildDataSourceOptions(databaseUrl));
  await dataSource.initialize();
  try {
    // Blocking, not `try_advisory_lock`: the other migrator is doing the work this one wanted
    // done, and waiting for it is the correct outcome. Giving up would start the API against a
    // half-migrated schema.
    await dataSource.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    try {
      const applied = await dataSource.runMigrations({ transaction: "each" });
      console.log(applied.length ? `migraciones aplicadas: ${applied.map((migration) => migration.name).join(", ")}` : "sin migraciones pendientes");
    } finally {
      await dataSource.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  // The message, not the stack: this runs as a container's only output and "QueryFailedError:
  // relation already exists" is the line somebody needs to read.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
