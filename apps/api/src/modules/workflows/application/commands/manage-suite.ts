import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { SuiteRow } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";

export type SuiteInput = { name?: string; description?: string | null; workflowIds?: string[] };

export class CreateSuiteCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: SuiteInput,
    readonly actorId: string,
  ) {}
}
export class UpdateSuiteCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly suiteId: string,
    readonly input: SuiteInput,
    readonly actorId: string,
  ) {}
}
export class DeleteSuiteCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly suiteId: string,
  ) {}
}

/**
 * The flows a suite names, in order, each of them real and each of them once.
 *
 * The order is the content: a suite exists because those nine flows have to run in that sequence,
 * so «the same flow twice» is almost always a paste and not an intention — and if it were one, the
 * two runs would be indistinguishable in the report, which makes it a bad way to say it.
 */
async function validIds(workflows: WorkflowRepositoryPort, projectId: string, ids: string[]): Promise<string[]> {
  const known = new Set((await workflows.listWorkflows(projectId)).map((workflow) => workflow.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length)
    throw new InvalidInputError(
      "La suite nombra flujos que no existen",
      missing.map((id) => ({ field: "workflowIds", detail: `No hay ningún flujo con el id ${id}` })),
      "workflow-not-found",
    );
  if (new Set(ids).size !== ids.length)
    throw new InvalidInputError("La suite repite un flujo", [
      { field: "workflowIds", detail: "Cada flujo aparece una vez" },
    ]);
  return ids;
}

@CommandHandler(CreateSuiteCommand)
export class CreateSuiteHandler implements ICommandHandler<CreateSuiteCommand, { suiteId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreateSuiteCommand) {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name) throw new InvalidInputError("La suite necesita un nombre", [{ field: "name", detail: "Requerido" }]);
    if (await this.workflows.findSuiteByName(project.id, name))
      throw new ConflictError("Ya hay una suite con ese nombre", "suite-name-taken");

    const now = this.clock.now();
    const suite: SuiteRow = {
      id: randomUUID(),
      projectId: project.id,
      name,
      description: command.input.description ?? null,
      workflowIds: await validIds(this.workflows, project.id, command.input.workflowIds ?? []),
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
    };
    await this.workflows.saveSuite(suite);
    return { suiteId: suite.id };
  }
}

@CommandHandler(UpdateSuiteCommand)
export class UpdateSuiteHandler implements ICommandHandler<UpdateSuiteCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdateSuiteCommand): Promise<void> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const suite = await this.workflows.findSuite(command.projectId, command.suiteId);
    if (!suite) throw new NotFoundError("La suite no existe", "suite-not-found");

    const name = command.input.name?.trim();
    if (name && name !== suite.name && (await this.workflows.findSuiteByName(suite.projectId, name)))
      throw new ConflictError("Ya hay una suite con ese nombre", "suite-name-taken");

    await this.workflows.saveSuite({
      ...suite,
      name: name || suite.name,
      description: command.input.description === undefined ? suite.description : command.input.description,
      workflowIds:
        command.input.workflowIds === undefined
          ? suite.workflowIds
          : await validIds(this.workflows, suite.projectId, command.input.workflowIds),
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }
}

@CommandHandler(DeleteSuiteCommand)
export class DeleteSuiteHandler implements ICommandHandler<DeleteSuiteCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
  ) {}

  async execute(command: DeleteSuiteCommand): Promise<void> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const suite = await this.workflows.findSuite(command.projectId, command.suiteId);
    if (!suite) throw new NotFoundError("La suite no existe", "suite-not-found");
    // Deleting the suite deletes nothing else. It is a list of flows, and the flows are the work.
    await this.workflows.deleteSuite(command.projectId, command.suiteId);
  }
}
