import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandBus, CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { ConfigSection, RequestBody, ScenarioCredential, WorkflowDocument } from "@eq/runner-core";
import type { ProjectBundleImportResultView, ProjectBundlePart } from "@eq/contracts";

import { InvalidInputError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { CONFIG_REPOSITORY, type ConfigRepositoryPort } from "@/modules/config/domain/ports";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "@/modules/endpoints/domain/ports";
import { blankExample, redactExample, type EndpointExample } from "@/modules/endpoints/domain/examples";
import { endpointKey, normalizePath, reconcilePathParameters, type Endpoint } from "@/modules/endpoints/domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import { ROLE_COLORS, type PermissionChange, type RoleRule } from "@/modules/roles/domain/model";
import { syncAccessSection } from "@/modules/roles/application/sync-access";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { EnvironmentVariables } from "@/modules/environments/domain/model";
import {
  PERFORMANCE_PLAN_REPOSITORY,
  type PerformancePlanRepositoryPort,
} from "@/modules/performance/domain/ports";
import type { PerformancePlanDefinition } from "@/modules/performance/domain/model";
import { SPEC_REPOSITORY, type SpecRepositoryPort } from "@/modules/specs/domain/ports";
import {
  ImportSpecVersionCommand,
  type ImportSpecVersionResult,
} from "@/modules/specs/application/commands/import-spec-version";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { normalizeTags, type Project } from "../../domain/model";
import {
  bundleProblems,
  isBundlePart,
  missingOperations,
  parseProjectBundle,
  partsIn,
  remapDefinition,
  type ProjectBundle,
} from "../../domain/project-bundle";
import { ownedProject } from "./update-project";
import { uniqueName } from "../../domain/copying";
import { redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";

export class ImportProjectBundleCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** The file as parsed JSON, not yet trusted. */
    readonly data: unknown,
    /** Which of the parts the file carries to bring. Empty means all of them. */
    readonly parts: string[],
    readonly actorId: string,
  ) {}
}

type Result = ProjectBundleImportResultView;
type Ids = { templates: Map<string, string>; workflows: Map<string, string> };

/**
 * A project file into this project.
 *
 * Validated whole first — every chosen piece through its own editor's validator, with references
 * already remapped — and written only if nothing is wrong, so a bad file changes nothing. Then the
 * same merge rules the copy between projects follows: configuration sections are replaced, names
 * that collide are numbered, endpoints that already exist (same method and path) are left alone,
 * roles are matched by name, and environments arrive with their secrets empty and their write and
 * auth flags off, because both are answers about *this* target.
 */
