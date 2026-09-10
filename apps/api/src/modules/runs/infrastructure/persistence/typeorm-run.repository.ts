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
    return (await this.steps.find({ where: { runCaseId }, order: { index: "ASC" } })).map(toStep);
  }
  /** Joined on the case rather than filtered by a list of case ids: a 311-case run would put 311
   * parameters in an `IN`, which is a limit worth not discovering later. */
  async listStepsForRun(runId: string): Promise<RunStep[]> {
    return (
      await this.steps
        .createQueryBuilder("s")
        .innerJoin(RunCaseEntity, "c", "c.id = s.runCaseId")
        .where("c.runId = :runId", { runId })
        .orderBy("c.position", "ASC")
        .addOrderBy("s.index", "ASC")
        .getMany()
    ).map(toStep);
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

  /**
   * One UPDATE, driven by a subquery over the runs that are old enough.
   *
   * `prunedAt IS NULL` is what makes the sweep converge: without it every pass would rewrite
   * every old row it had already emptied, so a nightly sweep would keep doing yesterday's work
   * forever and the row count would say nothing about what changed.
   *
   * A run still going is never touched — `finishedAt` is null while it runs, and a comparison
   * against null is not true — so a sweep cannot empty the bodies of a case that is still being
   * looked at.
   */
  async pruneStepBodies(before: Date): Promise<number> {
    const result = await this.steps
      .createQueryBuilder()
      .update(RunStepEntity)
      // Written as SQL literals: TypeORM's typed `set` will not take `null` for a column it
      // declared as `unknown`, and the three columns are exactly the ones being emptied.
      .set({ request: () => "NULL", expected: () => "NULL", actual: () => "NULL", prunedAt: () => "now()" })
      .where(
        `"prunedAt" IS NULL AND "runCaseId" IN (
           SELECT c."id" FROM "run_cases" c
           JOIN "runs" r ON r."id" = c."runId"
           WHERE r."finishedAt" IS NOT NULL AND r."finishedAt" < :before
         )`,
        { before },
      )
      .execute();
    return result.affected ?? 0;
  }

  /** Cases and steps go with the run, by the cascade the runs migration declared. Deleting a run
   * and leaving its steps behind would be rows nothing can reach to read or remove. */
  async deleteRunsBefore(before: Date): Promise<number> {
    const result = await this.runs
      .createQueryBuilder()
      .delete()
      .from(RunEntity)
      .where(`"finishedAt" IS NOT NULL AND "finishedAt" < :before`, { before })
      .execute();
    return result.affected ?? 0;
  }
}

function toRun(row: RunEntity | null): Run | null {
  return row
    ? { ...row, status: row.status as RunStatus, plan: row.plan as RunPlan, totals: row.totals as RunTotals, triggeredByKind: row.triggeredByKind as Run["triggeredByKind"] }
    : null;
}
const toCase = (row: RunCaseEntity): RunCase => ({ ...row, status: row.status as CaseStatus });

/**
 * The jsonb boundary, and the only place these columns are asserted into a shape.
 *
 * Postgres hands back `unknown` and something has to say what it is. Doing it here, once, is what
 * lets every layer above be typed — the domain used to carry `unknown` all the way to the API's
 * response, where it was assignable to whatever the browser claimed and no compiler was in a
 * position to disagree.
 */
function toStep(row: RunStepEntity): RunStep {
  return {
    ...row,
    request: (row.request ?? null) as RunStep["request"],
    expected: (row.expected ?? null) as RunStep["expected"],
    actual: (row.actual ?? null) as RunStep["actual"],
    assertions: (row.assertions ?? []) as RunStep["assertions"],
    latency: (row.latency ?? null) as RunStep["latency"],
  };
}
