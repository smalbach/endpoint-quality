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
import { RequestBodyTypes1700000012000 } from "./migrations/1700000012000-RequestBodyTypes";
import { ProjectSettingsAndAccountRecovery1700000013000 } from "./migrations/1700000013000-ProjectSettingsAndAccountRecovery";
import { Endpoints1700000014000 } from "./migrations/1700000014000-Endpoints";
import { ActiveEnvironmentAndSessionTokens1700000015000 } from "./migrations/1700000015000-ActiveEnvironmentAndSessionTokens";
import { Roles1700000016000 } from "./migrations/1700000016000-Roles";
import { SecurityRuns1700000017000 } from "./migrations/1700000017000-SecurityRuns";
import { WorkflowStatus1700000018000 } from "./migrations/1700000018000-WorkflowStatus";
import { Performance1700000019000 } from "./migrations/1700000019000-Performance";
import { CodeScan1700000020000 } from "./migrations/1700000020000-CodeScan";
import { RequestAuth1700000021000 } from "./migrations/1700000021000-RequestAuth";
import { CookieJar1700000022000 } from "./migrations/1700000022000-CookieJar";
import { EndpointExamples1700000023000 } from "./migrations/1700000023000-EndpointExamples";
import { MockServers1700000024000 } from "./migrations/1700000024000-MockServers";
import { DocSites1700000025000 } from "./migrations/1700000025000-DocSites";
import { Monitors1700000026000 } from "./migrations/1700000026000-Monitors";
import { MockCalls1700000027000 } from "./migrations/1700000027000-MockCalls";
import { Channels1700000028000 } from "./migrations/1700000028000-Channels";
import { ChannelGrpc1700000030000 } from "./migrations/1700000030000-ChannelGrpc";

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
  RequestBodyTypes1700000012000,
  ProjectSettingsAndAccountRecovery1700000013000,
  Endpoints1700000014000,
  ActiveEnvironmentAndSessionTokens1700000015000,
  Roles1700000016000,
  SecurityRuns1700000017000,
  WorkflowStatus1700000018000,
  Performance1700000019000,
  CodeScan1700000020000,
  RequestAuth1700000021000,
  CookieJar1700000022000,
  EndpointExamples1700000023000,
  MockServers1700000024000,
  DocSites1700000025000,
  Monitors1700000026000,
  MockCalls1700000027000,
  Channels1700000028000,
  ChannelGrpc1700000030000,
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
