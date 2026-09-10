/**
 * The TypeORM data source, used by the CLI for migrations and by the module at boot.
 *
 * `synchronize` is false and stays false, in every environment. Inferring the schema from
 * entities is convenient exactly until two environments disagree about what was inferred.
 */
import { DataSource } from "typeorm";
import { ENTITIES } from "./entities";
import { InitialSchema1700000000000 } from "./migrations/1700000000000-InitialSchema";

export const MIGRATIONS = [InitialSchema1700000000000];

export function buildDataSourceOptions(databaseUrl: string) {
  return {
    type: "postgres" as const,
    url: databaseUrl,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
    logging: process.env.TYPEORM_LOGGING === "true",
  };
}

export default new DataSource(buildDataSourceOptions(process.env.DATABASE_URL ?? "postgres://eq:eq@localhost:5432/endpoint_quality"));
