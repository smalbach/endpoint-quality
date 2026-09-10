import type { OperationScenarios as WireOperationScenarios, ScenariosView as WireScenariosView } from "@eq/contracts";

import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import {
  budgetFor,
  buildQueue,
  requestPathFor,
  resolveOperations,
  runnableScenarios,
  scenariosFor,
  type Operation,
  type OrderMode,
  type ProjectConfig,
  type ResolvedOperation,
  type TestScenario,
} from "@eq/runner-core";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "../../domain/ports";
import { assembleProjectConfig } from "./get-project-config";

export class GetScenariosQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Which environment the matrix is built for. It decides whether the authorization cases are
     * included and which operations are allowed to run at all. */
    readonly environmentId?: string,
    readonly order: OrderMode = "safe",
  ) {}
}

export type ScenarioView = TestScenario & {
  /** The path this case would request, resolved. The latency budget of a GET can depend on the
   * query string, so it is an input to the assertion rather than a display detail. */
  requestPath: string;
  budget: { ms: number; label: string; source: string } | null;
  /** False when the environment forbids writes and this case is not idempotent. The case is
   * still listed — hiding it would make the matrix look smaller than the contract — and is
   * marked as something this environment will not run. */
  runnable: boolean;
  blockedReason?: string;
};

export type OperationScenarios = WireOperationScenarios & { scenarios: ScenarioView[] };

/** The flat execution queue is built here and not in the browser, so the preview and the run
 * agree by construction. The shape is declared once, in `@eq/contracts`. */
export type ScenariosView = WireScenariosView & { operations: OperationScenarios[] };

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The matrix a project would run, assembled from rows.
 *
 * This is where the decoupling becomes visible: the operations come from an imported contract,
 * the fixtures and budgets from a project's configuration, the authorization switch from an
 * environment — and `@eq/runner-core`, which knows about none of them, turns the three into
 * cases. The coupled dashboard produced the same list from five modules of literals.
 *
 * A query and not a command: it changes nothing, and the front end calls it on every filter
 * change to preview what a run would do.
 */
@QueryHandler(GetScenariosQuery)
export class GetScenariosHandler implements IQueryHandler<GetScenariosQuery, ScenariosView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
  ) {}

  async execute(query: GetScenariosQuery): Promise<ScenariosView> {
    const project = await this.projects.findById(query.projectId);
    if (!project || project.organizationId !== query.organizationId) throw new NotFoundError("El proyecto no existe", "project-not-found");
    if (!project.activeSpecVersionId) throw new ConflictError("El proyecto todavía no tiene contrato importado", "no-active-spec");

    const version = await this.specs.findVersionById(project.activeSpecVersionId);
    if (!version) throw new NotFoundError("La versión activa no existe", "spec-version-not-found");

    const environment = query.environmentId ? await this.environments.findById(query.environmentId) : null;
    if (query.environmentId && (!environment || environment.projectId !== project.id)) {
      throw new NotFoundError("El entorno no existe", "environment-not-found");
    }

    const projectConfig = await assembleProjectConfig(this.config, project.id);
    const stored = await this.specs.listOperations(version.id);
    // The row key is dropped here: the engine keys everything by `operationId`, which is the
    // contract's own name and survives a re-import. Handing it `rowId` would tie every piece of
    // configuration to one snapshot.
    const operations: Operation[] = stored.map(({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation);
    const resolved = resolveOperations(operations, projectConfig);

    // Without an environment the matrix shows what the contract declares, authorization cases
    // included. That is the honest answer to "what could be tested", as opposed to "what will
    // run tonight" — which is the question an environment answers.
    const authEnabled = environment ? environment.authEnforced : true;
    const writesAllowed = environment ? environment.writesAllowed : true;

    const operationViews = resolved.map((operation) => ({
      id: operation.id,
      method: operation.method,
      path: operation.path,
      tag: operation.tag,
      summary: operation.summary,
      implemented: operation.implemented,
      responseShape: operation.responseShape,
      scenarios: scenariosFor(operation, projectConfig).map((scenario) => this.describe(operation, scenario, projectConfig, authEnabled, writesAllowed)),
    }));

    const queue = buildQueue(resolved, projectConfig, { mode: query.order, authEnabled }).map((item) => ({
      operationId: item.operation.id,
      scenarioId: item.scenario.id,
    }));

    const cases = operationViews.reduce((sum, operation) => sum + operation.scenarios.length, 0);
    const runnable = operationViews.reduce((sum, operation) => sum + operation.scenarios.filter((scenario) => scenario.runnable).length, 0);

    return {
      specVersionId: version.id,
      contractVersion: version.contractVersion,
      environment: environment
        ? { id: environment.id, name: environment.name, baseUrl: environment.baseUrl, writesAllowed: environment.writesAllowed, authEnforced: environment.authEnforced }
        : null,
      operations: operationViews,
      queue,
      totals: { operations: operationViews.length, cases, runnable, blocked: cases - runnable },
    };
  }

  private describe(
    operation: ResolvedOperation,
    scenario: TestScenario,
    config: ProjectConfig,
    authEnabled: boolean,
    writesAllowed: boolean,
  ): ScenarioView {
    const requestPath = requestPathFor(operation, config, scenario.parameters);
    const runnableHere = runnableScenarios(operation, config, authEnabled).some((candidate) => candidate.id === scenario.id);

    // Two different reasons a case will not run tonight, kept apart because the fix is
    // different: one needs a backend started with authorization, the other needs somebody to
    // decide this target may be written to.
    const blockedReason = !runnableHere
      ? "El entorno no aplica autorización: los casos 401 y 403 fallarían por un motivo ajeno al endpoint"
      : !writesAllowed && !IDEMPOTENT.has(operation.method)
        ? "El entorno no permite escrituras"
        : undefined;

    return {
      ...scenario,
      requestPath,
      budget: budgetFor(config, operation.method, operation.path, requestPath),
      runnable: blockedReason === undefined,
      ...(blockedReason ? { blockedReason } : {}),
    };
  }
}
