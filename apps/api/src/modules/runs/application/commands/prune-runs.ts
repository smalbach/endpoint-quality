/**
 * The retention sweep, as a command.
 *
 * A command and not a method on a timer, for the same reason everything else here is one: it can
 * be dispatched by a test, by a scheduler, or by an operator who wants the space back today,
 * and all three go through the same code. The scheduler below is thirty lines and knows nothing
 * except when to fire.
 */
import { Inject, Logger } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
import { RUN_REPOSITORY, type RunRepositoryPort } from "../../domain/ports";

export type PruneReport = { bodiesPruned: number; runsDeleted: number };

/**
 * `bodiesDays` and `runsDays` override the configured policy, which is what makes this testable
 * without waiting a month. Omitted, the environment decides.
 */
export class PruneRunsCommand implements ICommand {
  constructor(
    readonly bodiesDays?: number,
    readonly runsDays?: number,
  ) {}
}

@CommandHandler(PruneRunsCommand)
export class PruneRunsHandler implements ICommandHandler<PruneRunsCommand, PruneReport> {
  private readonly logger = new Logger("Retention");

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async execute(command: PruneRunsCommand): Promise<PruneReport> {
    const bodiesDays = command.bodiesDays ?? this.env.RETENTION_BODIES_DAYS;
    const runsDays = command.runsDays ?? this.env.RETENTION_RUNS_DAYS;

    // Deleting first would make the second stage report rows it never had to touch, and the two
    // numbers are what an operator reads to decide whether the policy is doing anything.
    const bodiesPruned = bodiesDays > 0 ? await this.runs.pruneStepBodies(this.daysAgo(bodiesDays)) : 0;
    const runsDeleted = runsDays > 0 ? await this.runs.deleteRunsBefore(this.daysAgo(runsDays)) : 0;

    // Logged only when it did something. A sweep that finds nothing is the normal case and does
    // not need a line every six hours saying so.
    if (bodiesPruned || runsDeleted)
      this.logger.log(`Retención: ${bodiesPruned} pasos sin cuerpo, ${runsDeleted} corridas borradas`);
    return { bodiesPruned, runsDeleted };
  }

  private daysAgo(days: number): Date {
    return new Date(this.clock.now().getTime() - days * 24 * 60 * 60 * 1000);
  }
}
