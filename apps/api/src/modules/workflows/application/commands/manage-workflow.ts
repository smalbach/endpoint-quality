import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { safeParseWorkflowDocument, type WorkflowDocument } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { WorkflowRow, WorkflowStatus } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";

export type WorkflowInput = {
  name?: string;
  description?: string | null;
  status?: WorkflowStatus;
  definition?: WorkflowDocument;
};

export class CreateWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: WorkflowInput,
    readonly actorId: string,
  ) {}
}
export class UpdateWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
    readonly input: WorkflowInput,
    readonly actorId: string,
  ) {}
}
export class DeleteWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
  ) {}
}
export class DuplicateWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
    readonly actorId: string,
  ) {}
}

/** «Nombre», «Nombre (copia)», «Nombre (copia 2)»… — the first free one, so a second duplicate of
 * the same flow does not collide with the first. */
async function freeCopyName(workflows: WorkflowRepositoryPort, projectId: string, base: string): Promise<string> {
  const candidates = [`${base} (copia)`, ...Array.from({ length: 98 }, (_, index) => `${base} (copia ${index + 2})`)];
  for (const candidate of candidates) {
    const fits = candidate.length <= 120 && !(await workflows.findWorkflowByName(projectId, candidate));
    if (fits) return candidate;
  }
  // A name nobody chose is better than refusing to duplicate: unique by construction.
  return `${base.slice(0, 100)} ${randomUUID().slice(0, 8)}`;
}

export async function ownedWorkflow(
  projects: ProjectRepositoryPort,
  workflows: WorkflowRepositoryPort,
  organizationId: string,
  projectId: string,
  workflowId: string,
): Promise<WorkflowRow> {
  await ownedProject(projects, organizationId, projectId);
  const workflow = await workflows.findWorkflow(projectId, workflowId);
  if (!workflow) throw new NotFoundError("El flujo no existe", "workflow-not-found");
  return workflow;
}

/**
 * Two checks, because they answer different questions and only one of them fits in a schema.
 *
 * The engine's zod says the graph is *well formed*: unique ids, every edge pointing at a step that
 * is there, no cycle. Whether a step names a request of **this** project spans two tables, so it
 * is a query — and it has to be, because the alternative is a run that dies on its third case
 * naming an id nobody recognises.
 */
async function validatedDefinition(
  workflows: WorkflowRepositoryPort,
  projectId: string,
  definition: WorkflowDocument,
): Promise<WorkflowDocument> {
  const parsed = safeParseWorkflowDocument(definition);
  if (!parsed.ok) throw new InvalidInputError("El flujo no es válido", parsed.issues, "workflow-invalid");

  const known = new Set((await workflows.listTemplates(projectId)).map((template) => template.id));
  const missing = definition.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.requestTemplateId !== undefined && !known.has(step.requestTemplateId));
  if (missing.length) {
    throw new InvalidInputError(
      "El flujo no es válido",
      missing.map(({ step, index }) => ({
        field: `definition.steps.${index}.requestTemplateId`,
        detail: `la prueba ${step.requestTemplateId} no existe en este proyecto`,
      })),
      "workflow-invalid",
    );
  }
  return definition;
}

@CommandHandler(CreateWorkflowCommand)
export class CreateWorkflowHandler implements ICommandHandler<CreateWorkflowCommand, { workflowId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateWorkflowCommand): Promise<{ workflowId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name) {
      throw new InvalidInputError(
        "El flujo necesita un nombre",
        [{ field: "name", detail: "Escriba un nombre" }],
        "workflow-invalid",
      );
    }
    if (await this.workflows.findWorkflowByName(command.projectId, name)) {
      throw new ConflictError("Ya existe un flujo con ese nombre", "workflow-name-taken");
    }
    const definition = await validatedDefinition(
      this.workflows,
      command.projectId,
      command.input.definition ?? { steps: [] },
    );
    const now = this.clock.now();
    const workflowId = randomUUID();
    await this.workflows.saveWorkflow({
      id: workflowId,
      projectId: command.projectId,
      name,
      description: command.input.description || null,
      // A new flow is a draft: its edges are still moving and no suite should pick it up yet. The
      // one place «draft» is decided, so the column can go on defaulting existing rows to «ready».
      status: command.input.status ?? "draft",
      definition,
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
    });
    return { workflowId };
  }
}

@CommandHandler(UpdateWorkflowCommand)
export class UpdateWorkflowHandler implements ICommandHandler<UpdateWorkflowCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateWorkflowCommand): Promise<void> {
    const previous = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    const name = (command.input.name ?? previous.name).trim();
    const clash = await this.workflows.findWorkflowByName(command.projectId, name);
    if (clash && clash.id !== previous.id) {
      throw new ConflictError("Ya existe un flujo con ese nombre", "workflow-name-taken");
    }
    // The whole graph or nothing: a partial write of a document whose halves reference each other
    // is the state this shape exists to make impossible.
    const definition = command.input.definition
      ? await validatedDefinition(this.workflows, command.projectId, command.input.definition)
      : previous.definition;
    await this.workflows.saveWorkflow({
      ...previous,
      name,
      description: command.input.description === undefined ? previous.description : command.input.description || null,
      status: command.input.status ?? previous.status,
      definition,
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }
}

@CommandHandler(DeleteWorkflowCommand)
export class DeleteWorkflowHandler implements ICommandHandler<DeleteWorkflowCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(command: DeleteWorkflowCommand): Promise<void> {
    const workflow = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    // The same answer this product gives for a template a flow uses: a reference is a decision
    // somebody made, and removing it on their behalf changes what a suite runs without saying so.
    if (await this.workflows.isWorkflowReferenced(command.projectId, workflow.id))
      throw new ConflictError("Alguna suite usa este flujo", "workflow-in-use");
    // Its datasets go with it, by the cascade in the migration: a table of values for a flow that
    // no longer exists is rows nothing can ever spend.
    await this.workflows.deleteWorkflow(command.projectId, workflow.id);
  }
}

/**
 * A copy of a flow, its graph and its datasets — a draft, under a free «(copia)» name.
 *
 * The graph copies verbatim: the step ids stay, because they are only unique within a document and
 * the edges between them are what a duplicate is *for*. The datasets come too — a table of values
 * means nothing away from the steps that spend it, so a copy without them is a flow that runs
 * against no data. The copy starts as a draft on purpose: it is not the tested one, and letting it
 * inherit «ready» would put an unreviewed flow into the pickers that build a suite.
 */
@CommandHandler(DuplicateWorkflowCommand)
export class DuplicateWorkflowHandler implements ICommandHandler<DuplicateWorkflowCommand, { workflowId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DuplicateWorkflowCommand): Promise<{ workflowId: string }> {
    const source = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    const now = this.clock.now();
    const workflowId = randomUUID();
    await this.workflows.saveWorkflow({
      id: workflowId,
      projectId: command.projectId,
      name: await freeCopyName(this.workflows, command.projectId, source.name),
      description: source.description,
      status: "draft",
      definition: { steps: source.definition.steps.map((step) => ({ ...step })) },
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
    });
    const datasets = (await this.workflows.listDatasets(command.projectId)).filter(
      (dataset) => dataset.workflowId === source.id,
    );
    for (const dataset of datasets) {
      await this.workflows.saveDataset({
        id: randomUUID(),
        projectId: command.projectId,
        workflowId,
        name: dataset.name,
        rows: dataset.rows.map((row) => ({ ...row })),
        createdAt: now,
        updatedAt: now,
        updatedBy: command.actorId,
      });
    }
    return { workflowId };
  }
}
