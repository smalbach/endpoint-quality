import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import {
  archiveIn,
  deleteIn,
  restoreIn,
  type LifecycleNoun,
  type LifecycleStore,
} from "@/shared/lifecycle/lifecycle-store";
import type { PerformancePlanDefinition, PerformancePlanRow } from "../../domain/model";
import { safeParsePlanDefinition } from "../../domain/plan-schema";
import { PERFORMANCE_PLAN_REPOSITORY, type PerformancePlanRepositoryPort } from "../../domain/ports";

export type PlanInput = {
  name?: string;
  description?: string | null;
  definition?: PerformancePlanDefinition;
};

const EMPTY_DEFINITION: PerformancePlanDefinition = {
  scenarios: [],
  profile: { type: "constant", vus: 1, durationS: 30 },
  thresholds: {},
};

export class CreatePlanCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: PlanInput,
    readonly actorId: string,
  ) {}
}
export class UpdatePlanCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string,
    readonly input: PlanInput,
    readonly actorId: string,
  ) {}
}
/** Borrar un plan: blando por defecto, definitivo con `purge` y solo sobre algo ya eliminado. */
export class DeletePlanCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string,
    readonly purge = false,
  ) {}
}

/** Archivar un plan: fuera de la lista, y sus corridas pasadas siguen donde estaban. */
export class SetPlanArchivedCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string,
    readonly archived: boolean,
  ) {}
}

/** Restaurar un plan eliminado. Vuelve a los archivados si es de donde salió. */
export class RestorePlanCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly planId: string,
  ) {}
}

export async function ownedPlan(
  projects: ProjectRepositoryPort,
  plans: PerformancePlanRepositoryPort,
  organizationId: string,
  projectId: string,
  planId: string,
): Promise<PerformancePlanRow> {
  await ownedProject(projects, organizationId, projectId);
  const plan = await plans.find(projectId, planId);
  if (!plan) throw new NotFoundError("El plan no existe", "performance-plan-not-found");
  return plan;
}

/** A definition is well formed *and* has something to run: an empty plan is allowed to be saved as a
 * draft, but it is validated the moment it has scenarios. */
function validated(definition: PerformancePlanDefinition): PerformancePlanDefinition {
  if (!definition.scenarios.length) return definition;
  const parsed = safeParsePlanDefinition(definition);
  if (!parsed.ok) throw new InvalidInputError("El plan no es válido", parsed.issues, "performance-plan-invalid");
  return definition;
}

@CommandHandler(CreatePlanCommand)
export class CreatePlanHandler implements ICommandHandler<CreatePlanCommand, { planId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: CreatePlanCommand): Promise<{ planId: string }> {
    await ownedProject(this.projects, command.organizationId, command.projectId);
    const name = (command.input.name ?? "").trim();
    if (!name)
      throw new InvalidInputError(
        "El plan necesita un nombre",
        [{ field: "name", detail: "Escriba un nombre" }],
        "performance-plan-invalid",
      );
    if (await this.plans.findByName(command.projectId, name))
      throw new ConflictError("Ya existe un plan con ese nombre", "performance-plan-name-taken");
    const definition = validated(command.input.definition ?? EMPTY_DEFINITION);
    const now = this.clock.now();
    const planId = randomUUID();
    await this.plans.save({
      id: planId,
      projectId: command.projectId,
      name,
      description: command.input.description || null,
      definition,
      createdAt: now,
      updatedAt: now,
      updatedBy: command.actorId,
      archivedAt: null,
      deletedAt: null,
    });
    return { planId };
  }
}

