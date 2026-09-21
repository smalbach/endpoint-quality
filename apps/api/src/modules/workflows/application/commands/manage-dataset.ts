import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { safeParseDatasetRows } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import {
  archiveIn,
  deleteIn,
  restoreIn,
  type LifecycleNoun,
  type LifecycleStore,
} from "@/shared/lifecycle/lifecycle-store";
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
/** Borrar un conjunto: blando por defecto, definitivo con `purge` y solo sobre algo eliminado. */
export class DeleteDatasetCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly datasetId: string,
    readonly purge = false,
  ) {}
}

/** Archivar un conjunto: deja de ofrecerse al lanzar una corrida, y sus filas se quedan. */
export class SetDatasetArchivedCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly datasetId: string,
    readonly archived: boolean,
  ) {}
}

/** Restaurar un conjunto eliminado, con sus filas. */
export class RestoreDatasetCommand implements ICommand {
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
      archivedAt: null,
      deletedAt: null,
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

/** Cómo se llama esto en los errores del ciclo de vida. */
const DATASET: LifecycleNoun = {
  code: "dataset",
  that: "El conjunto de datos",
  the: "el conjunto",
};

/** El almacén de conjuntos con la forma del servicio de ciclo de vida. */
const datasetStore = (workflows: WorkflowRepositoryPort): LifecycleStore<DatasetRow> => ({
  findById: (projectId, id) => workflows.findDataset(projectId, id),
  save: (row) => workflows.saveDataset(row),
  remove: async (projectId, id) => {
    await workflows.deleteDataset(projectId, id);
    return true;
  },
});

const touch = (row: DatasetRow, now: Date): DatasetRow => ({ ...row, updatedAt: now });

/**
 * Borrar un conjunto de datos **sin perder las filas**.
 *
 * Lo que se borraba era un CSV pegado a mano, a veces de cientos de filas, y no había forma de
 * recuperarlo salvo volver a pegarlo. Ahora sale de la lista y vuelve entero.
 *
 * Las corridas que lo recorrieron conservan su plan y sus resultados: el plan es una foto de lo que
 * se pidió, y reescribir el pasado para que cuadre con el presente es lo único que una corrida no
 * puede hacer.
 */
@CommandHandler(DeleteDatasetCommand)
export class DeleteDatasetHandler implements ICommandHandler<DeleteDatasetCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeleteDatasetCommand): Promise<void> {
    const dataset = await this.workflows.findDataset(command.projectId, command.datasetId);
    if (!dataset) throw new NotFoundError("El conjunto de datos no existe", "dataset-not-found");
    await ownedWorkflow(this.projects, this.workflows, command.organizationId, command.projectId, dataset.workflowId);
    await deleteIn(
      datasetStore(this.workflows),
      command.projectId,
      command.datasetId,
      command.purge,
      this.clock.now(),
      DATASET,
      { patch: touch },
    );
  }
}

@CommandHandler(SetDatasetArchivedCommand)
export class SetDatasetArchivedHandler implements ICommandHandler<SetDatasetArchivedCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetDatasetArchivedCommand): Promise<void> {
    const dataset = await this.workflows.findDataset(command.projectId, command.datasetId);
    if (!dataset) throw new NotFoundError("El conjunto de datos no existe", "dataset-not-found");
    await ownedWorkflow(this.projects, this.workflows, command.organizationId, command.projectId, dataset.workflowId);
    await archiveIn(
      datasetStore(this.workflows),
      command.projectId,
      command.datasetId,
      command.archived,
      this.clock.now(),
      DATASET,
      { patch: touch },
    );
  }
}

@CommandHandler(RestoreDatasetCommand)
export class RestoreDatasetHandler implements ICommandHandler<RestoreDatasetCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestoreDatasetCommand): Promise<void> {
    const dataset = await this.workflows.findDataset(command.projectId, command.datasetId);
    if (!dataset) throw new NotFoundError("El conjunto de datos no existe", "dataset-not-found");
    // El flujo al que pertenece **en cualquier estado**: si el flujo está eliminado, restaurar solo
    // el conjunto lo dejaría colgando de algo que no sale en ninguna lista.
    const workflow = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      dataset.workflowId,
    );
    if (workflow.deletedAt)
      throw new ConflictError("Restaura antes el flujo de este conjunto", "workflow-deleted");
    // El nombre pudo reutilizarse dentro del mismo flujo mientras estaba fuera.
    if (dataset.deletedAt && (await this.workflows.findDatasetByName(dataset.workflowId, dataset.name)))
      throw new ConflictError("Ya hay un conjunto con ese nombre", "dataset-name-taken");
    await restoreIn(
      datasetStore(this.workflows),
      command.projectId,
      command.datasetId,
      this.clock.now(),
      DATASET,
      { patch: touch },
    );
  }
}
