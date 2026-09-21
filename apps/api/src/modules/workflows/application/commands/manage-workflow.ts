import { randomUUID } from "node:crypto";
import { Inject, Optional } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { safeParseWorkflowDocument, subflowProblems, subflowSteps, type WorkflowDocument } from "@eq/runner-core";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { WorkflowRow, WorkflowStatus } from "../../domain/model";
import { WORKFLOW_REPOSITORY, type WorkflowRepositoryPort } from "../../domain/ports";
import { withoutLiteralSecrets } from "../../domain/postman-auth";
import { CHANNEL_REPOSITORY, type ChannelRepositoryPort } from "@/modules/channels/domain/ports";

export type WorkflowInput = {
  name?: string;
  description?: string | null;
  status?: WorkflowStatus;
  definition?: WorkflowDocument;
};

export class CreateWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: WorkflowInput,
    readonly actorId: string,
  ) {}
}
export class UpdateWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
    readonly input: WorkflowInput,
    readonly actorId: string,
  ) {}
}
/**
 * Borrar un flujo: **blando por defecto**, definitivo con `purge`.
 *
 * Archivar un flujo no está aquí: es su `status`, y se cambia con `UpdateWorkflowCommand`. Una
 * segunda puerta que hiciera lo mismo dejaría dos formas de archivar y ninguna de las dos completa.
 */
export class DeleteWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
    readonly purge = false,
  ) {}
}

/** Restaurar un flujo eliminado, con sus conjuntos de datos. */
export class RestoreWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
  ) {}
}
export class DuplicateWorkflowCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly workflowId: string,
    readonly actorId: string,
  ) {}
}

/** «Nombre», «Nombre (copia)», «Nombre (copia 2)»… — the first free one, so a second duplicate of
 * the same flow does not collide with the first. */
async function freeCopyName(workflows: WorkflowRepositoryPort, projectId: string, base: string): Promise<string> {
  const candidates = [`${base} (copia)`, ...Array.from({ length: 98 }, (_, index) => `${base} (copia ${index + 2})`)];
  for (const candidate of candidates) {
    const fits = candidate.length <= 120 && !(await workflows.findWorkflowByName(projectId, candidate));
    if (fits) return candidate;
  }
  // A name nobody chose is better than refusing to duplicate: unique by construction.
  return `${base.slice(0, 100)} ${randomUUID().slice(0, 8)}`;
}

export async function ownedWorkflow(
  projects: ProjectRepositoryPort,
  workflows: WorkflowRepositoryPort,
  organizationId: string,
  projectId: string,
  workflowId: string,
): Promise<WorkflowRow> {
  await ownedProject(projects, organizationId, projectId);
  const workflow = await workflows.findWorkflow(projectId, workflowId);
  if (!workflow) throw new NotFoundError("El flujo no existe", "workflow-not-found");
  return workflow;
}

/**
 * Two checks, because they answer different questions and only one of them fits in a schema.
 *
 * The engine's zod says the graph is *well formed*: unique ids, every edge pointing at a step that
 * is there, no cycle. Whether a step names a request of **this** project spans two tables, so it
 * is a query — and it has to be, because the alternative is a run that dies on its third case
 * naming an id nobody recognises.
 */
async function validatedDefinition(
  workflows: WorkflowRepositoryPort,
  projectId: string,
  definition: WorkflowDocument,
  /** The flow being saved: its id closes a subflow cycle, its name says where one goes. */
  self: { id?: string; name?: string } = {},
  channels: ChannelRepositoryPort | null = null,
): Promise<WorkflowDocument> {
  const parsed = safeParseWorkflowDocument(definition);
  if (!parsed.ok) throw new InvalidInputError("El flujo no es válido", parsed.issues, "workflow-invalid");

  const known = new Set((await workflows.listTemplates(projectId)).map((template) => template.id));
  const missing = definition.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.requestTemplateId !== undefined && !known.has(step.requestTemplateId));
  if (missing.length) {
    throw new InvalidInputError(
      "El flujo no es válido",
      missing.map(({ step, index }) => ({
        field: `definition.steps.${index}.requestTemplateId`,
        detail: `la prueba ${step.requestTemplateId} no existe en este proyecto`,
      })),
      "workflow-invalid",
    );
  }

  // A subflow names another row, so what it may point at is a query too: this project's flows, and
  // not an archived one, a cycle back to this flow, or a chain deeper than a report can be read at.
  if (subflowSteps(definition).length) {
    const flows = new Map((await workflows.listWorkflows(projectId)).map((flow) => [flow.id, flow]));
    const problems = subflowProblems({ ...self, definition }, (id) => flows.get(id));
    if (problems.length) {
      throw new InvalidInputError(
        "El flujo no es válido",
        problems.map((problem) => ({
          field: `definition.steps.${problem.stepIndex}.subflow.workflowId`,
          detail: problem.detail,
        })),
        "workflow-invalid",
      );
    }
  }
  // A channel node names a channel row, so the same holds: one of this project's, not deleted. Checked
  // here and not only at run time, where the same mistake would be a red case every night.
  await refuseUnknownChannels(channels, projectId, definition);
  return withoutLiteralSecrets(definition);
}

