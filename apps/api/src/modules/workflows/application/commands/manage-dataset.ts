import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { safeParseDatasetRows } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import type { DatasetRow } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";
import { ownedWorkflow } from "./manage-workflow";

export type DatasetInput = { name?: string; rows?: unknown };

export class CreateDatasetCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
    readonly input: DatasetInput,
    readonly actorId: string,
  ) {}
}
export class UpdateDatasetCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly datasetId: string,
    readonly input: DatasetInput,
    readonly actorId: string,
  ) {}
}
export class DeleteDatasetCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly datasetId: string,
  ) {}
}

/**
 * The rows, checked before they are stored.
 *
 * A column name that is not a variable name could never be spent — `{{dataset.total price}}` is
 * not a token the engine will ever substitute — so accepting it here would only move the discovery
 * to the middle of a run, where it looks like the target's fault.
 */
function validRows(rows: unknown): Record<string, string>[] {
  const parsed = safeParseDatasetRows(rows ?? []);
  if (!parsed.ok) throw new InvalidInputError("Los datos no son válidos", parsed.issues, "dataset-invalid");
  return (rows ?? []) as Record<string, string>[];
}

const named = (input: DatasetInput): string => {
  const name = (input.name ?? "").trim();
  if (!name)
    throw new InvalidInputError("El conjunto de datos necesita un nombre", [{ field: "name", detail: "Requerido" }]);
  return name;
};

@CommandHandler(CreateDatasetCommand)
export class CreateDatasetHandler implements ICommandHandler<CreateDatasetCommand, { datasetId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateDatasetCommand) {
    const workflow = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    const name = named(command.input);
    if (await this.workflows.findDatasetByName(workflow.id, name))
      throw new ConflictError("Ya hay un conjunto con ese nombre", "dataset-name-taken");

    const now = this.clock.now();
    const dataset: DatasetRow = {
      id: randomUUID(),
      projectId: workflow.projectId,
      workflowId: workflow.id,
      name,
      rows: validRows(command.input.rows),
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
    };
    await this.workflows.saveDataset(dataset);
    return { datasetId: dataset.id };
  }
}

@CommandHandler(UpdateDatasetCommand)
export class UpdateDatasetHandler implements ICommandHandler<UpdateDatasetCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateDatasetCommand): Promise<void> {
    const dataset = await this.ownedDataset(command.organizationId, command.projectId, command.datasetId);
    const name = command.input.name?.trim();
    if (name && name !== dataset.name && (await this.workflows.findDatasetByName(dataset.workflowId, name)))
      throw new ConflictError("Ya hay un conjunto con ese nombre", "dataset-name-taken");

    await this.workflows.saveDataset({
      ...dataset,
      name: name || dataset.name,
      rows: command.input.rows === undefined ? dataset.rows : validRows(command.input.rows),
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }

  private async ownedDataset(organizationId: string, projectId: string, datasetId: string): Promise<DatasetRow> {
    // The project is checked through the flow the dataset belongs to, so a dataset id from another
    // tenant is a 404 and not a confirmation that the id exists.
    const dataset = await this.workflows.findDataset(projectId, datasetId);
    if (!dataset) throw new NotFoundError("El conjunto de datos no existe", "dataset-not-found");
    await ownedWorkflow(this.projects, this.workflows, organizationId, projectId, dataset.workflowId);
    return dataset;
  }
}

@CommandHandler(DeleteDatasetCommand)
export class DeleteDatasetHandler implements ICommandHandler<DeleteDatasetCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(command: DeleteDatasetCommand): Promise<void> {
    const dataset = await this.workflows.findDataset(command.projectId, command.datasetId);
    if (!dataset) throw new NotFoundError("El conjunto de datos no existe", "dataset-not-found");
    await ownedWorkflow(this.projects, this.workflows, command.organizationId, command.projectId, dataset.workflowId);
    // Runs that walked it keep their plan and their results. The plan is a snapshot of what was
    // asked for, and rewriting history to match the present is the one thing a run must never do.
    await this.workflows.deleteDataset(command.projectId, command.datasetId);
  }
}
