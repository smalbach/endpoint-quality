import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
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
export class DeletePlanCommand implements ICommand {
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

@CommandHandler(DeletePlanCommand)
export class DeletePlanHandler implements ICommandHandler<DeletePlanCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(PERFORMANCE_PLAN_REPOSITORY) private readonly plans: PerformancePlanRepositoryPort,
  ) {}

  async execute(command: DeletePlanCommand): Promise<void> {
    const plan = await ownedPlan(this.projects, this.plans, command.organizationId, command.projectId, command.planId);
    // The runs stay: they snapshot the plan, so a plan's history outlives the plan. `planId` is left
    // dangling on purpose — there is no FK — and the run list still reads by it.
    await this.plans.delete(command.projectId, plan.id);
  }
}
