import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { OrderMode } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { Run, RunPlan } from "../../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../../domain/ports";

export type StartRunInput = Partial<RunPlan> & { environmentId: string };

export class StartRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: StartRunInput,
    readonly triggeredBy: { kind: "user" | "api-token"; id: string },
  ) {}
}

/**
 * Records the run and hands it to the queue. It does **not** execute anything.
 *
 * That is the whole point of the phase: the caller gets a 202 and an id immediately, and the
 * matrix proceeds in a worker. Closing the browser, losing the connection or a CI job that fires
 * and forgets all leave the run running — none of which was possible when the loop lived in a
 * React component.
 */
@CommandHandler(StartRunCommand)
export class StartRunHandler implements ICommandHandler<StartRunCommand, { runId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: StartRunCommand): Promise<{ runId: string }> {
    const project = await this.projects.findById(command.projectId);
    if (!project || project.organizationId !== command.organizationId) throw new NotFoundError("El proyecto no existe", "project-not-found");
    if (!project.activeSpecVersionId) throw new ConflictError("El proyecto no tiene contrato importado", "no-active-spec");

    const environment = await this.environments.findById(command.input.environmentId);
    // Folded into the 404 as everywhere else: a 403 would confirm the id is real to somebody
    // outside the project.
    if (!environment || environment.projectId !== project.id) throw new NotFoundError("El entorno no existe", "environment-not-found");

    const samples = clamp(command.input.samples ?? 1, 1, 50);
    const delayMs = clamp(command.input.delayMs ?? 0, 0, 30_000);
    if (!Number.isFinite(samples) || !Number.isFinite(delayMs)) throw new InvalidInputError("Plan de ejecución inválido");

    const plan: RunPlan = {
      // Reads first, deletes last, by default. Alphabetical order runs a DELETE before the GET
      // that would have shown the endpoint was already broken, and anything it destroys takes
      // the rest of the matrix with it.
      order: (command.input.order ?? "safe") as OrderMode,
      customOrder: command.input.customOrder ?? [],
      operationIds: command.input.operationIds ?? [],
      caseSelection: command.input.caseSelection ?? {},
      samples,
      delayMs,
    };

    const run: Run = {
      id: randomUUID(),
      projectId: project.id,
      environmentId: environment.id,
      // The snapshot is pinned now. A run is only interpretable next to the contract it was
      // measured against, and activating a new version mid-run must not change what it asserted.
      specVersionId: project.activeSpecVersionId,
      status: "queued",
      plan,
      totals: { cases: 0, completed: 0, passed: 0, failed: 0, skipped: 0 },
      triggeredByKind: command.triggeredBy.kind,
      triggeredBy: command.triggeredBy.id,
      startedAt: this.clock.now(),
      finishedAt: null,
      error: null,
    };

    await this.runs.save(run);
    await this.queue.enqueue(run.id);
    return { runId: run.id };
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
