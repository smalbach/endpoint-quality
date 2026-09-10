import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { RunCaseEntity, RunEntity, RunStepEntity } from "@/shared/database/entities";
import type { CaseStatus, Run, RunCase, RunPlan, RunStatus, RunStep, RunTotals } from "../../domain/model";
import type { RunRepositoryPort } from "../../domain/ports";

@Injectable()
export class TypeOrmRunRepository implements RunRepositoryPort {
  constructor(
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(RunCaseEntity) private readonly cases: Repository<RunCaseEntity>,
    @InjectRepository(RunStepEntity) private readonly steps: Repository<RunStepEntity>,
  ) {}

  async findById(id: string): Promise<Run | null> {
    return toRun(await this.runs.findOne({ where: { id } }));
  }
  async listForProject(projectId: string, limit: number): Promise<Run[]> {
    return (await this.runs.find({ where: { projectId }, order: { startedAt: "DESC" }, take: limit })).map((row) => toRun(row)!);
  }
  async save(run: Run): Promise<void> {
    await this.runs.save(run as unknown as RunEntity);
  }
  async saveCases(cases: RunCase[]): Promise<void> {
    // Chunked: a 311-case matrix in one statement is fine, a contract with thousands of
    // operations is not, and the driver's parameter limit is not a number worth discovering in
    // production.
    if (cases.length) await this.cases.save(cases as unknown as RunCaseEntity[], { chunk: 200 });
  }
  async listCases(runId: string): Promise<RunCase[]> {
    return (await this.cases.find({ where: { runId }, order: { position: "ASC" } })).map(toCase);
  }
  async findCase(id: string): Promise<RunCase | null> {
    const row = await this.cases.findOne({ where: { id } });
    return row ? toCase(row) : null;
  }
  async saveCase(runCase: RunCase): Promise<void> {
    await this.cases.save(runCase as unknown as RunCaseEntity);
  }
  async saveSteps(steps: RunStep[]): Promise<void> {
    if (steps.length) await this.steps.save(steps as unknown as RunStepEntity[], { chunk: 100 });
  }
  async listSteps(runCaseId: string): Promise<RunStep[]> {
    return (await this.steps.find({ where: { runCaseId }, order: { index: "ASC" } })).map((row) => ({ ...row }));
  }

  /**
   * Counted in SQL, from the case rows.
   *
   * Not incremented in memory: a worker that restarts mid-run would lose the count, and two
   * workers would each add one. The rows are the truth and this reads them.
   */
  async recomputeTotals(runId: string): Promise<RunTotals> {
    const rows: { status: CaseStatus; count: string }[] = await this.cases
      .createQueryBuilder("c")
      .select("c.status", "status")
      .addSelect("COUNT(*)", "count")
      .where("c.runId = :runId", { runId })
      .groupBy("c.status")
      .getRawMany();

    const by = (status: CaseStatus) => Number(rows.find((row) => row.status === status)?.count ?? 0);
    const totals: RunTotals = {
      cases: rows.reduce((sum, row) => sum + Number(row.count), 0),
      passed: by("passed"),
      failed: by("failed"),
      skipped: by("skipped"),
      completed: by("passed") + by("failed") + by("skipped"),
    };
    await this.runs.update({ id: runId }, { totals });
    return totals;
  }

  async updateStatus(runId: string, status: RunStatus, at: Date, error?: string): Promise<void> {
    const finished = ["passed", "failed", "cancelled", "error"].includes(status);
    await this.runs.update({ id: runId }, { status, ...(finished ? { finishedAt: at } : {}), ...(error ? { error } : {}) });
  }
}

function toRun(row: RunEntity | null): Run | null {
  return row
    ? { ...row, status: row.status as RunStatus, plan: row.plan as RunPlan, totals: row.totals as RunTotals, triggeredByKind: row.triggeredByKind as Run["triggeredByKind"] }
    : null;
}
const toCase = (row: RunCaseEntity): RunCase => ({ ...row, status: row.status as CaseStatus });
