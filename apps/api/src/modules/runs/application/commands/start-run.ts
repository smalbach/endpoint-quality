import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import type { OrderMode } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
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
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepositoryPort,
    @Inject(RUN_QUEUE) private readonly queue: RunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: StartRunCommand): Promise<{ runId: string }> {
    const project = await this.projects.findById(command.projectId);
    if (!project || project.organizationId !== command.organizationId)
      throw new NotFoundError("El proyecto no existe", "project-not-found");
    if (!project.activeSpecVersionId)
      throw new ConflictError("El proyecto no tiene contrato importado", "no-active-spec");

    const environment = await this.environments.findById(command.input.environmentId);
    // Folded into the 404 as everywhere else: a 403 would confirm the id is real to somebody
    // outside the project.
    if (!environment || environment.projectId !== project.id)
      throw new NotFoundError("El entorno no existe", "environment-not-found");

    // Checked here and not when the worker picks the job up: a flow that does not exist is a
    // mistake in the request, and answering it with a queued run that later lands in `error` puts
    // the message minutes away from the click that caused it.
    if (command.input.workflowId && command.input.suiteId) {
      throw new InvalidInputError("Una corrida ejecuta un flujo o una suite, no las dos cosas", [
        { field: "suiteId", detail: "Quita uno de los dos" },
      ]);
    }
    if (command.input.datasetId && !command.input.workflowId) {
      // A dataset's columns are spent by the steps of one flow. Without the flow there is nothing
      // to walk once per row, and accepting it would queue a run that means nothing.
      throw new InvalidInputError("Un conjunto de datos necesita el flujo que lo recorre", [
        { field: "datasetId", detail: "Indica también workflowId" },
      ]);
    }

    if (command.input.workflowId) {
      const workflow = await this.workflows.findWorkflow(project.id, command.input.workflowId);
      if (!workflow) {
        throw new InvalidInputError(
          "El flujo no existe",
          [{ field: "workflowId", detail: "No hay ningún flujo con ese id en este proyecto" }],
          "workflow-not-found",
        );
      }
      if (command.input.datasetId) {
        const dataset = await this.workflows.findDataset(project.id, command.input.datasetId);
        // Belonging to the flow and not merely to the project: a dataset written for another flow
        // has columns these steps never name, so every row would substitute nothing.
        if (!dataset || dataset.workflowId !== workflow.id) {
          throw new InvalidInputError(
            "El conjunto de datos no es de este flujo",
            [{ field: "datasetId", detail: "No hay ningún conjunto con ese id en este flujo" }],
            "dataset-not-found",
          );
        }
        if (dataset.rows.length === 0) {
          throw new InvalidInputError(
            "El conjunto de datos no tiene filas",
            [{ field: "datasetId", detail: "Una corrida sin filas no ejecutaría nada" }],
            "dataset-empty",
          );
        }
      }
    }

    if (command.input.suiteId) {
      const suite = await this.workflows.findSuite(project.id, command.input.suiteId);
      if (!suite) {
        throw new InvalidInputError(
          "La suite no existe",
          [{ field: "suiteId", detail: "No hay ninguna suite con ese id en este proyecto" }],
          "suite-not-found",
        );
      }
      if (suite.workflowIds.length === 0) {
        throw new InvalidInputError(
          "La suite no tiene flujos",
          [{ field: "suiteId", detail: "Una suite vacía no ejecutaría nada" }],
          "suite-empty",
        );
      }
    }

    const samples = clamp(command.input.samples ?? 1, 1, 50);
    const delayMs = clamp(command.input.delayMs ?? 0, 0, 30_000);
    if (!Number.isFinite(samples) || !Number.isFinite(delayMs))
      throw new InvalidInputError("Plan de ejecución inválido");

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
      ...(command.input.workflowId ? { workflowId: command.input.workflowId } : {}),
      ...(command.input.datasetId ? { datasetId: command.input.datasetId } : {}),
      ...(command.input.suiteId ? { suiteId: command.input.suiteId } : {}),
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
