import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";

import { ConflictError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import type { SecurityRunAi } from "../../domain/model";
import { SECURITY_AI, type SecurityAiPort } from "../../domain/ai";
import { SECURITY_RUN_REPOSITORY, type SecurityRunRepositoryPort } from "../../domain/ports";
import { owned } from "./manage-security-run";

export class AnalyzeSecurityRunCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

/**
 * Writes the run's analysis, on demand and cached on the row.
 *
 * On demand, not inline: the analyzer ran the model in the middle of the pipeline, so every run
 * waited on it and paid for it whether anybody read it. Here a finished run already has its score
 * and findings, and «Analizar» is a separate click that fills `ai`. Cached, so the second reader
 * does not pay again — a re-analysis is just calling it once more.
 */
@CommandHandler(AnalyzeSecurityRunCommand)
export class AnalyzeSecurityRunHandler implements ICommandHandler<AnalyzeSecurityRunCommand, { ai: SecurityRunAi }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
    @Inject(SECURITY_AI) private readonly ai: SecurityAiPort,
  ) {}

  async execute(command: AnalyzeSecurityRunCommand): Promise<{ ai: SecurityRunAi }> {
    const run = await owned(this.projects, this.runs, command.organizationId, command.projectId, command.runId);
    if (run.status === "queued" || run.status === "running")
      throw new ConflictError("La corrida aún no ha terminado", "run-in-progress");
    const ai = await this.ai.analyze(run);
    await this.runs.save({ ...run, ai });
    return { ai };
  }
}
