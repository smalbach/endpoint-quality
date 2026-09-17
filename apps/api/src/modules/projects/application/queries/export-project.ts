import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";
import type { ProjectBundlePart } from "@eq/contracts";

import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import {
  PERFORMANCE_PLAN_REPOSITORY,
  type PerformancePlanRepositoryPort,
} from "@/modules/performance/domain/ports";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import {
  BUNDLE_FORMAT,
  BUNDLE_PARTS,
  BUNDLE_VERSION,
  isBundlePart,
  withSubflows,
  type FlowDefinition,
  type ProjectBundle,
} from "../../domain/project-bundle";
import { ownedProject } from "../commands/update-project";
import { withoutSecrets } from "../commands/copy-from-project";

export class ExportProjectQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** Empty means every part. */
    readonly parts: string[],
    /** When set, only these flows (and the sub-flows they run) go into `flows`, without suites. */
    readonly workflowIds: string[],
  ) {}
}

/**
 * The project as a file. See `project-bundle.ts` for what goes in and, above all, what does not:
 * no credential, no project login secret, and sensitive variables as names with empty values.
 *
 * A read, so a GET — and one that anyone who can already read these pieces one screen at a time
 * could assemble by hand; the file only saves the clicking.
 */
@QueryHandler(ExportProjectQuery)
export class ExportProjectHandler implements IQueryHandler<ExportProjectQuery, ProjectBundle> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(query: ExportProjectQuery): Promise<ProjectBundle> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const unknown = query.parts.filter((part) => !isBundlePart(part));
    if (unknown.length) {
      throw new InvalidInputError(
        `No existe la parte ${unknown.join(", ")}`,
        unknown.map((part) => ({ field: "parts", detail: part })),
        "unknown-bundle-part",
      );
    }
    const parts = new Set<ProjectBundlePart>(query.parts.length ? (query.parts as ProjectBundlePart[]) : BUNDLE_PARTS);
    const bundle: ProjectBundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: this.clock.now().toISOString(),
      project: { name: project.name },
    };

    if (parts.has("settings")) {
      // The login settings stay out whole: half of them are secrets, and the other half without
      // those secrets is a login that looks configured and answers 401.
      bundle.settings = { description: project.description, baseUrl: project.baseUrl, tags: project.tags };
    }

    // The flows need it too: each saved request is exported with the method and path its operation had.
    const version =
      (parts.has("contract") || parts.has("flows")) && project.activeSpecVersionId
        ? await this.specs.findVersionById(project.activeSpecVersionId)
        : null;
    if (parts.has("contract") && version) {
      bundle.contract = {
        raw: version.raw,
        ...(version.title ? { title: version.title } : {}),
        ...(version.contractVersion ? { version: version.contractVersion } : {}),
      };
    }

    if (parts.has("config")) {
      bundle.config = (await this.config.listSections(project.id)).map((row) => ({
        section: row.section,
        data: row.data,
      }));
    }

    const endpoints = parts.has("endpoints") || parts.has("roles") ? await this.endpoints.listAll(project.id) : [];
    if (parts.has("endpoints")) {
      bundle.endpoints = endpoints.map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        description: endpoint.description,
        pathParameters: endpoint.pathParameters,
        query: endpoint.query,
        headers: endpoint.headers,
        body: endpoint.body,
        auth: endpoint.auth,
        requiresAuth: endpoint.requiresAuth,
        tags: endpoint.tags,
        status: endpoint.status,
        operationId: endpoint.operationId,
        preRequestScript: endpoint.preRequestScript,
        postResponseScript: endpoint.postResponseScript,
      }));
    }

    if (parts.has("roles")) {
      const [roles, permissions, rules] = await Promise.all([
        this.roles.list(project.id),
        this.roles.listPermissions(project.id),
        this.roles.listRules(project.id),
      ]);
      // By name and by method + path: those are what mean the same thing in another project.
      const roleNames = new Map(roles.map((role) => [role.id, role.name]));
      const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
      bundle.roles = [...roles]
        .sort((a, b) => a.position - b.position)
        .map((role) => ({
          name: role.name,
          description: role.description,
          color: role.color,
          sameRoleDataIsolation: role.sameRoleDataIsolation,
          permissions: permissions
            .filter((permission) => permission.roleId === role.id)
            .flatMap((permission) => {
              const endpoint = endpointById.get(permission.endpointId);
              return endpoint
                ? [{ method: endpoint.method, path: endpoint.path, access: permission.access, dataScope: permission.dataScope }]
                : [];
            }),
        }));
      bundle.roleRules = rules.flatMap((rule) => {
        const source = roleNames.get(rule.sourceRoleId);
        const target = roleNames.get(rule.targetRoleId);
        return source && target
          ? [{ source, target, canRead: rule.canRead, canWrite: rule.canWrite, canDelete: rule.canDelete }]
          : [];
      });
    }

    if (parts.has("flows")) bundle.flows = await this.flows(project.id, query.workflowIds, version?.id ?? null);

    if (parts.has("environments")) {
      bundle.environments = (await this.environments.listForProject(project.id)).map((environment) => ({
        name: environment.name,
        baseUrl: environment.baseUrl,
        specUrl: environment.specUrl,
        variables: withoutSecrets(environment.variables).variables,
        disabledVariables: withoutSecrets(environment.disabledVariables).variables,
      }));
    }

    if (parts.has("performance")) {
      bundle.performance = (await this.plans.list(project.id)).map((plan) => ({
        name: plan.name,
        description: plan.description,
        definition: plan.definition,
      }));
    }

    return bundle;
  }

  private async flows(
    projectId: string,
    workflowIds: string[],
    specVersionId: string | null,
  ): Promise<NonNullable<ProjectBundle["flows"]>> {
    const all = await this.workflows.listWorkflows(projectId);
    const known = new Set(all.map((workflow) => workflow.id));
    if (workflowIds.some((id) => !known.has(id))) throw new NotFoundError("El flujo no existe", "workflow-not-found");

    const partial = workflowIds.length > 0;
    const workflows = partial ? withSubflows(all, workflowIds) : all;
    const kept = new Set(workflows.map((workflow) => workflow.id));
    const used = new Set(workflows.flatMap((workflow) => workflow.definition.steps.map((step) => step.requestTemplateId)));
    const operations = new Map(
      (specVersionId ? await this.specs.listOperations(specVersionId) : []).map((operation) => [operation.id, operation]),
    );
    const [templates, datasets, suites] = await Promise.all([
      this.workflows.listTemplates(projectId),
      this.workflows.listDatasets(projectId),
      // A suite is a list of this project's flows; exporting one flow is not exporting that list.
      partial ? Promise.resolve([]) : this.workflows.listSuites(projectId),
    ]);

    return {
      requestTemplates: templates
        .filter((template) => !partial || used.has(template.id))
        .map((template) => ({
          id: template.id,
          name: template.name,
          operationId: template.operationId,
          ...(operations.has(template.operationId)
            ? { method: operations.get(template.operationId)!.method, path: operations.get(template.operationId)!.path }
            : {}),
          description: template.description,
          expectedStatus: template.expectedStatus,
          parameters: template.parameters,
          disabledParameters: template.disabledParameters,
          headers: template.headers,
          disabledHeaders: template.disabledHeaders,
          body: template.body,
          auth: template.auth,
        })),
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        status: workflow.status,
        definition: workflow.definition as unknown as FlowDefinition,
      })),
      datasets: datasets
        .filter((dataset) => kept.has(dataset.workflowId))
        .map((dataset) => ({ workflowId: dataset.workflowId, name: dataset.name, rows: dataset.rows })),
      suites: suites.map((suite) => ({
        name: suite.name,
        description: suite.description,
        workflowIds: suite.workflowIds.filter((id) => kept.has(id)),
      })),
    };
  }
}
