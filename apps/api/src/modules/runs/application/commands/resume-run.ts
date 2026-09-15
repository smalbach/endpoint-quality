import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, NotFoundError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { isFinished, type ResumeMode } from "../../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../../domain/ports";

export class ResumeRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
    readonly how: ResumeMode,
  ) {}
}

/**
 * Lets a waiting run go on — one step, or the rest of the way.
 *
 * Refused when the run is not waiting. A «siguiente» that arrives while the step is still executing
 * would otherwise sit in the queue and release the *next* pause the moment it happens, which is a
 * step the person never saw being offered.
 */
@CommandHandler(ResumeRunCommand)
export class ResumeRunHandler implements ICommandHandler<ResumeRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
  ) {}

  async execute(command: ResumeRunCommand): Promise<void> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const run = await this.runs.findById(command.runId);
    if (!run || run.projectId !== command.projectId) throw new NotFoundError("La corrida no existe", "run-not-found");
    if (isFinished(run.status)) throw new ConflictError("La corrida ya terminó", "run-finished");
    if (!(await this.queue.pausedAt(run.id))) throw new ConflictError("La corrida no está en pausa", "run-not-paused");
    await this.queue.resume(run.id, command.how);
  }
}
