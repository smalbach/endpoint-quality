import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { WorkflowDocument } from "@eq/runner-core";
import type { ImportElementsResultView } from "@eq/contracts";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { endpointKey } from "@/modules/endpoints/domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "../../domain/ports";
import { ownedProject } from "./update-project";
import { uniqueName, withoutSecrets } from "../../domain/copying";
import { redactAuth, withoutLiteralSecrets } from "@/modules/workflows/domain/postman-auth";

export type ImportElementsInput = {
  sourceProjectId: string;
  endpointIds: string[];
  workflowIds: string[];
  environmentIds: string[];
};

export class ImportElementsCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: ImportElementsInput,
    readonly actorId: string,
  ) {}
}

/**
 * Bringing chosen pieces of one project into another, element by element.
 *
 * The whole-project copy exists for starting from a template; this is the finer tool: three
 * endpoints from here, one flow from there. The same tenant rule holds — both projects go through
 * `ownedProject` — and the same secret rule — an environment's sensitive values keep their names and
 * lose their contents, because a copied secret is a secret in two places. A flow drags the requests
 * its steps name and its datasets with it, so it does not land pointing at nothing.
 */
@CommandHandler(ImportElementsCommand)
export class ImportElementsHandler implements ICommandHandler<ImportElementsCommand, ImportElementsResultView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: ImportElementsCommand): Promise<ImportElementsResultView> {
    const target = await ownedProject(this.projects, command.organizationId, command.projectId);
    await ownedProject(this.projects, command.organizationId, command.input.sourceProjectId);
    const source = command.input.sourceProjectId;
    const now = this.clock.now();
    const result: ImportElementsResultView = { endpoints: 0, workflows: 0, environments: 0, skipped: [] };

    await this.copyEndpoints(source, target.id, new Set(command.input.endpointIds), command.actorId, now, result);
    await this.copyWorkflows(source, target.id, new Set(command.input.workflowIds), command.actorId, now, result);
    await this.copyEnvironments(source, target.id, new Set(command.input.environmentIds), now, result);
    return result;
  }

  private async copyEndpoints(
    source: string,
    targetId: string,
    ids: Set<string>,
    actorId: string,
    now: Date,
    result: ImportElementsResultView,
  ): Promise<void> {
    if (!ids.size) return;
    const taken = new Set(
      (await this.endpoints.listAll(targetId)).map((endpoint) => endpointKey(endpoint.method, endpoint.path)),
    );
    let orderIndex = await this.endpoints.nextOrderIndex(targetId);
    const rows = (await this.endpoints.listAll(source))
      .filter((endpoint) => ids.has(endpoint.id))
      .filter((endpoint) => {
        const key = endpointKey(endpoint.method, endpoint.path);
        if (taken.has(key)) {
          result.skipped.push({ what: "endpoint", detail: `${endpoint.method} ${endpoint.path} ya existe` });
          return false;
        }
        taken.add(key);
        return true;
      })
      .map((endpoint) => ({
        ...endpoint,
        // Una fila de antes de que un endpoint tapara sus secretos puede traer uno: no se copia.
        auth: redactAuth(endpoint.auth).auth,
        id: randomUUID(),
        projectId: targetId,
        origin: "import" as const,
        orderIndex: orderIndex++,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
        deletedAt: null,
      }));
    if (rows.length) await this.endpoints.saveMany(rows);
    result.endpoints = rows.length;
  }

  private async copyWorkflows(
    source: string,
    targetId: string,
    ids: Set<string>,
    actorId: string,
    now: Date,
    result: ImportElementsResultView,
  ): Promise<void> {
    if (!ids.size) return;
    const workflows = (await this.workflows.listWorkflows(source)).filter((workflow) => ids.has(workflow.id));
    if (!workflows.length) return;

    // The templates the chosen flows actually use, and no others.
    const neededTemplates = new Set(
      workflows.flatMap((workflow) => workflow.definition.steps.map((step) => step.requestTemplateId)),
    );
    const existingTemplates = new Set((await this.workflows.listTemplates(targetId)).map((row) => row.name));
    const templateIds = new Map<string, string>();
    for (const template of await this.workflows.listTemplates(source)) {
      if (!neededTemplates.has(template.id)) continue;
      const name = uniqueName(template.name, existingTemplates);
      existingTemplates.add(name);
      const id = randomUUID();
      templateIds.set(template.id, id);
      await this.workflows.saveTemplate({
        ...template,
        id,
        projectId: targetId,
        name,
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
    }

    const existingWorkflows = new Set((await this.workflows.listWorkflows(targetId)).map((row) => row.name));
    const datasets = await this.workflows.listDatasets(source);
    for (const workflow of workflows) {
      const steps = workflow.definition.steps.map((step) =>
        // A branch node has no template to remap; leave it untouched.
        step.requestTemplateId
          ? { ...step, requestTemplateId: templateIds.get(step.requestTemplateId) ?? step.requestTemplateId }
          : step,
      );
      const name = uniqueName(workflow.name, existingWorkflows);
      existingWorkflows.add(name);
      const workflowId = randomUUID();
      await this.workflows.saveWorkflow({
        ...workflow,
        id: workflowId,
        projectId: targetId,
        name,
        definition: withoutLiteralSecrets({ ...workflow.definition, steps } as WorkflowDocument),
        createdAt: now,
        updatedAt: now,
        updatedBy: actorId,
      });
      for (const dataset of datasets.filter((entry) => entry.workflowId === workflow.id)) {
        await this.workflows.saveDataset({
          ...dataset,
          id: randomUUID(),
          projectId: targetId,
          workflowId,
          createdAt: now,
          updatedAt: now,
          updatedBy: actorId,
        });
      }
      result.workflows += 1;
    }
  }

  private async copyEnvironments(
    source: string,
    targetId: string,
    ids: Set<string>,
    now: Date,
    result: ImportElementsResultView,
  ): Promise<void> {
    if (!ids.size) return;
    const existing = new Set((await this.environments.listForProject(targetId)).map((row) => row.name));
    for (const environment of (await this.environments.listForProject(source)).filter((row) => ids.has(row.id))) {
      const name = uniqueName(environment.name, existing);
      existing.add(name);
      const active = withoutSecrets(environment.variables);
      const parked = withoutSecrets(environment.disabledVariables);
      const emptied = [...new Set([...active.emptied, ...parked.emptied])];
      if (emptied.length)
        result.skipped.push({ what: "secreto", detail: `${name}: hay que reescribir ${emptied.join(", ")}` });
      await this.environments.save({
        ...environment,
        id: randomUUID(),
        projectId: targetId,
        name,
        variables: active.variables,
        disabledVariables: parked.variables,
        // Reset, not carried: both are answers about this target, not the source.
        writesAllowed: false,
        authEnforced: false,
        createdAt: now,
      });
      result.environments += 1;
    }
  }
}
