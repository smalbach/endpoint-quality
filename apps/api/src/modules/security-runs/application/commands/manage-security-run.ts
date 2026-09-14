import { randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import { normalizeSelection, type RuleKey } from "@eq/security-rules";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import type { SecurityRun, SecurityRunOptions, SecurityRunVisibility } from "../../domain/model";
import {
  SECURITY_RUN_QUEUE,
  SECURITY_RUN_REPOSITORY,
  type SecurityRunQueuePort,
  type SecurityRunRepositoryPort,
} from "../../domain/ports";

export type StartSecurityRunInput = {
  environmentId?: string;
  label?: string;
  rules?: Partial<Record<RuleKey, boolean>>;
  rateLimitIterations?: number;
  requestTimeoutMs?: number;
  crossUserPermutations?: boolean;
  endpointIds?: string[];
  adminRole?: string | null;
};

export class StartSecurityRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly input: StartSecurityRunInput,
    readonly triggeredBy: { kind: "user" | "api-token"; id: string },
  ) {}
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number) =>
  value === undefined ? fallback : Math.min(max, Math.max(min, Math.trunc(value)));

@CommandHandler(StartSecurityRunCommand)
export class StartSecurityRunHandler implements ICommandHandler<StartSecurityRunCommand, { runId: string }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
    @Inject(SECURITY_RUN_QUEUE) private readonly queue: SecurityRunQueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: StartSecurityRunCommand): Promise<{ runId: string }> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const environmentId = command.input.environmentId ?? project.activeEnvironmentId;
    if (!environmentId)
      throw new InvalidInputError(
        "Hace falta un entorno",
        [{ field: "environmentId", detail: "Elige un entorno con URL base" }],
        "environment-required",
      );
    const environment = await this.environments.findById(environmentId);
    if (!environment || environment.projectId !== project.id)
      throw new NotFoundError("El entorno no existe", "environment-not-found");

    const options: SecurityRunOptions = {
      rateLimitIterations: clamp(command.input.rateLimitIterations, 5, 50, 20),
      requestTimeoutMs: clamp(command.input.requestTimeoutMs, 1000, 30000, 10000),
      crossUserPermutations: command.input.crossUserPermutations ?? false,
      endpointIds: command.input.endpointIds ?? [],
      adminRole: command.input.adminRole ?? null,
    };

    const now = this.clock.now();
    const run: SecurityRun = {
      id: randomUUID(),
      projectId: project.id,
      environmentId: environment.id,
      label: (command.input.label ?? "").trim() || `Corrida ${now.toLocaleDateString("es")}`,
      status: "queued",
      rules: normalizeSelection(command.input.rules),
      options,
      progress: { phase: "En cola", percentage: 0, detail: "", endpointsTested: 0, endpointsTotal: 0 },
      score: null,
      risk: null,
      summary: null,
      findings: [],
      probes: [],
      ai: null,
      visibility: "private",
      shareToken: null,
      triggeredByKind: command.triggeredBy.kind,
      triggeredBy: command.triggeredBy.id,
      startedAt: now,
      finishedAt: null,
      error: null,
    };
    await this.runs.save(run);
    await this.queue.enqueue(run.id);
    return { runId: run.id };
  }
}

export class CancelSecurityRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

@CommandHandler(CancelSecurityRunCommand)
export class CancelSecurityRunHandler implements ICommandHandler<CancelSecurityRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
    @Inject(SECURITY_RUN_QUEUE) private readonly queue: SecurityRunQueuePort,
  ) {}

  async execute(command: CancelSecurityRunCommand): Promise<void> {
    const run = await owned(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    if (run.status === "queued" || run.status === "running") await this.queue.cancel(run.id);
  }
}

export class DeleteSecurityRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

@CommandHandler(DeleteSecurityRunCommand)
export class DeleteSecurityRunHandler implements ICommandHandler<DeleteSecurityRunCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
  ) {}

  async execute(command: DeleteSecurityRunCommand): Promise<void> {
    const run = await owned(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    if (run.status === "running" || run.status === "queued")
      throw new ConflictError("Una corrida en curso no se puede borrar; cáncelala antes", "run-in-progress");
    await this.runs.remove(run.id);
  }
}

export class SetSecurityRunVisibilityCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
    readonly visibility: SecurityRunVisibility,
  ) {}
}

@CommandHandler(SetSecurityRunVisibilityCommand)
export class SetSecurityRunVisibilityHandler implements ICommandHandler<
  SetSecurityRunVisibilityCommand,
  { visibility: SecurityRunVisibility; shareToken: string | null }
> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
  ) {}

  async execute(command: SetSecurityRunVisibilityCommand) {
    const run = await owned(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    // A token is minted once and kept: turning a run private and public again must not break a link
    // somebody already pasted somewhere unless they ask, which is a future «revocar».
    const shareToken = command.visibility === "public" ? (run.shareToken ?? randomUUID()) : run.shareToken;
    await this.runs.save({ ...run, visibility: command.visibility, shareToken });
    return { visibility: command.visibility, shareToken: command.visibility === "public" ? shareToken : null };
  }
}

export async function owned(
  projects: ProjectRepositoryPort,
  runs: SecurityRunRepositoryPort,
  organizationId: string,
  projectId: string,
  runId: string,
): Promise<SecurityRun> {
  await ownedProject(projects, organizationId, projectId);
  const run = await runs.findById(runId);
  if (!run || run.projectId !== projectId) throw new NotFoundError("La corrida no existe", "security-run-not-found");
  return run;
}