/**
 * El 422 de un nodo `channel` que nombra un canal que no es de este proyecto (o que se borró).
 *
 * Aparte de `validatedDefinition` porque también lo usa duplicar, que no revalida el resto: la copia
 * es del mismo proyecto y lo demás ya se comprobó al guardar el original, pero un canal se puede
 * borrar después sin tocar el flujo, y la copia nacería rota sin que nadie lo hubiera pedido.
 */
export async function refuseUnknownChannels(
  channels: ChannelRepositoryPort | null,
  projectId: string,
  definition: WorkflowDocument,
): Promise<void> {
  const channelSteps = definition.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.kind === "channel" && step.channel);
  if (!channelSteps.length || !channels) return;
  const known = new Set((await channels.listByProject(projectId)).map((channel) => channel.id));
  const unknown = channelSteps.filter(({ step }) => !known.has(step.channel!.channelId));
  if (unknown.length) {
    throw new InvalidInputError(
      "El flujo no es válido",
      unknown.map(({ index }) => ({
        field: `definition.steps.${index}.channel.channelId`,
        detail: "el canal no existe en este proyecto",
      })),
      "workflow-invalid",
    );
  }
}


@CommandHandler(CreateWorkflowCommand)
export class CreateWorkflowHandler implements ICommandHandler<CreateWorkflowCommand, { workflowId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    // Optional so a module without channels still saves flows; with it, a channel node is checked.
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}

  async execute(command: CreateWorkflowCommand): Promise<{ workflowId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name) {
      throw new InvalidInputError(
        "El flujo necesita un nombre",
        [{ field: "name", detail: "Escriba un nombre" }],
        "workflow-invalid",
      );
    }
    if (await this.workflows.findWorkflowByName(command.projectId, name)) {
      throw new ConflictError("Ya existe un flujo con ese nombre", "workflow-name-taken");
    }
    const definition = await validatedDefinition(
      this.workflows,
      command.projectId,
      command.input.definition ?? { steps: [] },
      { name },
      this.channels,
    );
    const now = this.clock.now();
    const workflowId = randomUUID();
    await this.workflows.saveWorkflow({
      id: workflowId,
      projectId: command.projectId,
      name,
      description: command.input.description || null,
      // A new flow is a draft: its edges are still moving and no suite should pick it up yet. The
      // one place «draft» is decided, so the column can go on defaulting existing rows to «ready».
      status: command.input.status ?? "draft",
      definition,
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
      deletedAt: null,
    });
    return { workflowId };
  }
}

@CommandHandler(UpdateWorkflowCommand)
export class UpdateWorkflowHandler implements ICommandHandler<UpdateWorkflowCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    // Optional so a module without channels still saves flows; with it, a channel node is checked.
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}

  async execute(command: UpdateWorkflowCommand): Promise<void> {
    const previous = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    const name = (command.input.name ?? previous.name).trim();
    const clash = await this.workflows.findWorkflowByName(command.projectId, name);
    if (clash && clash.id !== previous.id) {
      throw new ConflictError("Ya existe un flujo con ese nombre", "workflow-name-taken");
    }
    // The whole graph or nothing: a partial write of a document whose halves reference each other
    // is the state this shape exists to make impossible.
    const definition = command.input.definition
      ? await validatedDefinition(
          this.workflows,
          command.projectId,
          command.input.definition,
          { id: previous.id, name },
          this.channels,
        )
      : previous.definition;
    await this.workflows.saveWorkflow({
      ...previous,
      name,
      description: command.input.description === undefined ? previous.description : command.input.description || null,
      status: command.input.status ?? previous.status,
      definition,
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }
}

@CommandHandler(DeleteWorkflowCommand)
export class DeleteWorkflowHandler implements ICommandHandler<DeleteWorkflowCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * Borrar un flujo **sin perder el grafo**.
   *
   * Lo que se iba con un clic era un documento con sus nodos, sus aristas, sus capturas y sus
   * comprobaciones, más las tablas de datos que se gastan en él. Ahora sale de la lista y vuelve
   * entero desde el filtro de eliminados.
   *
   * Las referencias siguen siendo un 409, **también en el borrado blando**: una suite que nombra
   * este flujo o otro que lo ejecuta como sub-flujo se romperían igual si el flujo desaparece de
   * las listas, y cambiar lo que ejecuta una suite en nombre de quien borra no es deshacer nada.
   */
  async execute(command: DeleteWorkflowCommand): Promise<void> {
    const workflow = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    if (!workflow.deletedAt) {
      // The same answer this product gives for a template a flow uses: a reference is a decision
      // somebody made, and removing it on their behalf changes what a suite runs without saying so.
      if (await this.workflows.isWorkflowReferenced(command.projectId, workflow.id))
        throw new ConflictError("Alguna suite usa este flujo", "workflow-in-use");
      // A flow another one runs as a subflow is a reference too — deleting it would turn that flow's
      // next run into an error naming an id nobody recognises.
      const parents = (await this.workflows.listWorkflows(command.projectId)).filter((other) =>
        subflowSteps(other.definition).some(({ step }) => step.subflow.workflowId === workflow.id),
      );
      if (parents.length)
        throw new ConflictError(`«${parents[0].name}» usa este flujo como sub-flujo`, "workflow-in-use");
    }

    if (command.purge) {
      if (!workflow.deletedAt)
        throw new ConflictError("Elimina el flujo antes de borrarlo para siempre", "workflow-not-deleted");
      // Sus conjuntos de datos se van con él, por la cascada de la migración: una tabla de valores
      // para un flujo que ya no existe son filas que nada podrá gastar.
      await this.workflows.deleteWorkflow(command.projectId, workflow.id);
      return;
    }
    if (workflow.deletedAt) return;

    const now = this.clock.now();
    await this.workflows.saveWorkflow({ ...workflow, deletedAt: now, updatedAt: now });
    // Lo que en Postgres hace la cascada al borrar de verdad, aquí lo hace el borrado blando: los
    // conjuntos del flujo se van con él. Una tabla de valores sin los pasos que la gastan no es
    // nada, y dejarla viva la haría aparecer en la papelera de un flujo que ya no está.
    for (const dataset of await this.workflows.listDatasets(command.projectId))
      if (dataset.workflowId === workflow.id)
        await this.workflows.saveDataset({ ...dataset, deletedAt: now, updatedAt: now });
  }
}

