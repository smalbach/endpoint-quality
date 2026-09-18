import { randomUUID } from "node:crypto";
import { Inject, Optional } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { stepChannelSchema, type OrderMode, type StepChannel } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { ENV, type Env } from "@/shared/config/env";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "@/modules/workflows/domain/ports";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";
import type { Run, RunPlan } from "../../domain/model";
import { RUN_QUEUE, RUN_REPOSITORY, type RunQueuePort, type RunRepositoryPort } from "../../domain/ports";

export type StartRunInput = Partial<RunPlan> & { environmentId: string };

export class StartRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: StartRunInput,
    readonly triggeredBy: { kind: "user" | "api-token" | "monitor"; id: string },
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
    @Inject(ENV) private readonly env: Env,
    // Opcional como en los flujos: sin el módulo de canales, un plan con canal se rechaza en vez de
    // encolarse sin poder comprobar de quién es el canal.
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}

  async execute(command: StartRunCommand): Promise<{ runId: string }> {
    const project = await this.projects.findById(command.projectId);
    if (!project || project.organizationId !== command.organizationId)
      throw new NotFoundError("El proyecto no existe", "project-not-found");
    // Solo lo que lee operaciones necesita el contrato: la matriz, y un flujo con alguna petición
    // guardada o login. Un canal, o un flujo de fetch, GraphQL, mocks, canales y webhooks, corre igual
    // en un proyecto que todavía no lo ha importado.
    if (!project.activeSpecVersionId && (await this.needsContract(project.id, command.input)))
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

    const channel = command.input.channel ? await this.checkedChannel(project.id, command.input) : null;

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

    await this.refuseOversized(project.id, command.input);

    const samples = clamp(command.input.samples ?? 1, 1, 50);
    const delayMs = clamp(command.input.delayMs ?? 0, 0, 30_000);
    if (!Number.isFinite(samples) || !Number.isFinite(delayMs))
      throw new InvalidInputError("Plan de ejecución inválido");
    const pauseMode = command.input.pauseMode ?? "none";
    // A breakpoint run with nothing to stop at is a normal run the person did not mean to start: they
    // asked to stop somewhere and did not say where.
    if (pauseMode === "breakpoints" && !command.input.breakpoints?.length) {
      throw new InvalidInputError(
        "Marca al menos un nodo donde detenerse",
        [{ field: "breakpoints", detail: "El modo «puntos de parada» necesita al menos un nodo" }],
        "breakpoints-empty",
      );
    }

    const plan: RunPlan = {
      // Reads first, deletes last, by default. Alphabetical order runs a DELETE before the GET
      // that would have shown the endpoint was already broken, and anything it destroys takes
      // the rest of the matrix with it.
      order: (command.input.order ?? "safe") as OrderMode,
      customOrder: command.input.customOrder ?? [],
      operationIds: command.input.operationIds ?? [],
      labels: command.input.labels ?? [],
      caseSelection: command.input.caseSelection ?? {},
      samples,
      delayMs,
      concurrency: clamp(command.input.concurrency ?? 1, 1, 10),
      ...(command.input.workflowId ? { workflowId: command.input.workflowId } : {}),
      ...(command.input.datasetId ? { datasetId: command.input.datasetId } : {}),
      ...(command.input.suiteId ? { suiteId: command.input.suiteId } : {}),
      ...(channel ? { channel } : {}),
      ...(pauseMode !== "none" ? { pauseMode } : {}),
      ...(pauseMode === "breakpoints" ? { breakpoints: [...new Set(command.input.breakpoints ?? [])] } : {}),
      ...(command.input.stopOnFailure ? { stopOnFailure: true } : {}),
    };

    const run: Run = {
      id: randomUUID(),
      projectId: project.id,
      environmentId: environment.id,
      // The snapshot is pinned now. A run is only interpretable next to the contract it was
      // measured against, and activating a new version mid-run must not change what it asserted.
      specVersionId: project.activeSpecVersionId ?? null,
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

  /**
   * El canal de un plan sin flujo, comprobado como el de un nodo `channel` al guardar un flujo.
   *
   * La forma con el mismo esquema que el nodo —el guion no cambia de reglas por venir de un
   * monitor— y el canal leído con el id del proyecto, así que el de otro proyecto y uno borrado son
   * el mismo 422. Se comprueba aquí y no al recoger el trabajo por lo mismo que el flujo: el error
   * tiene que salir en la respuesta al clic, no minutos después en una corrida en `error`.
   */
  private async checkedChannel(projectId: string, input: StartRunInput): Promise<StepChannel> {
    if (input.workflowId || input.suiteId || input.datasetId) {
      throw new InvalidInputError("Una corrida ejecuta un canal, un flujo o una suite, no varios", [
        { field: "channel", detail: "Quita el flujo, la suite o el conjunto de datos" },
      ]);
    }
    const parsed = stepChannelSchema.safeParse(input.channel);
    if (!parsed.success) {
      throw new InvalidInputError(
        "El canal del plan no es válido",
        parsed.error.issues.map((issue) => ({
          field: ["channel", ...issue.path].join("."),
          detail: issue.message,
        })),
        "channel-invalid",
      );
    }
    const channel = this.channels ? await this.channels.findById(projectId, parsed.data.channelId) : null;
    if (!channel) {
      throw new InvalidInputError(
        "El canal no existe",
        [{ field: "channel.channelId", detail: "No hay ningún canal con ese id en este proyecto" }],
        "channel-not-found",
      );
    }
    return parsed.data as StepChannel;
  }

  /**
   * Si el plan lee alguna operación del contrato.
   *
   * La matriz, siempre: es el contrato recorrido. Un canal, nunca. Un flujo o una suite, cuando algún
   * nodo es una petición guardada o un login —lo único que se resuelve contra una operación—, mirando
   * también dentro de los sub-flujos que ejecutan, que corren con el mismo contexto. Un sub-flujo que
   * no existe no cuenta: ese error lo da la corrida, como hasta ahora.
   */
  private async needsContract(projectId: string, input: StartRunInput): Promise<boolean> {
    if (input.channel) return false;
    const pending = input.suiteId
      ? [...((await this.workflows.findSuite(projectId, input.suiteId))?.workflowIds ?? [])]
      : input.workflowId
        ? [input.workflowId]
        : null;
    if (!pending) return true;
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const workflow = await this.workflows.findWorkflow(projectId, id);
      for (const step of workflow?.definition.steps ?? []) {
        const kind = step.kind ?? "request";
        if (kind === "request" || kind === "login") return true;
        if (kind === "subflow" && step.subflow?.workflowId) pending.push(step.subflow.workflowId);
      }
    }
    return false;
  }

  /**
   * The half of the size that is arithmetic, refused before anything is queued.
   *
   * Rows times flows times steps is known here, and a run that would produce a hundred thousand
   * requests against somebody's staging environment is not a suite anybody meant to start. Saying
   * so at the click is the difference between a 422 naming the field and a run that has to be
   * cancelled once its effects are already in the target.
   *
   * The other half — how long a loop turns out to be — belongs to the walk, because only the
   * target knows it.
   */
  private async refuseOversized(projectId: string, input: StartRunCommand["input"]): Promise<void> {
    const ids = input.suiteId
      ? ((await this.workflows.findSuite(projectId, input.suiteId))?.workflowIds ?? [])
      : input.workflowId
        ? [input.workflowId]
        : [];
    if (!ids.length) return;

    let steps = 0;
    for (const id of ids) steps += (await this.workflows.findWorkflow(projectId, id))?.definition.steps.length ?? 0;
    const rows = input.datasetId
      ? ((await this.workflows.findDataset(projectId, input.datasetId))?.rows.length ?? 1)
      : 1;

    const cases = steps * rows;
    if (cases > this.env.MAX_RUN_CASES) {
      throw new InvalidInputError(
        `Esta corrida generaría ${cases} casos y el tope es ${this.env.MAX_RUN_CASES}`,
        [
          {
            field: input.datasetId ? "datasetId" : input.suiteId ? "suiteId" : "workflowId",
            detail: `${steps} pasos × ${rows} filas`,
          },
        ],
        "run-too-large",
      );
    }
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
