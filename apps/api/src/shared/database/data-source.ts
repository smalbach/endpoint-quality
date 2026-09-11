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
import { EnvironmentsAndConfig1700000002000 } from "./migrations/1700000002000-EnvironmentsAndConfig";
import { Runs1700000003000 } from "./migrations/1700000003000-Runs";
import { Retention1700000005000 } from "./migrations/1700000005000-Retention";
import { RequestSchemas1700000004000 } from "./migrations/1700000004000-RequestSchemas";
import { WorkflowsAndTemplates1700000006000 } from "./migrations/1700000006000-WorkflowsAndTemplates";
import { DisabledEnvironmentVariables1700000007000 } from "./migrations/1700000007000-DisabledEnvironmentVariables";
import { SensitiveEnvironmentVariables1700000008000 } from "./migrations/1700000008000-SensitiveEnvironmentVariables";
import { DatasetsAndSuites1700000009000 } from "./migrations/1700000009000-DatasetsAndSuites";
import { CaseFailureKind1700000010000 } from "./migrations/1700000010000-CaseFailureKind";
import { RequestTemplateHeaders1700000011000 } from "./migrations/1700000011000-RequestTemplateHeaders";

// Ordered. TypeORM runs them by the timestamp in the class name, and the second one adds a
// foreign key into a table the first creates.
export const MIGRATIONS = [
  InitialSchema1700000000000,
  ProjectsAndSpecs1700000001000,
  EnvironmentsAndConfig1700000002000,
  Runs1700000003000,
  RequestSchemas1700000004000,
  Retention1700000005000,
  WorkflowsAndTemplates1700000006000,
  DisabledEnvironmentVariables1700000007000,
  SensitiveEnvironmentVariables1700000008000,
  DatasetsAndSuites1700000009000,
  CaseFailureKind1700000010000,
  RequestTemplateHeaders1700000011000,
];

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

export default new DataSource(
  buildDataSourceOptions(process.env.DATABASE_URL ?? "postgres://eq:eq@localhost:5432/endpoint_quality"),
);
