import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { isFinished } from "../../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../../domain/ports";

export class CancelRunCommand implements ICommand {
  constructor(readonly organizationId: string, readonly projectId: string, readonly runId: string) {}
}

/**
 * Asks the worker to stop at the next case boundary.
 *
 * Not mid-case, deliberately: a `create-read` interrupted between the POST and the DELETE leaves
 * a row behind, and the next run of that case opens with a 409 that reports the cancellation
 * rather than the endpoint. Finishing the case in flight costs seconds and keeps the fixtures
 * clean.
 */
@CommandHandler(CancelRunCommand)
export class CancelRunHandler implements ICommandHandler<CancelRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
  ) {}

  async execute(command: CancelRunCommand): Promise<void> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const run = await this.runs.findById(command.runId);
    if (!run || run.projectId !== command.projectId) throw new NotFoundError("La corrida no existe", "run-not-found");
    if (isFinished(run.status)) throw new ConflictError("La corrida ya terminó", "run-finished");
    await this.queue.cancel(run.id);
  }
}
