import type { CoverageGap, CoverageView } from "@eq/contracts";

/**
 * How much of the contract the matrix actually reaches, and which responses it does not.
 *
 * The coupled dashboard's README carried this as a hand-maintained table — 196 declared responses,
 * 195 with a case, the one gap being `/health`'s 503, which needs a dependency to be down. That
 * number was true when somebody counted it and had no way of staying true afterwards: adding an
 * operation to the contract moved it and nothing said so.
 *
 * The measure is deliberately blunt: **a declared response is covered when at least one generated
 * case expects that status on that operation.** It says the case exists, not that it is a good
 * one; a matrix that reaches every status can still assert nothing worth asserting, which is what
 * the schema and envelope assertions are for. What it does catch is the failure that hides: a
 * contract declares a 409 nobody ever provokes, and the run comes back green having never tried.
 *
 * Computed from the same rows and the same engine as `GET /scenarios`, so the two cannot disagree
 * about what the matrix contains.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import { type Operation, resolveOperations, scenariosFor } from "@eq/runner-core";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "../../domain/ports";
import { assembleProjectConfig } from "./get-project-config";

export class GetCoverageQuery implements IQuery {
  constructor(readonly organizationId: string, readonly projectId: string) {}
}

/** Every declared response with no case, named: a total without the list is a number to feel
 * good about. Defined in `@eq/contracts`, where the browser reads the same one. */
export type { CoverageGap, CoverageView };
export type CoverageByStatus = CoverageView["byStatus"][number];

@QueryHandler(GetCoverageQuery)
export class GetCoverageHandler implements IQueryHandler<GetCoverageQuery, CoverageView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
  ) {}

  async execute(query: GetCoverageQuery): Promise<CoverageView> {
    const project = await this.projects.findById(query.projectId);
    if (!project || project.organizationId !== query.organizationId) throw new NotFoundError("El proyecto no existe", "project-not-found");
    if (!project.activeSpecVersionId) throw new ConflictError("El proyecto todavía no tiene contrato importado", "no-active-spec");
    const version = await this.specs.findVersionById(project.activeSpecVersionId);
    if (!version) throw new NotFoundError("La versión activa no existe", "spec-version-not-found");

    const projectConfig = await assembleProjectConfig(this.config, project.id);
    const stored = await this.specs.listOperations(version.id);
    const operations: Operation[] = stored.map(({ rowId, specVersionId, position, derivedId, security, ...operation }) => operation);
    const resolved = resolveOperations(operations, projectConfig);

    // Measured **without an environment**, and always with the authorization cases in. Coverage is
    // a property of the contract and the configuration, not of tonight's target: a read-only
    // environment blocks the writes it would run, and reporting that as missing coverage would
    // say the contract is untested when what happened is that somebody picked a safe target.
    const declared: CoverageGap[] = [];
    const covered = new Set<string>();
    let cases = 0;

    for (const operation of resolved) {
      const expected = new Set(scenariosFor(operation, projectConfig).map((scenario) => scenario.expectedStatus));
      cases += scenariosFor(operation, projectConfig).length;
      for (const status of operation.statuses) {
        declared.push({ operationId: operation.id, method: operation.method, path: operation.path, tag: operation.tag, status });
        if (expected.has(status)) covered.add(`${operation.id}:${status}`);
      }
    }

    const isCovered = (entry: CoverageGap) => covered.has(`${entry.operationId}:${entry.status}`);
    const statuses = [...new Set(declared.map((entry) => entry.status))].sort((a, b) => a - b);

    return {
      specVersionId: version.id,
      contractVersion: version.contractVersion,
      totals: {
        operations: resolved.length,
        declaredResponses: declared.length,
        covered: declared.filter(isCovered).length,
        uncovered: declared.filter((entry) => !isCovered(entry)).length,
        cases,
      },
      byStatus: statuses.map((status) => ({
        status,
        declared: declared.filter((entry) => entry.status === status).length,
        covered: declared.filter((entry) => entry.status === status && isCovered(entry)).length,
      })),
      gaps: declared.filter((entry) => !isCovered(entry)),
    };
  }
}
