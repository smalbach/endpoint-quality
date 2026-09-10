/**
 * The TypeORM data source, used by the CLI for migrations and by the module at boot.
 *
 * `synchronize` is false and stays false, in every environment. Inferring the schema from
 * entities is convenient exactly until two environments disagree about what was inferred.
 */
import { DataSource } from "typeorm";
import { ENTITIES } from "./entities";
import { InitialSchema1700000000000 } from "./migrations/1700000000000-InitialSchema";
import { ProjectsAndSpecs1700000001000 } from "./migrations/1700000001000-ProjectsAndSpecs";

// Ordered. TypeORM runs them by the timestamp in the class name, and the second one adds a
// foreign key into a table the first creates.
export const MIGRATIONS = [InitialSchema1700000000000, ProjectsAndSpecs1700000001000];

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