@CommandHandler(UpdatePlanCommand)
export class UpdatePlanHandler implements ICommandHandler<UpdatePlanCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: UpdatePlanCommand): Promise<void> {
    const previous = await ownedPlan(
      this.projects,
      this.plans,
      command.organizationId,
      command.projectId,
      command.planId,
    );
    const name = (command.input.name ?? previous.name).trim();
    const clash = await this.plans.findByName(command.projectId, name);
    if (clash && clash.id !== previous.id)
      throw new ConflictError("Ya existe un plan con ese nombre", "performance-plan-name-taken");
    const definition = command.input.definition ? validated(command.input.definition) : previous.definition;
    await this.plans.save({
      ...previous,
      name,
      description: command.input.description === undefined ? previous.description : command.input.description || null,
      definition,
      updatedAt: this.clock.now(),
      updatedBy: command.actorId,
    });
  }
}

/** Cómo se llama esto en los errores del ciclo de vida. */
const PLAN: LifecycleNoun = { code: "performance-plan", that: "El plan", the: "el plan" };

/**
 * El almacén de planes, con la forma que espera el servicio de ciclo de vida.
 *
 * `remove` devuelve `true` sin mirar nada porque el servicio ya encontró la fila antes de pedirlo:
 * el puerto de planes borra con `delete` y no dice cuántas filas se llevó, y fingir aquí un
 * recuento que no existe sería peor que decir que sí.
 */
const planStore = (plans: PerformancePlanRepositoryPort): LifecycleStore<PerformancePlanRow> => ({
  findById: (projectId, id) => plans.find(projectId, id),
  save: (row) => plans.save(row),
  remove: async (projectId, id) => {
    await plans.delete(projectId, id);
    return true;
  },
});

const touch = (row: PerformancePlanRow, now: Date): PerformancePlanRow => ({ ...row, updatedAt: now });

/**
 * Borrar un plan **sin llevarse lo que midió**.
 *
 * Las corridas ya sobrevivían al borrado —cada una guarda el plan como era, así que su historia no
 * dependía de la fila—, pero el plan en sí se iba para siempre: un documento con escenarios,
 * umbrales y un perfil de carga que alguien afinó a lo largo de semanas. Ahora sale de la lista y
 * vuelve entero desde el filtro de eliminados.
 */
@CommandHandler(DeletePlanCommand)
export class DeletePlanHandler implements ICommandHandler<DeletePlanCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: DeletePlanCommand): Promise<void> {
    const plan = await ownedPlan(this.projects, this.plans, command.organizationId, command.projectId, command.planId);
    // Las corridas se quedan: cada una lleva el plan como era, así que la historia de un plan vive
    // más que el plan. `planId` queda colgando a propósito —no hay clave ajena— y la lista de
    // corridas sigue leyendo por él.
    await deleteIn(planStore(this.plans), command.projectId, plan.id, command.purge, this.clock.now(), PLAN, {
      patch: touch,
    });
  }
}

@CommandHandler(SetPlanArchivedCommand)
export class SetPlanArchivedHandler implements ICommandHandler<SetPlanArchivedCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetPlanArchivedCommand): Promise<void> {
    const plan = await ownedPlan(this.projects, this.plans, command.organizationId, command.projectId, command.planId);
    await archiveIn(
      planStore(this.plans),
      command.projectId,
      plan.id,
      command.archived,
      this.clock.now(),
      PLAN,
      { patch: touch },
    );
  }
}

/**
 * Restaurar un plan eliminado.
 *
 * El nombre puede haberse reutilizado mientras estaba fuera —`findByName` solo mira los vivos—, y
 * eso es un 409: renombrarlo por su cuenta sería decidir por quien restaura.
 */
@CommandHandler(RestorePlanCommand)
export class RestorePlanHandler implements ICommandHandler<RestorePlanCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: RestorePlanCommand): Promise<void> {
    const plan = await ownedPlan(this.projects, this.plans, command.organizationId, command.projectId, command.planId);
    if (plan.deletedAt && (await this.plans.findByName(command.projectId, plan.name)))
      throw new ConflictError("Ya existe un plan con ese nombre", "performance-plan-name-taken");
    await restoreIn(planStore(this.plans), command.projectId, plan.id, this.clock.now(), PLAN, { patch: touch });
  }
}