/**
 * Restaurar un flujo eliminado, con **todos** sus conjuntos de datos.
 *
 * Todos y no «los que se fueron con él»: distinguirlos pedía comparar la fecha de borrado, y dos
 * borrados del mismo segundo son indistinguibles —el reloj de una prueba está parado, y en
 * producción dos operaciones seguidas caen en el mismo milisegundo más a menudo de lo que parece—.
 * Así que la regla es la que se puede explicar en una frase: el flujo vuelve con sus datos. Si
 * alguien había borrado uno a propósito, vuelve a borrarlo; es un clic, y es visible.
 */
@CommandHandler(RestoreWorkflowCommand)
export class RestoreWorkflowHandler implements ICommandHandler<RestoreWorkflowCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestoreWorkflowCommand): Promise<void> {
    const workflow = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    if (!workflow.deletedAt) return;
    // El nombre pudo reutilizarse mientras estaba fuera: el índice único es parcial desde
    // `ArchiveAndSoftDelete1700000042000`, así que esto es un 409 y no un error de Postgres.
    if (await this.workflows.findWorkflowByName(command.projectId, workflow.name))
      throw new ConflictError("Ya hay un flujo con ese nombre", "workflow-name-taken");

    const now = this.clock.now();
    await this.workflows.saveWorkflow({ ...workflow, deletedAt: null, updatedAt: now });
    for (const dataset of await this.workflows.listDatasets(command.projectId, "deleted"))
      if (dataset.workflowId === workflow.id)
        await this.workflows.saveDataset({ ...dataset, deletedAt: null, updatedAt: now });
  }
}

/**
 * A copy of a flow, its graph and its datasets — a draft, under a free «(copia)» name.
 *
 * The graph copies verbatim: the step ids stay, because they are only unique within a document and
 * the edges between them are what a duplicate is *for*. The datasets come too — a table of values
 * means nothing away from the steps that spend it, so a copy without them is a flow that runs
 * against no data. The copy starts as a draft on purpose: it is not the tested one, and letting it
 * inherit «ready» would put an unreviewed flow into the pickers that build a suite.
 */
@CommandHandler(DuplicateWorkflowCommand)
export class DuplicateWorkflowHandler implements ICommandHandler<DuplicateWorkflowCommand, { workflowId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() @Inject(CHANNEL_REPOSITORY) private readonly channels: ChannelRepositoryPort | null = null,
  ) {}

  async execute(command: DuplicateWorkflowCommand): Promise<{ workflowId: string }> {
    const source = await ownedWorkflow(
      this.projects,
      this.workflows,
      command.organizationId,
      command.projectId,
      command.workflowId,
    );
    await refuseUnknownChannels(this.channels, command.projectId, source.definition);
    const now = this.clock.now();
    const workflowId = randomUUID();
    await this.workflows.saveWorkflow({
      id: workflowId,
      projectId: command.projectId,
      name: await freeCopyName(this.workflows, command.projectId, source.name),
      description: source.description,
      status: "draft",
      definition: { steps: source.definition.steps.map((step) => ({ ...step })) },
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
      deletedAt: null,
    });
    const datasets = (await this.workflows.listDatasets(command.projectId)).filter(
      (dataset) => dataset.workflowId === source.id,
    );
    for (const dataset of datasets) {
      await this.workflows.saveDataset({
        id: randomUUID(),
        projectId: command.projectId,
        workflowId,
        name: dataset.name,
        rows: dataset.rows.map((row) => ({ ...row })),
        createdAt: now,
        updatedAt: now,
        updatedBy: command.actorId,
        archivedAt: null,
        deletedAt: null,
      });
    }
    return { workflowId };
  }
}
