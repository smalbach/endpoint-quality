import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { PerformanceRun } from "../../domain/model";
import { totalDurationS } from "../../domain/load";
import { safeParsePlanDefinition } from "../../domain/plan-schema";
import { ownedPlan } from "./manage-plan";
import {
  PERFORMANCE_PLAN_REPOSITORY,
  PERFORMANCE_RUN_QUEUE,
  PERFORMANCE_RUN_REPOSITORY,
  type PerformancePlanRepositoryPort,
  type PerformanceRunQueuePort,
  type PerformanceRunRepositoryPort,
} from "../../domain/ports";

export class StartRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string,
    readonly environmentId: string,
  ) {}
}
export class CancelRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}
export class DeleteRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

export async function ownedRun(
  projects: ProjectRepositoryPort,
  runs: PerformanceRunRepositoryPort,
  organizationId: string,
  projectId: string,
  runId: string,
): Promise<PerformanceRun> {
  await ownedProject(projects, organizationId, projectId);
  const run = await runs.find(projectId, runId);
  if (!run) throw new NotFoundError("La corrida no existe", "performance-run-not-found");
  return run;
}

@CommandHandler(StartRunCommand)
export class StartRunHandler implements ICommandHandler<StartRunCommand, { runId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(PERFORMANCE_RUN_QUEUE) private readonly queue: PerformanceRunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: StartRunCommand): Promise<{ runId: string }> {
    const plan = await ownedPlan(this.projects, this.plans, command.organizationId, command.projectId, command.planId);

    // The whole plan is validated at the door, ceilings included: a run that would ask for a million
    // virtual users is a 422 here, not a machine on fire ten seconds in.
    const parsed = safeParsePlanDefinition(plan.definition);
    if (!parsed.ok) throw new InvalidInputError("El plan no es válido", parsed.issues, "performance-plan-invalid");
    if (!plan.definition.scenarios.length)
      throw new InvalidInputError(
        "El plan no tiene escenarios que ejecutar",
        [{ field: "scenarios", detail: "Añade al menos un escenario" }],
        "performance-plan-empty",
      );

    const environment = await this.environments.findById(command.environmentId);
    if (!environment || environment.projectId !== command.projectId)
      throw new InvalidInputError(
        "El entorno no existe en este proyecto",
        [{ field: "environmentId", detail: "Elige un entorno del proyecto" }],
        "environment-invalid",
      );

    const now = this.clock.now();
    const runId = randomUUID();
    const run: PerformanceRun = {
      id: runId,
      projectId: command.projectId,
      planId: plan.id,
      planName: plan.name,
      environmentId: environment.id,
      status: "queued",
      definition: plan.definition,
      progress: { elapsedS: 0, totalS: totalDurationS(plan.definition.profile), requests: 0, vus: 0 },
      summary: null,
      windows: [],
      endpoints: [],
      thresholds: [],
      error: null,
      startedAt: now,
      finishedAt: null,
    };
    await this.runs.save(run);
    await this.queue.enqueue(runId);
    return { runId };
  }
}

@CommandHandler(CancelRunCommand)
export class CancelRunHandler implements ICommandHandler<CancelRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
    @Inject(PERFORMANCE_RUN_QUEUE) private readonly queue: PerformanceRunQueuePort,
  ) {}

  async execute(command: CancelRunCommand): Promise<void> {
    const run = await ownedRun(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    if (run.status === "queued" || run.status === "running") await this.queue.cancel(run.id);
  }
}

@CommandHandler(DeleteRunCommand)
export class DeleteRunHandler implements ICommandHandler<DeleteRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_RUN_REPOSITORY) private readonly runs: PerformanceRunRepositoryPort,
  ) {}

  async execute(command: DeleteRunCommand): Promise<void> {
    const run = await ownedRun(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    await this.runs.delete(command.projectId, run.id);
  }
}