@CommandHandler(ImportProjectBundleCommand)
export class ImportProjectBundleHandler implements ICommandHandler<ImportProjectBundleCommand, Result> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(CONFIG_REPOSITORY) private readonly config: ConfigRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(SPEC_REPOSITORY) private readonly specs: SpecRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly commandBus: CommandBus,
  ) {}

  async execute(command: ImportProjectBundleCommand): Promise<Result> {
    let project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const unknown = command.parts.filter((part) => !isBundlePart(part));
    if (unknown.length) {
      throw new InvalidInputError(
        `No existe la parte ${unknown.join(", ")}`,
        unknown.map((part) => ({ field: "parts", detail: part })),
        "unknown-bundle-part",
      );
    }

    const parsed = parseProjectBundle(command.data);
    if (!parsed.ok) throw new InvalidInputError("El fichero no es un proyecto exportado válido", parsed.issues, "bundle-invalid");
    const bundle = parsed.bundle;
    const present = partsIn(bundle);
    const parts = new Set<ProjectBundlePart>(
      command.parts.length ? present.filter((part) => command.parts.includes(part)) : present,
    );
    if (!parts.size) throw new InvalidInputError("El fichero no trae nada de lo elegido", [], "bundle-empty");

    const ids: Ids = {
      templates: new Map((bundle.flows?.requestTemplates ?? []).map((template) => [template.id, randomUUID()])),
      workflows: new Map((bundle.flows?.workflows ?? []).map((workflow) => [workflow.id, randomUUID()])),
    };
    const problems = bundleProblems(bundle, parts, ids);
    if (problems.length) {
      throw new InvalidInputError(
        "El fichero tiene elementos que no son válidos; no se ha importado nada",
        problems.slice(0, 50),
        "bundle-invalid",
      );
    }

    const now = this.clock.now();
    const result: Result = {
      parts: BUNDLE_ORDER.filter((part) => parts.has(part)),
      settings: false,
      contract: null,
      sections: [],
      endpoints: 0,
      examples: 0,
      roles: 0,
      permissions: 0,
      requestTemplates: 0,
      workflows: 0,
      datasets: 0,
      suites: 0,
      environments: 0,
      performancePlans: 0,
      skipped: [],
    };
    const context = { project, actorId: command.actorId, now, result };

    if (parts.has("settings") && bundle.settings) {
      const settings = bundle.settings;
      project = {
        ...project,
        ...(settings.description !== undefined ? { description: settings.description } : {}),
        ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl.trim() } : {}),
        ...(settings.tags ? { tags: normalizeTags(settings.tags) } : {}),
      };
      await this.projects.save(project);
      context.project = project;
      result.settings = true;
    }
    // Endpoints before the contract. Activating a contract creates its endpoints from an event that
    // runs on its own; with the file's endpoints already stored it only links or adds what is
    // missing, instead of racing this import to insert the same method and path twice.
    if (parts.has("endpoints")) await this.importEndpoints(bundle, context);
    // Through the contract import itself: the same parsing, the same «same bytes, same version», the
    // same events that keep endpoints and drift in step. It saves the project, so read it again.
    if (parts.has("contract") && bundle.contract) {
      const imported = (await this.commandBus.execute(
        new ImportSpecVersionCommand(
          command.organizationId,
          project.id,
          { kind: "upload", filename: `${bundle.project?.name || "proyecto"}.eq.json`, raw: bundle.contract.raw },
          command.actorId,
          true,
        ),
      )) as ImportSpecVersionResult;
      result.contract = imported.unchanged ? "unchanged" : "imported";
      project = await ownedProject(this.projects, command.organizationId, command.projectId);
      context.project = project;
    }
    if (parts.has("config")) {
      for (const entry of bundle.config ?? []) {
        await this.config.saveSection({
          projectId: project.id,
          section: entry.section as ConfigSection,
          data: entry.data,
          updatedAt: now,
          updatedBy: command.actorId,
        });
        result.sections.push(entry.section);
      }
    }
    // Roles after endpoints: a permission lands on an endpoint by method and path, and the ones this
    // same file brings have to exist by then.
    if (parts.has("roles")) await this.importRoles(bundle, context);
    if (parts.has("flows")) {
      await this.importFlows(bundle, ids, context);
      await this.warnMissingOperations(bundle, context);
    }
    if (parts.has("environments")) await this.importEnvironments(bundle, context);
    if (parts.has("performance")) await this.importPlans(bundle, context);
    return result;
  }

  private async importEndpoints(bundle: ProjectBundle, { project, actorId, now, result }: Context): Promise<void> {
    const taken = new Set(
      (await this.endpoints.listAll(project.id)).map((endpoint) => endpointKey(endpoint.method, endpoint.path)),
    );
    let orderIndex = await this.endpoints.nextOrderIndex(project.id);
    const rows: Endpoint[] = [];
    const examples: EndpointExample[] = [];
    for (const endpoint of bundle.endpoints ?? []) {
      const path = normalizePath(endpoint.path);
      const key = endpointKey(endpoint.method, path);
      if (taken.has(key)) {
        result.skipped.push({ what: "endpoint", detail: `${endpoint.method} ${path} ya existe` });
        continue;
      }
      taken.add(key);
      // `examples` se saca del spread: no es una columna del endpoint, y dejarlo entrar escribía un
      // campo que la tabla ignora en silencio — que es la clase de cosa que parece funcionar.
      const { examples: saved, ...fields } = endpoint;
      const id = randomUUID();
      rows.push({
        ...fields,
        // La autenticación se vuelve a tapar al entrar, por lo mismo que los ejemplos de abajo.
        auth: redactAuth(fields.auth).auth,
        path,
        pathParameters: reconcilePathParameters(path, endpoint.pathParameters),
        id,
        projectId: project.id,
        origin: "import",
        orderIndex: orderIndex++,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
        deletedAt: null,
      });
      // El bundle ya viene redactado —es lo que se exportó— pero se vuelve a redactar al entrar: un
      // bundle es un fichero que se edita a mano, y confiar en que llega limpio sería hacer del
      // importador la puerta por la que un token entra a la base de datos.
      for (const [index, example] of (saved ?? []).entries()) {
        const clean = redactExample(example.request, example.response);
        examples.push(
          blankExample({
            projectId: project.id,
            endpointId: id,
            name: example.name,
            request: clean.request,
            response: clean.response,
            origin: "import",
            orderIndex: index,
            now,
            actorId,
          }),
        );
      }
    }
    if (rows.length) await this.endpoints.saveMany(rows);
    if (examples.length) await this.examples.saveMany(examples);
    result.endpoints = rows.length;
    result.examples = examples.length;
  }

  private async importRoles(bundle: ProjectBundle, { project, actorId, now, result }: Context): Promise<void> {
    const existing = await this.roles.list(project.id);
    const roleIds = new Map(existing.map((role) => [role.name.toLowerCase(), role.id]));
    let position = existing.reduce((max, role) => Math.max(max, role.position), -1) + 1;
    for (const role of bundle.roles ?? []) {
      if (roleIds.has(role.name.toLowerCase())) {
        result.skipped.push({ what: "rol", detail: `${role.name} ya existía: se conserva y recibe los permisos del fichero` });
        continue;
      }
      const id = randomUUID();
      await this.roles.save({
        id,
        projectId: project.id,
        name: role.name,
        description: role.description,
        color: role.color ?? ROLE_COLORS[position % ROLE_COLORS.length],
        sameRoleDataIsolation: role.sameRoleDataIsolation,
        position: position++,
        createdAt: now,
        updatedAt: now,
      });
      roleIds.set(role.name.toLowerCase(), id);
      result.roles += 1;
    }

    const endpointIds = new Map(
      (await this.endpoints.listAll(project.id)).map((endpoint) => [endpointKey(endpoint.method, endpoint.path), endpoint.id]),
    );
    const changes = new Map<string, PermissionChange>();
    for (const role of bundle.roles ?? []) {
      const roleId = roleIds.get(role.name.toLowerCase());
      if (!roleId) continue;
      const missing: string[] = [];
      for (const permission of role.permissions) {
        const endpointId = endpointIds.get(endpointKey(permission.method, normalizePath(permission.path)));
        if (!endpointId) {
          missing.push(`${permission.method} ${permission.path}`);
          continue;
        }
        changes.set(`${roleId}:${endpointId}`, {
          roleId,
          endpointId,
          access: permission.access,
          dataScope: permission.dataScope,
        });
      }
      if (missing.length) {
        const sample = missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : "");
        result.skipped.push({ what: "permiso", detail: `${role.name}: ${missing.length} endpoints no existen aquí (${sample})` });
      }
    }
    if (changes.size) await this.roles.applyPermissions([...changes.values()]);
    result.permissions = changes.size;

    if (bundle.roleRules?.length) {
      const merged = new Map<string, RoleRule>(
        (await this.roles.listRules(project.id)).map((rule) => [`${rule.sourceRoleId}:${rule.targetRoleId}`, rule]),
      );
      for (const rule of bundle.roleRules) {
        const sourceRoleId = roleIds.get(rule.source.toLowerCase());
        const targetRoleId = roleIds.get(rule.target.toLowerCase());
        if (!sourceRoleId || !targetRoleId) {
          result.skipped.push({ what: "regla", detail: `${rule.source} → ${rule.target}: uno de los roles no existe` });
          continue;
        }
        merged.set(`${sourceRoleId}:${targetRoleId}`, {
          projectId: project.id,
          sourceRoleId,
          targetRoleId,
          canRead: rule.canRead,
          canWrite: rule.canWrite,
          canDelete: rule.canDelete,
        });
      }
      await this.roles.replaceRules(
        project.id,
        [...merged.values()].filter((rule) => rule.canRead || rule.canWrite || rule.canDelete),
      );
    }

    // The `access` section is derived from the roles everywhere else; an import is no exception.
    await syncAccessSection(
      { roles: this.roles, endpoints: this.endpoints, config: this.config, clock: this.clock },
      project.id,
      actorId,
    );
  }

  private async importFlows(bundle: ProjectBundle, ids: Ids, { project, actorId, now, result }: Context): Promise<void> {
    const flows = bundle.flows;
    if (!flows) return;
    const stamp = { projectId: project.id, createdAt: now, updatedAt: now, updatedBy: actorId };

    const templateNames = new Set((await this.workflows.listTemplates(project.id)).map((row) => row.name));
    for (const template of flows.requestTemplates) {
      const name = uniqueName(template.name, templateNames);
      templateNames.add(name);
      await this.workflows.saveTemplate({
        ...stamp,
        id: ids.templates.get(template.id) ?? randomUUID(),
        name,
        operationId: template.operationId,
        description: template.description,
        expectedStatus: template.expectedStatus,
        parameters: template.parameters,
        disabledParameters: template.disabledParameters,
        headers: template.headers,
        disabledHeaders: template.disabledHeaders,
        body: (template.body ?? { type: "none" }) as RequestBody,
        auth: (template.auth ?? "default") as ScenarioCredential,
      });
      result.requestTemplates += 1;
    }

    const workflowNames = new Set((await this.workflows.listWorkflows(project.id)).map((row) => row.name));
    for (const workflow of flows.workflows) {
      const name = uniqueName(workflow.name, workflowNames);
      workflowNames.add(name);
      const { definition } = remapDefinition(workflow.definition, ids.templates, ids.workflows);
      await this.workflows.saveWorkflow({
        ...stamp,
        id: ids.workflows.get(workflow.id) ?? randomUUID(),
        name,
        description: workflow.description,
        status: workflow.status,
        definition: withoutLiteralSecrets(definition as unknown as WorkflowDocument),
      });
      result.workflows += 1;
    }

    const datasetNames = new Map<string, Set<string>>();
    for (const dataset of flows.datasets) {
      const workflowId = ids.workflows.get(dataset.workflowId);
      if (!workflowId) continue;
      const taken = datasetNames.get(workflowId) ?? new Set<string>();
      datasetNames.set(workflowId, taken);
      const name = uniqueName(dataset.name, taken);
      taken.add(name);
      await this.workflows.saveDataset({
        ...stamp,
        id: randomUUID(),
        workflowId,
        name,
        rows: dataset.rows as Record<string, string>[],
      });
      result.datasets += 1;
    }

    const suiteNames = new Set((await this.workflows.listSuites(project.id)).map((row) => row.name));
    for (const suite of flows.suites) {
      const name = uniqueName(suite.name, suiteNames);
      suiteNames.add(name);
      await this.workflows.saveSuite({
        ...stamp,
        id: randomUUID(),
        name,
        description: suite.description,
        workflowIds: suite.workflowIds.map((id) => ids.workflows.get(id)).filter((id): id is string => Boolean(id)),
      });
      result.suites += 1;
    }
  }

  /**
   * A saved request finds its method and path in the active contract only when a run starts. Saying
   * now which ones will not find it is the difference between a warning and a red run tomorrow.
   */
  private async warnMissingOperations(bundle: ProjectBundle, { project, result }: Context): Promise<void> {
    const templates = bundle.flows?.requestTemplates ?? [];
    if (!templates.length) return;
    const fresh = await this.projects.findById(project.id);
    if (!fresh?.activeSpecVersionId) {
      const which = templates.length === 1 ? "la petición importada" : `las ${templates.length} peticiones importadas`;
      result.skipped.push({ what: "contrato", detail: `este proyecto no tiene contrato: ${which} no se podrán ejecutar hasta importar uno` });
      return;
    }
    const ids = new Set((await this.specs.listOperations(fresh.activeSpecVersionId)).map((operation) => operation.id));
    const missing = missingOperations(templates, ids);
    if (missing.length) {
      const more = missing.length > 5 ? ` y ${missing.length - 5} más` : "";
      result.skipped.push({
        what: "operación",
        detail: `el contrato de este proyecto no tiene ${missing.slice(0, 5).join(", ")}${more}: no se podrán ejecutar`,
      });
    }
  }

  private async importEnvironments(bundle: ProjectBundle, context: Context): Promise<void> {
    const { project, now, result } = context;
    const names = new Set((await this.environments.listForProject(project.id)).map((row) => row.name));
    let firstId: string | null = null;
    for (const environment of bundle.environments ?? []) {
      const name = uniqueName(environment.name, names);
      names.add(name);
      const secrets: string[] = [];
      // A sensitive value is never taken from a file: it would have to be stored as plain text to
      // be encrypted later, and a file is exactly where a secret should not have come from.
      const clean = (variables: NonNullable<ProjectBundle["environments"]>[number]["variables"]): EnvironmentVariables =>
        Object.fromEntries(
          Object.entries(variables).map(([key, variable]) => {
            if (variable.sensitive) {
              secrets.push(key);
              return [key, { initial: "", current: "", sensitive: true }];
            }
            return [key, { initial: variable.initial, current: variable.current ?? variable.initial, sensitive: false }];
          }),
        );
      const variables = clean(environment.variables);
      const disabledVariables = Object.fromEntries(
        Object.entries(clean(environment.disabledVariables)).filter(([key]) => !(key in variables)),
      );
      if (secrets.length)
        result.skipped.push({ what: "secreto", detail: `${name}: hay que escribir ${[...new Set(secrets)].join(", ")}` });

      const id = randomUUID();
      await this.environments.save({
        id,
        projectId: project.id,
        name,
        baseUrl: environment.baseUrl.trim().replace(/\/+$/, ""),
        specUrl: environment.specUrl,
        variables,
        disabledVariables,
        writesAllowed: false,
        authEnforced: false,
        createdAt: now,
      });
      firstId ??= id;
      result.environments += 1;
    }
    // The first environment of a project becomes the active one, as when it is created by hand.
    if (firstId && !project.activeEnvironmentId) {
      context.project = { ...project, activeEnvironmentId: firstId };
      await this.projects.save(context.project);
    }
  }

  private async importPlans(bundle: ProjectBundle, { project, actorId, now, result }: Context): Promise<void> {
    const names = new Set((await this.plans.list(project.id)).map((row) => row.name));
    for (const plan of bundle.performance ?? []) {
      const name = uniqueName(plan.name, names);
      names.add(name);
      await this.plans.save({
        id: randomUUID(),
        projectId: project.id,
        name,
        description: plan.description,
        definition: plan.definition as PerformancePlanDefinition,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
      result.performancePlans += 1;
    }
  }
}

type Context = { project: Project; actorId: string; now: Date; result: Result };

const BUNDLE_ORDER: ProjectBundlePart[] = ["settings", "contract", "config", "endpoints", "roles", "flows", "environments", "performance"];
